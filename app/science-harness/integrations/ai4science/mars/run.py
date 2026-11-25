"""Supervise standard dsh profiles, restoring verified checkpoints for transport failures."""
import argparse
import importlib.util
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import time
import urllib.parse
import urllib.request
import uuid


WINDOWS = os.name == 'nt'
_native_spec = importlib.util.spec_from_file_location('mars_native_process', pathlib.Path(__file__).with_name('native-process.py'))
_native_process = importlib.util.module_from_spec(_native_spec)
_native_spec.loader.exec_module(_native_process)


def acquire_owner_lock(path):
    """One supervisor owns the stopped-run transition; failed acquisition never leaks its descriptor."""
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        if os.name == 'nt':
            import msvcrt
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b'0')
                os.fsync(descriptor)
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def native_command(profile):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', profile):
        raise ValueError('Expected a native profile name')
    command = ['pnpm', 'dsh', '--profile', profile]
    # Profile names are validated before entering the Windows command launcher.
    return ['cmd.exe', '/d', '/s', '/c', *command] if WINDOWS else command


def spawn_host(command, *, cwd, env, stdout, stderr):
    if WINDOWS:
        return _native_process.spawn_windows(command, cwd=cwd, env=env, stdout=stdout, stderr=stderr)
    return subprocess.Popen(command, cwd=cwd, env=env, stdout=stdout, stderr=stderr, start_new_session=True)


