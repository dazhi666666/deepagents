"""Prepare, analyze and freeze local v0.6 campaigns. Preparation never starts model profiles."""
import argparse
import datetime
import importlib.util
import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('mars_v06_collection', HERE / 'v06-collection.py')
collection = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collection)


def config_file(path):
    if any(part.lower() == 'secrets' for part in path.resolve().parts):
        raise ValueError('Campaign configuration must not be read from a credentials directory')
    value = collection.read_json(path)
    if value is None:
        raise ValueError('Expected a JSON configuration object')
    return value


def new_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')


def safe_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value):
        raise ValueError('Campaign, model and instance IDs need simple file-safe names')
    return value


def prepare(spec_path, output, harness):
    spec = config_file(spec_path)
    if spec.get('version') != 'v0.6-campaign-spec' or not spec.get('models') or not spec.get('instances'):
        raise ValueError('Expected a v0.6 campaign specification with models and instances')
    name = safe_name(spec['id'])
    models, instances = spec['models'], spec['instances']
    if len({safe_name(m['id']) for m in models}) != len(models) or len({safe_name(i['id']) for i in instances}) != len(instances):
        raise ValueError('Duplicate model or instance ID')
    stages = spec.get('stages', {'baselineTick': 720, 'finalTick': 1800, 'horizon': 2400})
    if not 0 < stages['baselineTick'] < stages['finalTick'] < stages['horizon']:
        raise ValueError('Invalid campaign stage boundaries')
    planned = []
    for instance in instances:
        if instance.get('condition') not in ['G0', 'G1', 'G2'] or type(instance.get('seed')) is not int or instance['seed'] < 1:
            raise ValueError('Instances need a positive seed and an explicit G0/G1/G2 condition')
        for model in models:
            for mode in ['single-agent', 'multi-agent']:
                attempt = f"{model['id']}-{instance['id']}-{mode}"
                planned.append({'id': attempt, 'modelKey': model['id'], 'pairId': instance['id'], 'mode': mode,
                                'directory': str(output.resolve() / 'runs' / attempt), 'model': model, 'instance': instance})
    output.mkdir(parents=True, exist_ok=False)
    manifest = {'version': 'v0.6-campaign', 'id': name, 'status': 'preparing', 'specHash': collection.digest(spec),
                'preparedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'spec': spec,
                'attempts': [{k: v for k, v in a.items() if k not in ['model', 'instance']} for a in planned],
                'callsExternalModelsDuringPreparation': False, 'formalRankingEligible': False}
    campaign = output / 'campaign.json'
    new_json(campaign, manifest)
    shared = {}
    source_hash = None
    for item in planned:
        model, instance, mode = item['model'], item['instance'], item['mode']
        home = output / 'homes' / model['id'] / instance['id']
        settings = {**spec.get('scienceProfile', {}), 'condition': instance['condition']}
        science_file = output / 'inputs' / f"{instance['id']}.science.json"
        if not science_file.exists():
            new_json(science_file, settings)
        command = [sys.executable, '-I', str(HERE / 'install.py'), '--harness', str(harness), '--home', str(home),
                   '--directory', item['directory'], '--mode', mode, '--benchmark-version', 'v0.6', '--science-profile', str(science_file),
                   '--seed', str(instance['seed']), '--load', instance.get('load', 'L2'), '--model', model['model'],
                   '--context-window', str(model.get('contextWindow', 1000000)), '--max-output-tokens', str(model.get('maxOutputTokens', 32768)),
                   '--base-url', model['baseURL'], '--provider-api', model.get('api', 'openai-completions'),
                   '--api-key-env', model.get('apiKeyEnv', 'MODEL_API_KEY'), '--price-table', str((spec_path.parent / model['priceTable']).resolve()),
                   '--decision-ticks', str(spec.get('decisionTicks', 12)), '--baseline-tick', str(stages['baselineTick']),
                   '--final-tick', str(stages['finalTick']), '--horizon', str(stages['horizon'])]
        if model.get('providerProfile'):
            command += ['--provider-profile', str((spec_path.parent / model['providerProfile']).resolve())]
        if 'budgetUsd' in model:
            command += ['--budget-usd', str(model['budgetUsd'])]
        if instance['id'] in shared:
            command += ['--instance-file', shared[instance['id']]]
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf8')
        if result.returncode:
            new_json(output / 'preparation-failure.json', {'attemptId': item['id'], 'returncode': result.returncode,
                'stdout': result.stdout, 'stderr': result.stderr, 'modelCalls': 0})
            raise RuntimeError('Campaign preparation failed; existing attempt directories are retained')
        directory = pathlib.Path(item['directory'])
        installed = config_file(directory / 'mars-install.json')
        source_hash = source_hash or installed['sourceHash']
        if installed['sourceHash'] != source_hash:
            raise RuntimeError('Executable sources changed during campaign preparation')
        shared.setdefault(instance['id'], str(directory) + '.evaluator/v06-instance.json')
        installed.update({key: item[key] for key in ['id', 'pairId', 'modelKey']})
        for destination in [directory / 'mars-install.json', home / 'profiles' / ('mars-' + mode) / 'mars-install.json']:
            destination.write_text(json.dumps(installed, indent=2) + '\n', encoding='utf8')
        item['launch'] = [sys.executable, '-I', str(HERE / 'run.py'), '--harness', str(harness), '--home', str(home), '--profile', 'mars-' + mode]
    manifest.update(status='prepared_not_run', sourceHash=source_hash,
        launches=[{'attemptId': item['id'], 'command': item['launch']} for item in planned])
    campaign.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
    return {'campaign': str(campaign), 'attempts': len(planned), 'modelCalls': 0, 'status': manifest['status']}


