"""Install an isolated Mars benchmark v0.4 run: hidden truth, archive, baselines and dsh profiles."""
import argparse
import importlib.util
import os
import hashlib
import json
import pathlib
import subprocess
import sys


_options_spec = importlib.util.spec_from_file_location('mars_install_options', pathlib.Path(__file__).with_name('install-options.py'))
_options = importlib.util.module_from_spec(_options_spec)
_options_spec.loader.exec_module(_options)


def write_profile(home, name, module, config):
    profile = home / 'profiles' / name
    profile.mkdir(mode=0o700)
    (profile / 'package.json').write_text(json.dumps({'name': 'dsh-' + name, 'private': True, 'type': 'module',
        'dependencies': {}, 'dsh': {'profile': {'bundles': [], 'patchReload': 'startup'}}}, indent=2) + '\n', encoding='utf8')
    (profile / 'cordis.patch.yml').write_text(json.dumps([{'insert': [{'id': name, 'name': module.as_posix(), 'config': config}]}], indent=2) + '\n', encoding='utf8')
    return profile


def prepare_science(here, harness, home, mode, directory, truth_file, stages, profile, instance_file):
    settings = {'directory': str(directory), 'truthFile': str(truth_file), 'stageProfile': stages, 'scienceProfile': profile,
                **({'instanceFile': str(instance_file.resolve())} if instance_file else {})}
    name = 'mars-prepare-' + mode
    write_profile(home, name, here / 'v06/prepare.ts', settings)
    command = ['pnpm', 'dsh', '--profile', name]
    if sys.platform == 'win32':
        command = ['cmd.exe', '/d', '/s', '/c', *command]
    result = subprocess.run(command, check=True, capture_output=True, text=True, cwd=harness, env={**os.environ, 'DSH_HOME': str(home)})
    output = pathlib.Path(str(directory) + '.evaluator/v06-preparation.json')
    if not output.is_file():
        raise RuntimeError('Scientific preparation did not run: ' + result.stdout[-4000:] + result.stderr[-4000:])
    return json.loads(output.read_text(encoding='utf8'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=pathlib.Path, required=True)
    parser.add_argument('--directory', type=pathlib.Path, required=True)
    parser.add_argument('--mode', choices=['environment', 'single-agent', 'multi-agent'], required=True)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--benchmark-version', choices=['v0.4', 'v0.5', 'v0.6'], default='v0.4')
    parser.add_argument('--baseline-tick', type=int, default=720, help='v0.6 baseline seal')
    parser.add_argument('--final-tick', type=int, default=1800, help='v0.6 final admission cutoff')
    parser.add_argument('--load', choices=['L1', 'L2', 'L3', 'L4'], default='L2')
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--decision-ticks', type=int, default=12, help='Logical ticks advanced per decision round')
    parser.add_argument('--checkpoint-interval', type=int, default=48, help='Logical ticks between consistency checkpoints')
    parser.add_argument('--mission-control-port', type=int, default=None, help='Serve science-harness Mission Control for this run')
    parser.add_argument('--mars-control-port', type=int, default=None, help="Serve this project's Mars panel for this run")
    parser.add_argument('--max-output-tokens', type=int, default=32768, help='Per-response generation limit')
    parser.add_argument('--model-deadline-ms', type=int, default=180000, help='Hard deadline per model request; a member whose request expires sits out that round')
    parser.add_argument('--skip-baselines', action='store_true', help='Do not simulate null and reference policies')
    parser.add_argument('--base-url', default='https://discovery-api.intern-ai.org.cn/v1')
    parser.add_argument('--api-key-env', default='INTERN_API_KEY')
    parser.add_argument('--extra-key-env', action='append', default=[])
    parser.add_argument('--direct-interface')
    parser.add_argument('--direct-address')
    parser.add_argument('--harness', type=pathlib.Path, help='Harness repository root; defaults to the science-harness sibling of the kit')
    _options.add_science_arguments(parser)
    args = parser.parse_args()
    try:
        implementation, scientific, science_profile, provider_profile, budget = _options.resolve_science_options(args, parser)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    stages = {'baselineTick': args.baseline_tick, 'finalTick': args.final_tick, 'horizon': args.horizon}
    here = pathlib.Path(__file__).resolve().parent
    base = here.parent / 'greenhouse'
    harness = (args.harness or here.parent.parent.parent.parent / 'science-harness').resolve()
    home, directory = args.home.resolve(), args.directory.resolve()
    evaluator = pathlib.Path(str(directory) + '.evaluator')
    if args.benchmark_version == 'v0.6':
        if directory.exists() and any(directory.iterdir()):
            parser.error('v0.6 installation requires a fresh empty run directory')
        for profile in [('laboratory-single' if args.mode == 'single-agent' else 'laboratory-multi') + ('-scripted' if args.mode == 'environment' else ''), 'mars-recover-' + args.mode, 'mars-evaluate-' + args.mode, 'mars-prepare-' + args.mode]:
            if (home / 'profiles' / profile).exists():
                parser.error('Installation would overwrite an existing profile; choose a fresh private home')
    source = 'scripted' if args.mode == 'environment' else 'real-model'
    native_mode = 'single-agent' if args.mode == 'single-agent' else 'multi-agent'
    profile_name = 'mars-' + args.mode
    target = home / 'profiles' / profile_name
    if target.exists() or (directory / 'run.json').exists() or evaluator.exists():
        parser.error('Profile, run or evaluator data already exists; choose a fresh directory')
    command = [sys.executable, str(base / 'install-multi.py'), '--home', str(home),
               '--directory', str(directory), '--environment', 'laboratory', '--mode', native_mode,
               '--source', source, '--seed', str(args.seed), '--port', str(args.port),
               '--base-url', args.base_url, '--api-key-env', args.api_key_env, '--harness', str(harness), '--max-output-tokens', str(args.max_output_tokens)]
    for name in args.extra_key_env:
        command += ['--extra-key-env', name]
    if args.direct_interface:
        command += ['--direct-interface', args.direct_interface]
    if args.direct_address:
        command += ['--direct-address', args.direct_address]
    subprocess.run(command, check=True, capture_output=True, text=True)
    evaluator.mkdir(mode=0o700)
    truth_file, answers_file, baselines_file = evaluator / 'truth.json', evaluator / 'archive-answers.json', evaluator / 'baselines.json'
    subprocess.run([sys.executable, str(here / 'truth.py'), '--seed', str(args.seed), '--load', args.load, '--output', str(truth_file), '--benchmark-version', args.benchmark_version], check=True, capture_output=True, text=True)
    prepared = prepare_science(here, harness, home, args.mode, directory, truth_file, stages, science_profile, args.instance_file) if scientific else None
    archive_truth = pathlib.Path(prepared['effectiveTruthFile']) if prepared else truth_file
    subprocess.run([sys.executable, str(here / 'make-data.py'), '--directory', str(directory / 'public/history'), '--truth', str(archive_truth),
                    '--answers', str(answers_file)], check=True, capture_output=True, text=True)
    if args.benchmark_version in ('v0.5', 'v0.6'):
        manifest_path = directory / 'public/history/manifest.json'
        public_history = json.loads(manifest_path.read_text(encoding='utf8'))
        public_history['seed'] = 0  # evaluator seed must not be recoverable from the public archive
        manifest_path.write_text(json.dumps(public_history, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    if not args.skip_baselines and args.benchmark_version == 'v0.4':
        tsx = harness / 'node_modules' / '.bin' / ('tsx.cmd' if sys.platform == 'win32' else 'tsx')
        # The three scripted policies are independent runs of the same world; simulate them side by side.
        runs = {}
        for policy in ['null', 'ref-serial', 'ref-team']:
            output = evaluator / f'baseline-{policy}.json'
            runs[policy] = (output, subprocess.Popen([str(tsx), str(here / 'simulate.ts'), str(truth_file), policy, str(answers_file), str(output), str(args.decision_ticks),
                                                      str(directory / 'public/history')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=str(harness)))
        scores = {}
        for policy, (output, process) in runs.items():
            _, error = process.communicate()
            if process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, process.args, stderr=error)
            scores[policy] = json.loads(output.read_text())['S']
        baselines_file.write_text(json.dumps({'null': scores['null'], 'ref': scores['ref-team'], 'refSerial': scores['ref-serial'], 'decisionTicks': args.decision_ticks,
                                              'note': 'v0.4 scripted reference at the run decision cadence: six fixed roles on the real laboratory stack and the archive, public observations only, one SOP step per role per window (serial: one per window by priority class), every answer checked one decision before it is submitted'}, indent=2) + '\n')
    old_name = ('laboratory-single' if native_mode == 'single-agent' else 'laboratory-multi') + ('-scripted' if source == 'scripted' else '')
    profile = home / 'profiles' / old_name
    patch_path = profile / 'cordis.patch.yml'
    patch = json.loads(patch_path.read_text())
    rows = patch[0]['insert']
    original = next(row['config'] for row in rows if row['id'] == 'laboratory-agents')
    rows[:] = [row for row in rows if row['id'] not in ['laboratory-scripted', 'laboratory-agents']]
    if scientific and source == 'real-model':
        rows[:] = _options.apply_model_profile(rows, args, provider_profile)
    for row in rows:
        if row['id'] == 'ai4science-science':
            row['config']['scienceResultProject'] = 'mars'
    config = {'benchmarkVersion': args.benchmark_version, 'directory': str(directory), 'mode': args.mode, 'seed': args.seed, 'port': args.port,
              **({'stageProfile': stages, 'implementation': implementation, 'modelSource': 'environment' if args.mode == 'environment' else 'real-model',
                  **({'scienceProfile': science_profile, 'instanceFile': prepared['instanceFile'], 'frozenSourceHash': prepared['sourceHash'], **({'budget': budget} if budget else {})} if scientific else {})} if args.benchmark_version == 'v0.6' else {}),
              'model': {'provider': 'intern-greenhouse', 'model': args.model or 'intern-s2', 'maxTokens': args.max_output_tokens}, 'modelRequestDeadlineMs': args.model_deadline_ms,
              'pollIntervalMs': 100, 'providerCallTimeoutMs': 10000, 'truthFile': str(truth_file), 'answersFile': str(answers_file),
              'decisionTicks': args.decision_ticks, 'checkpointIntervalTicks': args.checkpoint_interval, 'automaticCheckpoints': args.mode != 'environment',
              **({'baselinesFile': str(baselines_file)} if not args.skip_baselines and args.benchmark_version == 'v0.4' else {}),
              **({'missionControlPorts': {key: value for key, value in [('harness', args.mission_control_port), ('mars', args.mars_control_port)] if value is not None}}
                 if args.mission_control_port is not None or args.mars_control_port is not None else {}),
              **({'providerPool': original['providerPool']} if source == 'real-model' else {}),
              **({'directTransport': original['directTransport']} if 'directTransport' in original else {})}
    rows.append({'id': 'mars-foundation', 'name': (here / ('v06/reference-plugin.ts' if args.reference else 'runtime.ts')).as_posix(), 'config': config})
    bootstrap_record = directory / 'installation.json'
    if scientific and bootstrap_record.exists():
        installed = json.loads(bootstrap_record.read_text(encoding='utf8'))
        installed.update({'agentModelPolicy': config['model'], 'modelPolicy': [r['config'] for r in rows if r['id'] in ['llm-pi-ai', 'compaction-basic']], 'profile': profile_name})
        bootstrap_record.write_text(json.dumps(installed, indent=2) + '\n', encoding='utf8')
    patch_path.write_text(json.dumps(patch, indent=2) + '\n')
    package = json.loads((profile / 'package.json').read_text())
    package['name'] = 'dsh-profile-' + profile_name
    (profile / 'package.json').write_text(json.dumps(package, indent=2) + '\n')
    sources = {path.relative_to(here).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
               for path in [*here.glob('*.ts'), *here.glob('*.py'), *here.glob('*.mjs'), *here.glob('v05/**/*.ts'), *here.glob('v05/**/*.mjs'), *here.glob('v06/**/*.ts'), *here.glob('v06/**/*.mjs')] if not path.name.endswith('.spec.ts')}
    record = {'implementation': implementation if args.benchmark_version == 'v0.6' else 'research_candidate' if args.benchmark_version == 'v0.5' else 'legacy',
              'stage': 'benchmark-' + args.benchmark_version, 'scenarioId': json.loads((directory / 'public/history/manifest.json').read_text(encoding='utf8'))['sha256'], 'calibrationStatus': 'not_frozen' if args.benchmark_version in ('v0.5', 'v0.6') else 'legacy', 'profile': profile_name, 'mode': args.mode, 'load': args.load, 'seed': 0 if args.benchmark_version in ('v0.5', 'v0.6') else args.seed,
              'directory': str(directory), 'evaluator': str(evaluator), 'decisionTicks': args.decision_ticks,
              'missionControlPorts': {key: value for key, value in [('harness', args.mission_control_port), ('mars', args.mars_control_port)] if value is not None},
              'sourceHashes': sources, 'providerPolicyHash': _options.profile_hash(rows), 'modelContextWindow': args.context_window,
              **({'instanceHash': prepared['instanceHash'], 'sourceHash': prepared['sourceHash']} if prepared else {}), 'launch': ['pnpm', 'dsh', '--profile', profile_name]}
    (profile / 'mars-install.json').write_text(json.dumps(record, indent=2) + '\n')
    (directory / 'mars-install.json').write_text(json.dumps(record, indent=2) + '\n')
    profile.rename(target)
    recovery = home / 'profiles' / ('mars-recover-' + args.mode)
    recovery.mkdir(mode=0o700)
    (recovery / 'package.json').write_text(json.dumps({'name': 'dsh-mars-recovery-' + args.mode, 'private': True,
        'type': 'module', 'dependencies': {}, 'dsh': {'profile': {'bundles': [], 'patchReload': 'startup'}}}, indent=2) + '\n')
    (recovery / 'cordis.patch.yml').write_text(json.dumps([{'insert': [{'id': 'mars-recovery', 'name': (here / 'restore.ts').as_posix(),
        'config': {'directory': str(directory), 'requestFile': str(directory) + '.recovery-request.json'}}]}], indent=2) + '\n')
    report = home / 'profiles' / ('mars-evaluate-' + args.mode)
    report.mkdir(mode=0o700)
    (report / 'package.json').write_text(json.dumps({'name': 'dsh-mars-report-' + args.mode, 'private': True,
        'type': 'module', 'dependencies': {}, 'dsh': {'profile': {'bundles': [], 'patchReload': 'startup'}}}, indent=2) + '\n')
    (report / 'cordis.patch.yml').write_text(json.dumps([{'insert': [{'id': 'mars-report', 'name': (here / 'report.ts').as_posix(),
        'config': {'benchmarkVersion': args.benchmark_version, 'directory': str(directory), 'output': str(directory) + '.evaluation.json', 'truthFile': str(truth_file), 'answersFile': str(answers_file),
                   **({'baselinesFile': str(baselines_file)} if not args.skip_baselines and args.benchmark_version == 'v0.4' else {})}}]}], indent=2) + '\n')
    print(json.dumps({'profile': profile_name, 'directory': str(directory), 'evaluator': str(evaluator), 'load': args.load, 'stage': 'benchmark-' + args.benchmark_version, 'calibrationStatus': 'not_frozen' if args.benchmark_version in ('v0.5', 'v0.6') else 'legacy'}))


if __name__ == '__main__':
    main()