def interface_ipv4(interface, env):
    if WINDOWS:
        script = "Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $env:MARS_NETWORK_INTERFACE -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.AddressState -eq 'Preferred' } | ForEach-Object { 'inet ' + $_.IPAddress }"
        from base64 import b64encode
        encoded = b64encode(script.encode('utf-16-le')).decode('ascii')
        return subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                              capture_output=True, text=True, env={**env, 'MARS_NETWORK_INTERFACE': interface})
    return subprocess.run(['/sbin/ifconfig', interface], capture_output=True, text=True)


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def audit(path, kind, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(json.dumps({'kind': kind, 'data': data}) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def network_failure(record):
    if record.get('kind') != 'model-finish':
        return False
    reason = record.get('data', {}).get('reason', {})
    failure = reason.get('failure', {})
    status = failure.get('status')
    return reason.get('kind') == 'error' and (failure.get('code') in ['TRANSPORT', 'NETWORK', 'SERVER', 'TIMEOUT'] or isinstance(status, int) and status >= 500)


def current_network_failure(record, identity):
    data = record.get('data', {})
    return network_failure(record) and all(data.get(key) == identity[key] for key in ['runId', 'branchId', 'epoch'])


def recovery_checkpoint(directory, identity, fault):
    manifests = [json.loads(path.read_text()) for path in pathlib.Path(str(directory) + '.checkpoints').glob('*/manifest.json')]
    manifests = [manifest for manifest in manifests if manifest['metadata'].get('runId') == identity['runId']]
    checkpoint_id = fault['data'].get('recoveryCheckpointId')
    if checkpoint_id:
        matching = [manifest for manifest in manifests if manifest['id'] == checkpoint_id and
                    (manifest['metadata'].get('branchId') == identity['branchId'] or checkpoint_id == identity.get('checkpointId')) and
                    manifest['tick'] <= fault['data']['tick']]
        if not matching:
            raise RuntimeError('The failed request recovery checkpoint is unavailable')
        return matching[0]
    # Legacy requests saved after charging their decision tick. Restore an earlier position.
    candidates = [manifest for manifest in manifests if manifest['metadata'].get('branchId') == identity['branchId'] and
                  manifest['tick'] < fault['data']['tick']]
    if not candidates:
        candidates = [manifest for manifest in manifests if manifest['id'] == identity.get('checkpointId') and
                      manifest['tick'] <= fault['data']['tick']]
    if not candidates:
        raise RuntimeError('Transport failure occurred without a usable recovery checkpoint')
    return max(candidates, key=lambda item: (item.get('serial', 0), item['tick'], item['cursor']))


class ExistingHost:
    """An explicitly verified native process group whose parent supervisor exited."""

    def __init__(self, pid, profile, directory):
        if WINDOWS:
            raise ValueError('External process-group adoption is POSIX-only; Windows hosts use an owned Job Object')
        if pid <= 1 or os.getpgid(pid) != pid:
            raise ValueError('Adoption requires the native host process-group leader')
        command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True).strip()
        native_profile = r'(?:pnpm dsh|apps/cli/src/bin\.ts) --profile ' + re.escape(profile) + r'$'
        if not re.search(native_profile, command):
            raise ValueError('Process does not match the requested native profile')
        connection = json.loads((directory / 'viewer-connection.json').read_text())
        identity = json.loads((directory / 'run.json').read_text())
        port = urllib.parse.urlsplit(connection['origin']).port
        listeners = subprocess.check_output(['lsof', '-nP', '-t', '-iTCP:' + str(port), '-sTCP:LISTEN'], text=True).split()
        if not listeners or any(os.getpgid(int(listener)) != pid for listener in listeners):
            raise ValueError('Native process group does not own the run Viewer port')
        request = urllib.request.Request(connection['origin'] + '/viewer/api/v1/runs/' + identity['runId'] + '/snapshot',
                                         headers={'Authorization': 'Bearer ' + connection['token']})
        with urllib.request.urlopen(request, timeout=15) as response:
            snapshot = json.load(response)
        if snapshot['runId'] != identity['runId']:
            raise ValueError('Live run does not match the requested directory')
        self.pid = pid

    def poll(self):
        try:
            os.killpg(self.pid, 0)
        except ProcessLookupError:
            return 0
        return None

    def wait(self, timeout=None):
        started = time.monotonic()
        while self.poll() is None:
            if timeout is not None and time.monotonic() - started >= timeout:
                raise subprocess.TimeoutExpired('adopted native host', timeout)
            time.sleep(0.1)
        return 0


def stop_process(child):
    if child is None:
        return
    if WINDOWS:
        return _native_process.stop_windows(child)
    try:
        os.killpg(child.pid, signal.SIGINT)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    # A wrapper may exit before a descendant which still owns device or Session files.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=pathlib.Path, required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--credentials-file', type=pathlib.Path)
    parser.add_argument('--no-proxy', action='store_true')
    parser.add_argument('--adopt-process-group', type=int, help='Attach supervision to a verified existing native host')
    parser.add_argument('--harness', type=pathlib.Path, help='Harness repository root; defaults to the science-harness sibling of the kit')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.profile):
        parser.error('Expected a native profile name')
    if WINDOWS and args.adopt_process_group is not None:
        parser.error('External process-group adoption is POSIX-only; Windows hosts use an owned Job Object')
    home = args.home.resolve()
    profile = home / 'profiles' / args.profile
    marker = json.loads((profile / 'mars-install.json').read_text())
    directory = pathlib.Path(marker['directory'])
    patch_path = profile / 'cordis.patch.yml'
    patch = json.loads(patch_path.read_text())
    config = next(row['config'] for row in patch[0]['insert'] if row['id'] == 'mars-foundation')
    if config['port'] == 0:
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            config['port'] = listener.getsockname()[1]
    config['supervised'] = True
    config['automaticCheckpoints'] = True
    env = dict(os.environ)
    env['DSH_HOME'] = str(home)
    if args.credentials_file:
        for line in args.credentials_file.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            name, separator, value = line.partition('=')
            if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
                parser.error('Credentials must use plain NAME=value lines')
            env[name] = value
    if args.no_proxy:
        for name in list(env):
            if name.upper() in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']:
                env.pop(name, None)
        env['NO_PROXY'] = '*'
        env['no_proxy'] = '*'
    # The kit lives outside the harness repository; the harness that runs the
    # profiles is its sibling by default and overridable.
    repo = args.harness.resolve() if args.harness else pathlib.Path(__file__).resolve().parents[3].with_name('science-harness')
    if not (repo / 'package.json').is_file():
        raise SystemExit(f'Harness repository not found at {repo}; pass --harness')
    audit_path = pathlib.Path(str(directory) + '.audit.jsonl')
    request_path = pathlib.Path(str(directory) + '.recovery-request.json')
    owner_path = pathlib.Path(str(directory) + '.owner.json')
    state_path = pathlib.Path(str(directory) + '.owner-state.json')
    owner_lock = acquire_owner_lock(str(directory) + '.owner.lock')
    state = json.loads(state_path.read_text()) if state_path.exists() else {'auditOffset': 0}
    # Existing audit records precede this owner's start and have already been observed.
    if not state_path.exists() and audit_path.exists():
        state['auditOffset'] = audit_path.stat().st_size
    stopping = False

    def on_signal(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    child = None
    log_fd = os.open(str(directory) + '.host.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    if hasattr(os, 'fchmod'):
        os.fchmod(log_fd, 0o600)
    log = os.fdopen(log_fd, 'ab', buffering=0)

    def launch():
        direct = config.get('directTransport')
        waiting = False
        while direct and not stopping:
            interface = interface_ipv4(direct['interface'], env)
            if interface.returncode == 0 and re.search(r'\binet (?!127\.)[0-9.]+', interface.stdout):
                if waiting:
                    audit(audit_path, 'network-interface-restored', {'interface': direct['interface']})
                break
            if not waiting:
                audit(audit_path, 'network-interface-unavailable', {'interface': direct['interface']})
                print(json.dumps({'status': 'waiting-for-network', 'interface': direct['interface']}), flush=True)
                waiting = True
            time.sleep(1)
        if stopping:
            return None
        atomic_json(patch_path, patch)
        return spawn_host(native_command(args.profile), cwd=repo, env=env, stdout=log, stderr=log)

    try:
        atomic_json(owner_path, {'pid': os.getpid(), 'profile': args.profile, 'port': config['port']})
        if args.adopt_process_group is not None:
            child = ExistingHost(args.adopt_process_group, args.profile, directory)
            audit(audit_path, 'supervisor-adopted', {'processGroup': child.pid, 'profile': args.profile})
        else:
            child = launch()
        print(json.dumps({'ownerPid': os.getpid(), 'port': config['port'], 'connectionFile': str(directory / 'viewer-connection.json')}), flush=True)
        while not stopping:
            fault = None
            identity_file = directory / 'run.json'
            identity = json.loads(identity_file.read_text()) if identity_file.exists() else None
            if audit_path.exists():
                previous_offset = state['auditOffset']
                with audit_path.open('rb') as stream:
                    stream.seek(state['auditOffset'])
                    while True:
                        line = stream.readline()
                        if not line or not line.endswith(b'\n'):
                            break
                        record = json.loads(line)
                        state['auditOffset'] = stream.tell()
                        if identity is not None and current_network_failure(record, identity):
                            fault = record
                if state['auditOffset'] != previous_offset:
                    atomic_json(state_path, state)
            if fault and not request_path.exists():
                checkpoint = recovery_checkpoint(directory, identity, fault)
                atomic_json(request_path, {'requestId': uuid.uuid4().hex, 'checkpointId': checkpoint['id'], 'reason': 'transport-failure', 'failure': fault['data']})
            if request_path.exists():
                request = json.loads(request_path.read_text())
                stop_process(child)
                child = None
                audit(audit_path, 'recovery-started', request)
                recovery_profile = 'mars-recover-' + marker['mode']
                result = subprocess.run(native_command(recovery_profile), cwd=repo, env=env, stdout=log, stderr=log)
                if result.returncode:
                    raise RuntimeError('Checkpoint restore failed; inspect the private host log')
                config['resume'] = True
                audit(audit_path, 'recovery-restored', request)
                request_path.unlink()
                child = launch()
            elif child is not None and child.poll() is not None:
                raise RuntimeError('Runtime exited; original evidence retained in its run directory')
            time.sleep(0.5)
    finally:
        stop_process(child)
        owner_path.unlink(missing_ok=True)
        log.close()
        os.close(owner_lock)


if __name__ == '__main__':
    main()