def analyze(campaign_path, output):
    attempts = collection.campaign_attempts(campaign_path)
    records = [collection.collect_scientific(pathlib.Path(a['directory']), a) for a in attempts]
    pairs = collection.compare_pairs(records)
    complete = [p for p in pairs if p['eligible']]
    result = {'version': 'v0.6-campaign-analysis', 'campaignHash': collection.digest(config_file(campaign_path)),
        'attemptCount': len(attempts), 'outcomeCounts': {s: sum(r['status'] == s for r in records) for s in sorted({r['status'] for r in records})},
        'plannedPairCount': len(pairs), 'completeComparablePairCount': len(complete),
        'meanDeltaRAmongCompletePairs': sum(p['deltaR'] for p in complete) / len(complete) if complete else None,
        'attempts': records, 'pairs': pairs, 'formalRankingEligible': False}
    new_json(output, result)
    return result


def freeze(campaign_path, pilot_index, feasibility_files, output):
    """Create an immutable local specification only after actual pilots and all core reference conditions."""
    campaign, pilot = config_file(campaign_path), config_file(pilot_index)
    if campaign.get('status') != 'prepared_not_run' or not campaign.get('sourceHash'):
        raise ValueError('Only a fully prepared campaign can be frozen')
    comparable = [p for p in pilot.get('pairedComparisons', pilot.get('pairs', [])) if p.get('eligible')]
    if not comparable:
        raise ValueError('A real cost-verified Single/Multi pilot pair is required before freezing')
    pilot_records = pilot.get('candidateRuns', pilot.get('attempts', []))
    proven_attempts = {r.get('attemptId') for r in pilot_records if r.get('status') == 'candidate_completed' and r.get('modelSource') == 'real-model'
                       and r.get('costComparisonValid') is True and r.get('manifest', {}).get('sourceHash') == campaign['sourceHash']}
    if not any(len(p.get('attempts', [])) == 2 and set(p['attempts']) <= proven_attempts for p in comparable):
        raise ValueError('Pilot comparisons need both retained model attempts under the frozen executable source')
    seen = set()
    references = []
    for path in feasibility_files:
        report = config_file(path)
        case = report.get('referenceCase', {})
        if report.get('sourceHash') != campaign['sourceHash']:
            raise ValueError('Calibration and campaign must use the same executable source identity')
        if report.get('version') != 'v0.6-reference' or not report.get('policyCompleted') or report.get('jointFeasibility') is not True or report.get('modelCalls') != 0:
            raise ValueError('Every calibration input must be a completed joint keyless reference')
        condition, seed = case.get('condition'), case.get('seed', 0)
        seen.add((condition, seed % 2 if condition == 'G1' else None))
        references.append({'case': case, 'sha256': collection.digest(report)})
    if not {('G0', None), ('G1', 0), ('G1', 1), ('G2', None)} <= seen:
        raise ValueError('G0, both G1 subfamilies and G2 need joint feasibility evidence')
    body = {'version': 'v0.6-frozen-specification', 'campaignHash': collection.digest(campaign), 'sourceHash': campaign['sourceHash'],
        'spec': campaign['spec'], 'attempts': campaign['attempts'], 'pilotEvidenceHash': collection.digest(pilot), 'calibrationEvidence': references,
        'status': 'specification_frozen', 'formalRankingEligible': False,
        'note': 'This artifact freezes inputs. It does not retroactively promote candidate scores or run paid trials.'}
    new_json(output, {**body, 'hash': collection.digest(body)})
    return {'output': str(output), 'hash': collection.digest(body), 'status': body['status']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare_parser = commands.add_parser('prepare')
    prepare_parser.add_argument('--spec', type=pathlib.Path, required=True)
    prepare_parser.add_argument('--output', type=pathlib.Path, required=True)
    prepare_parser.add_argument('--harness', type=pathlib.Path, required=True)
    analyze_parser = commands.add_parser('analyze')
    analyze_parser.add_argument('--campaign', type=pathlib.Path, required=True)
    analyze_parser.add_argument('--output', type=pathlib.Path, required=True)
    freeze_parser = commands.add_parser('freeze')
    freeze_parser.add_argument('--campaign', type=pathlib.Path, required=True)
    freeze_parser.add_argument('--pilot-index', type=pathlib.Path, required=True)
    freeze_parser.add_argument('--feasibility-report', type=pathlib.Path, action='append', required=True)
    freeze_parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            result = prepare(args.spec.resolve(), args.output.resolve(), args.harness.resolve())
        elif args.command == 'analyze':
            analysis = analyze(args.campaign.resolve(), args.output.resolve())
            result = {key: value for key, value in analysis.items() if key not in ['attempts', 'pairs']}
        else:
            result = freeze(args.campaign.resolve(), args.pilot_index.resolve(), args.feasibility_report, args.output.resolve())
    except (ValueError, OSError, RuntimeError) as error:
        parser.exit(1, str(error) + '\n')
    print(json.dumps(result, allow_nan=False))


if __name__ == '__main__':
    main()
