"""Read-only classification and explicitly paired v0.6 scientific comparisons."""
import hashlib
import json
import math
import pathlib


def read_json(path):
    try:
        if any(part.lower() == 'secrets' for part in path.resolve().parts):
            raise ValueError('Collection must not read a credentials directory')
        value = json.loads(path.read_text(encoding='utf8'))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def collect_scientific(directory, expected=None):
    """Retain every expected attempt, including missing and infrastructure-invalid outcomes."""
    installation = read_json(directory / 'mars-install.json') or {}
    manifest = read_json(directory / 'manifest.public.json') or {}
    version = manifest.get('benchmarkVersion') or (installation.get('stage') or '').removeprefix('benchmark-')
    if version != 'v0.6' and expected is None:
        return None
    score = read_json(directory / 'final-score.json')
    invalid = read_json(directory / 'infrastructure-invalid-report.json')
    partial = read_json(directory / 'early-stop-report.json')
    protocol = read_json(directory / 'protocol-report.json')
    identity = {'benchmarkVersion': 'v0.6', 'directory': str(directory), 'mode': manifest.get('mode') or installation.get('mode') or (expected or {}).get('mode'),
                'pairId': (expected or {}).get('pairId') or installation.get('pairId'),
                'modelKey': (expected or {}).get('modelKey') or installation.get('modelKey'),
                'attemptId': (expected or {}).get('id') or directory.name,
                'manifest': manifest, 'providerPolicyHash': installation.get('providerPolicyHash'),
                'formalRankingEligible': False}
    if invalid or score and score.get('completionStatus') == 'infrastructure_invalid':
        return {**identity, 'status': 'infrastructure_invalid', 'R': None, 'O': None, 'F': None, 'report': invalid or score}
    corrupt = [name for name in ['manifest.public.json', 'final-score.json', 'infrastructure-invalid-report.json', 'early-stop-report.json']
               if (directory / name).is_file() and read_json(directory / name) is None]
    if corrupt:
        return {**identity, 'status': 'invalid_report', 'R': None, 'O': None, 'F': None, 'reason': 'Malformed JSON reports', 'files': corrupt}
    if score and score.get('completionStatus') == 'finalized':
        if type(score.get('R')) not in (float, int) or not math.isfinite(score['R']) or not 0 <= score['R'] <= 100 or not isinstance(score.get('F'), bool):
            return {**identity, 'status': 'invalid_report', 'R': None, 'O': None, 'F': None, 'reason': 'Invalid finalized scientific score'}
        qualities = score.get('q')
        if not isinstance(score.get('O'), dict) or not isinstance(qualities, dict) or set(qualities) != {'T1', 'T2', 'T3', 'T4', 'T5'} or any(
                type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1 for value in qualities.values()):
            return {**identity, 'status': 'invalid_report', 'R': None, 'O': None, 'F': None, 'reason': 'Missing operational results or scientific components'}
        if not math.isclose(score['R'], 20 * sum(qualities.values()), abs_tol=0.000001):
            return {**identity, 'status': 'invalid_report', 'R': None, 'O': None, 'F': None, 'reason': 'R differs from its fixed task components'}
        required = ('protocolHash', 'caseManifestHash')
        if any(not score.get(key) or score.get(key) != manifest.get(key) for key in required) or score.get('tick') != manifest.get('horizon'):
            return {**identity, 'status': 'invalid_report', 'R': None, 'O': None, 'F': None, 'reason': 'Score differs from public run identity'}
        return {**identity, 'status': 'candidate_completed', 'R': score['R'], 'O': score.get('O'), 'F': score['F'],
                'q': score.get('q'), 'budget': score.get('budget'), 'stopReason': score.get('stopReason'),
                'modelSource': score.get('modelSource'), 'costComparisonValid': score.get('costComparisonValid') is True and (score.get('budget') or {}).get('costStatus') == 'verified',
                'failureReasons': score.get('failureReasons'), 'finalScore': str(directory / 'final-score.json')}
    if partial or score and score.get('completionStatus') == 'early_stopped':
        return {**identity, 'status': 'early_stopped', 'R': None, 'O': None, 'F': None, 'report': partial or score}
    if protocol or installation.get('implementation') == 'protocol_only':
        return {**identity, 'status': 'protocol_only', 'R': None, 'O': None, 'F': None, 'report': protocol}
    return {**identity, 'status': 'missing', 'R': None, 'O': None, 'F': None,
            'reason': 'No settled scientific report; no score or cost is imputed'}


def compare_pairs(records):
    """Never choose the best duplicate, discard missing attempts, or compare unlike frozen instances."""
    grouped = {}
    for record in records:
        if record.get('pairId') and record.get('modelKey'):
            grouped.setdefault((record['modelKey'], record['pairId']), []).append(record)
    result = []
    fields = ['sourceHash', 'nodeVersion', 'horizon', 'stageProfile', 'decisionTicks', 'protocolHash',
              'scenarioHash', 'caseManifestHash', 'priceHash', 'model', 'scientificProfile']
    for (model, pair), members in sorted(grouped.items()):
        single = [r for r in members if r['mode'] == 'single-agent']
        multi = [r for r in members if r['mode'] == 'multi-agent']
        row = {'modelKey': model, 'pairId': pair, 'attempts': [r['attemptId'] for r in members], 'eligible': False, 'deltaR': None}
        if len(single) != 1 or len(multi) != 1:
            row.update(status='missing_or_duplicate_mode')
        else:
            a, b = single[0], multi[0]
            mismatch = [key for key in fields if a['manifest'].get(key) is None or a['manifest'].get(key) != b['manifest'].get(key)]
            for key in ['providerPolicyHash']:
                if not a.get(key) or a.get(key) != b.get(key):
                    mismatch.append(key)
            if a.get('status') != 'candidate_completed' or b.get('status') != 'candidate_completed':
                row.update(status='incomplete_pair', outcomes=[a['status'], b['status']])
            elif mismatch:
                row.update(status='identity_mismatch', mismatches=mismatch)
            elif a.get('modelSource') != 'real-model' or b.get('modelSource') != 'real-model':
                row.update(status='non_model_reference')
            elif not a.get('costComparisonValid') or not b.get('costComparisonValid'):
                row.update(status='cost_unverified')
            elif not a.get('budget') or not b.get('budget') or a['budget'].get('limitUsd') != b['budget'].get('limitUsd'):
                row.update(status='budget_mismatch')
            else:
                row.update(status='candidate_paired', eligible=True, deltaR=b['R'] - a['R'],
                           single={'R': a['R'], 'F': a['F'], 'actualUsd': a['budget'].get('actualUsd')},
                           multi={'R': b['R'], 'F': b['F'], 'actualUsd': b['budget'].get('actualUsd')})
        result.append(row)
    return result


def campaign_attempts(path):
    campaign = read_json(path)
    if not campaign or campaign.get('version') != 'v0.6-campaign' or not isinstance(campaign.get('attempts'), list):
        raise ValueError('Expected a prepared v0.6 campaign')
    attempts = campaign['attempts']
    if len({a['id'] for a in attempts}) != len(attempts) or len({str(pathlib.Path(a['directory']).resolve()) for a in attempts}) != len(attempts):
        raise ValueError('Campaign attempt IDs and directories must be unique')
    return attempts
