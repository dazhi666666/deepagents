"""Launch an installed Mars benchmark profile on any platform (no checkpoint supervisor). Credentials stay in the env file.

A watchdog stops the run when it makes no progress: no model request, tool result, checkpoint or tick for
`--stall-minutes` while the final score has not been written. It runs in this process, so it also catches a
host whose event loop is stuck in a synchronous loop (which an in-process timer could not).
"""
import argparse
import json
import os
import pathlib
import signal
import subprocess
import sys
import time


def stop_tree(child):
    """Stop the host and everything it spawned."""
    if sys.platform == 'win32':
        subprocess.run(['taskkill', '/T', '/F', '/PID', str(child.pid)], capture_output=True)
    else:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=15)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    child.wait()


def progress_files(home, profile):
    """Files whose modification marks progress, and the final score that ends watching; None for non-Mars profiles."""
    marker = home / 'profiles' / profile / 'mars-install.json'
    if not marker.exists():
        return None
    directory = pathlib.Path(json.loads(marker.read_text(encoding='utf8'))['directory'])
    return [pathlib.Path(str(directory) + '.audit.jsonl'), directory / 'viewer-state.json'], directory / 'final-score.json', directory


def last_progress(files, started):
    return max([started, *[path.stat().st_mtime for path in files if path.exists()]])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=pathlib.Path, required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--credentials-file', type=pathlib.Path, required=True)
    parser.add_argument('--log', type=pathlib.Path, required=True)
    parser.add_argument('--harness', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[3].with_name('science-harness'))
    parser.add_argument('--no-proxy', action='store_true')
    parser.add_argument('--stall-minutes', type=float, default=10, help='Stop the run after this long without progress; 0 disables the watchdog')
    args = parser.parse_args()
    home = args.home.resolve()
    env = dict(os.environ, DSH_HOME=str(home))
    for line in args.credentials_file.read_text(encoding='utf8').splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            name, value = line.split('=', 1)
            env[name.strip()] = value.strip().strip('"')
    if args.no_proxy:
        for name in list(env):
            if name.upper() in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'):
                env.pop(name)
        env['NO_PROXY'] = env['no_proxy'] = '*'
    log = open(args.log, 'ab')
    child = subprocess.Popen(['pnpm', 'dsh', '--profile', args.profile], cwd=str(args.harness), env=env, stdout=log, stderr=log,
                             stdin=subprocess.DEVNULL, shell=sys.platform == 'win32', start_new_session=sys.platform != 'win32')
    print(child.pid, flush=True)
    watched = progress_files(home, args.profile) if args.stall_minutes > 0 else None
    if watched is None:
        sys.exit(child.wait())
    files, final, directory = watched
    started = time.time()
    while child.poll() is None:
        time.sleep(30)
        if final.exists():
            sys.exit(child.wait())
        idle = time.time() - last_progress(files, started)
        if idle < args.stall_minutes * 60:
            continue
        message = {'kind': 'watchdog-stall', 'data': {'idleSeconds': round(idle), 'at': int(time.time() * 1000), 'directory': str(directory)}}
        log.write(f'\nMars watchdog: no progress for {idle / 60:.1f} minutes; stopping the run\n'.encode())
        log.flush()
        with open(files[0], 'a', encoding='utf8') as audit:
            audit.write(json.dumps(message) + '\n')
        stop_tree(child)
        sys.exit(3)
    sys.exit(child.returncode)


if __name__ == '__main__':
    main()
