"""Collect settled Mars runs into a static index for the comparison view.

Completed scores are listed in runs. With --include-partial, deliberately stopped
runs are listed separately in partialRuns and never receive a formal rank.
"""
import argparse
import datetime
import importlib.util
import json
import pathlib


_v06_spec = importlib.util.spec_from_file_location('mars_v06_collection', pathlib.Path(__file__).with_name('v06-collection.py'))
_v06 = importlib.util.module_from_spec(_v06_spec)
_v06_spec.loader.exec_module(_v06)


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None


def identity(directory):
    entry = read_json(directory / 'mars-install.json') or {}
    state = read_json(directory / 'viewer-state.json') or {}
    mission = state.get('mission') or {}
    return {
        'benchmarkVersion': (entry.get('stage') or '').removeprefix('benchmark-') or 'legacy',
        'scenarioId': entry.get('scenarioId') or (state.get('history') or {}).get('sha256'),
        'mode': entry.get('mode') or state.get('mode'),
        'load': entry.get('load') or mission.get('load'),
        'seed': entry.get('seed') if entry.get('seed') is not None else state.get('seed'),
        'directory': str(directory),
        'finalScore': str(directory / 'final-score.json'),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs', type=pathlib.Path, help='Directory containing one subdirectory per run')
    parser.add_argument('--campaign', type=pathlib.Path, help='Prepared campaign; retain all expected attempts including missing reports')
    parser.add_argument('--output', type=pathlib.Path, default=None, help='Index path; defaults to <runs>/index.json')
    parser.add_argument('--include-partial', action='store_true', help='Include flagged partial entries separately; never rank them')
    args = parser.parse_args()
    if not args.runs and not args.campaign:
        parser.error('Provide --runs or --campaign')
    runs = args.runs.resolve() if args.runs else args.campaign.resolve().parent
    output = args.output or runs / 'index.json'
    entries = []
    partial_entries = []
    scientific = []
    expected = {pathlib.Path(a['directory']).resolve(): a for a in _v06.campaign_attempts(args.campaign)} if args.campaign else {}
    directories = {path.resolve() for path in runs.iterdir() if path.is_dir()} if args.runs else set()
    directories.update(expected)
    for directory in sorted(directories):
        record = _v06.collect_scientific(directory, expected.get(directory))
        if record is not None:
            scientific.append(record)
            continue
        partial_path = next((directory / name for name in ('early-stop-report.json', 'early-stop.json') if (directory / name).is_file()), None)
        partial = read_json(partial_path) if partial_path else None
        if partial and partial.get('status') == 'partial':
            if args.include_partial:
                record = identity(directory)
                record.update({'benchmarkVersion': partial.get('version', 'v0.5'), 'status': 'partial',
                               'terminationReason': partial.get('terminationReason'), 'tick': partial.get('tick'),
                               'stopAtTick': partial.get('stopAtTick'), 'worldHorizon': partial.get('worldHorizon'),
                               'formalRankingEligible': False, 'S': None, 'normalized': None,
                               'partialReport': str(partial_path), 'usage': (partial.get('costs') or {}).get('usage')})
                record.pop('finalScore', None)
                partial_entries.append(record)
            continue
        score_path = directory / 'final-score.json'
        if not score_path.is_file():
            continue
        score = read_json(score_path)
        if score is None:
            continue
        if score.get('status') == 'partial' or score.get('formalRankingEligible') is False:
            if args.include_partial:
                record = identity(directory)
                record.update({'status': 'partial', 'formalRankingEligible': False, 'S': None, 'normalized': None,
                               'tick': score.get('tick'), 'terminationReason': score.get('terminationReason')})
                partial_entries.append(record)
            continue
        record = identity(directory)
        if score.get('version') == 'v0.5':
            record.update({'benchmarkVersion': 'v0.5', 'S': score.get('score'), 'score': score.get('score'), 'maximum': score.get('maximum'), 'components': score.get('components'), 'tasks': score.get('tasks'), 'calibrationStatus': score.get('calibrationStatus'), 'usage': score.get('usage'), 'tick': score.get('tick')})
        else:
            record.update({'S': score.get('S'), 'normalized': score.get('normalized'), 'tick': score.get('tick')})
        entries.append(record)
    output.parent.mkdir(parents=True, exist_ok=True)
    categories = {name: [r for r in scientific if r['status'] in statuses] for name, statuses in {
        'candidateRuns': ['candidate_completed'], 'invalidRuns': ['infrastructure_invalid', 'invalid_report'],
        'missingRuns': ['missing'], 'protocolRuns': ['protocol_only']}.items()}
    partial_entries.extend(r for r in scientific if r['status'] == 'early_stopped')
    paired = _v06.compare_pairs(scientific)
    output.write_text(json.dumps({'schemaVersion': 2, 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'runs': entries,
                                 'partialRuns': partial_entries, **categories, 'pairedComparisons': paired}, indent=2, allow_nan=False) + '\n')
    print(json.dumps({'output': str(output), 'runs': len(entries), 'partialRuns': len(partial_entries),
                      **{name: len(values) for name, values in categories.items()}, 'pairs': len(paired)}))


if __name__ == '__main__':
    main()
