"""Generate the evaluator-only hidden truth for one Mars benchmark run (spec v0.2, sections 5 and 6)."""
import argparse
import json
import pathlib
import random

LOADS = ['L1', 'L2', 'L3', 'L4']
# L1/L2 end after their last event (E9 settles before tick 1880); L3/L4 keep E11 and E13, which start after 1920.
HORIZONS = {'L1': 1920, 'L2': 1920, 'L3': 2400, 'L4': 2400}
SOL_TICKS = 96
CHAMBERS = [f'incubator-{k}' for k in range(1, 5)]
CROPS = [f'crop-{k}-{v}' for k in range(1, 5) for v in range(1, 5)]
WATER_MODULES = ['reservoir', 'filter', 'pump']
HYPOTHESES = ['inlet', 'membrane', 'seal']
SEAL_POINTS = ['door', 'duct', 'panel']
WEAR_DEVICES = {'confirm': 100, 'imager': 45, 'centrifuge-1': 14, 'centrifuge-2': 14, 'heater-1': 30, 'heater-2': 30, 'robot-1': 220}
EVENTS_BY_LOAD = {
    'L1': ['E4', 'E10', 'E1', 'E2', 'E3', 'E6'],
    'L2': ['E4', 'E10', 'E1', 'E2', 'E5', 'E3', 'E6', 'E9'],
    'L3': ['E4', 'E10', 'E1', 'E2', 'E5', 'E7', 'E3', 'E6', 'E8', 'E9', 'E11'],
    'L4': ['E4', 'E10', 'E1', 'E2', 'E12', 'E5', 'E7', 'E3', 'E6', 'E8', 'E9', 'E11', 'E13'],
}
WINDOWS = {'E4': (200, 240), 'E10': (420, 460), 'E1': (640, 680), 'E12': (990, 1000), 'E5': (1080, 1120), 'E7': (1210, 1220),
           'E3': (1300, 1340), 'E6': (1520, 1560), 'E8': (1640, 1650), 'E9': (1740, 1780), 'E11': (1960, 2000), 'E13': (2120, 2160)}
ALL_TASKS = ['D1', 'D2', 'D3', 'W1', 'W2', 'W3', 'W4', 'G1', 'G2', 'G3', 'G4', 'F1', 'F2', 'F3', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'X1', 'X2', 'X3']
LOAD_SETTINGS = {
    'L1': {'deadlineFactor': 1.0, 'archiveScale': 0.25, 'dropout': 0.01, 'tasks': ['D1', 'D2', 'W1', 'W2', 'G1', 'G2', 'F1', 'X3']},
    'L2': {'deadlineFactor': 1.0, 'archiveScale': 1.0, 'dropout': 0.01, 'tasks': ALL_TASKS},
    'L3': {'deadlineFactor': 0.75, 'archiveScale': 4.0, 'dropout': 0.02, 'tasks': ALL_TASKS},
    'L4': {'deadlineFactor': 0.6, 'archiveScale': 10.0, 'dropout': 0.05, 'tasks': ALL_TASKS},
}


def generate(seed: int, load: str) -> dict:
    if seed < 1 or load not in LOADS:
        raise ValueError('Use a positive seed and a known load level')
    rng = random.Random(seed * 1009 + LOADS.index(load))
    u = rng.uniform
    onset = {event: rng.randint(*WINDOWS[event]) for event in EVENTS_BY_LOAD[load] if event in WINDOWS}
    storm_duration = rng.randint(150, 220)
    onset['E2'] = onset['E1'] + rng.randint(20, 100)

    def spaced_optima():
        while True:
            values = [round(u(45, 85), 2) for _ in range(4)]
            if all(abs(a - b) >= 8 for i, a in enumerate(values) for b in values[i + 1:]):
                return values

    optima = spaced_optima()
    ranges = {1: (16, 28), 2: (18, 26), 3: (19, 25), 4: (17, 27)}
    varieties = [{'variety': v, 'r0': round(u(0.8, 1.2), 4), 'lightOpt': optima[v - 1], 'lightWidth': round(u(25, 45), 2),
                  'irrigationOpt': round(u(45, 90), 2), 'a1': round(u(0.05, 0.20), 4), 'a3': round(u(0.15, 0.40), 4),
                  'a12': round(u(-0.10, 0.10), 4), 'tempOpt': round((ranges[v][0] + ranges[v][1]) / 2 + u(-1.5, 1.5), 2)} for v in range(1, 5)]
    k4 = u(0.0005, 0.0015)
    double = load in ['L3', 'L4'] and rng.random() < 0.3

    def contamination(event: str, exclude: list[str]):
        choices = [h for h in HYPOTHESES if h not in exclude]
        hypotheses = rng.sample(choices, 2 if double and event == 'E3' and len(choices) >= 2 else 1)
        decoy = rng.choice(WATER_MODULES)
        return {'event': event, 'onset': onset[event], 'hypotheses': sorted(hypotheses), 'deltaInlet': round(u(4, 8), 3),
                'membraneRemoval': round(u(0.2, 0.4), 4), 'deltaSeal': round(u(2, 4), 3), 'lubricantRatio': round(u(0.3, 0.6), 4),
                'decoyModule': decoy, 'decoyOffset': round(u(1.5, 3.0), 3), 'decoyOnset': onset[event] + rng.randint(-30, 30)}

    contaminations = [contamination('E3', [])]
    if 'E11' in onset:
        contaminations.append(contamination('E11', contaminations[0]['hypotheses']))
    drift_count = 2 if load in ['L3', 'L4'] else 1
    drift_chambers = rng.sample(CHAMBERS, drift_count)
    drifts = [{'chamber': chamber, 'channel': rng.choice(['temperature', 'moisture']), 'rate': round(rng.choice([-1, 1]) * u(0.02, 0.05), 4),
               'onset': onset['E4'] + index * rng.randint(0, 60)} for index, chamber in enumerate(drift_chambers)]
    index_cases = rng.sample(CROPS, 2 if load == 'L4' else 1)
    wear = {}
    for device, uses in WEAR_DEVICES.items():
        initial = round(u(0.2, 0.5), 4)
        wear[device] = {'initial': initial, 'perUse': round((1 - initial) / (uses * u(0.4, 1.0)), 6)}
    storms = [{'event': 'E1', 'onset': onset['E1'], 'duration': storm_duration, 'factor': round(u(0.15, 0.3), 4)}]
    if 'E13' in onset:
        storms.append({'event': 'E13', 'onset': onset['E13'], 'duration': rng.randint(100, 150), 'factor': round(u(0.15, 0.3), 4)})
    lot_numbers = rng.sample(range(7000, 9999), 5)
    truth = {
        'version': 2, 'seed': seed, 'load': load, 'horizon': HORIZONS[load], 'solTicks': SOL_TICKS, 'settings': LOAD_SETTINGS[load],
        'water': {'reservoir': round(u(3.0, 5.0), 4), 'removal': round(u(0.65, 0.85), 4), 'pumpIncrement': round(u(0, 0.3), 4),
                  'k4': round(k4, 7), 'kMinus10': round(k4 * u(0.1, 0.3), 8), 'k22': round(k4 * u(4, 8), 7)},
        'bias': {'confirmV1': round(u(1.08, 1.20), 4), 'extractionA2': round(u(0.80, 0.90), 4)},
        'lots': {'A1': f'EX-{lot_numbers[0]}', 'A2': f'EX-{lot_numbers[1]}', 'A3': f'EX-{lot_numbers[2]}', 'B': f'EX-{lot_numbers[3]}', 'medium': f'MD-{lot_numbers[4]}'},
        'crops': {'varieties': varieties, 'individual': {crop: round(u(0.9, 1.1), 4) for crop in CROPS}, 'co2Half': round(u(300, 600), 2)},
        'energy': {'dustRate': round(u(0.0002, 0.0005), 7), 'battery': round(u(550, 720), 1), 'peak': 45.0,
                   'cellFailure': {'onset': onset['E12'], 'fraction': 0.3} if 'E12' in onset else None},
        'storms': storms,
        'contamination': contaminations,
        'drift': drifts,
        'pathogen': {'onset': onset['E10'], 'index': index_cases, 'lambda': round(u(0.001, 0.003), 5)},
        'wear': wear,
        'leak': {'chamber': rng.choice(CHAMBERS), 'point': rng.choice(SEAL_POINTS), 'onset': onset['E9']} if 'E9' in onset else None,
        'faults': [value for value in [
            {'event': 'E2', 'deviceId': 'cold-1', 'tick': onset['E2']},
            {'event': 'E7', 'deviceId': 'robot-1', 'tick': onset['E7']} if 'E7' in onset else None,
            {'event': 'E8', 'deviceId': 'filter', 'tick': onset['E8']} if 'E8' in onset else None,
        ] if value],
        'recall': {'event': 'E5', 'tick': onset['E5'], 'lot': 'A2'} if 'E5' in onset else None,
        'methodUpdate': {'event': 'E6', 'tick': onset['E6']},
        'incidents': [{'id': event, 'onset': onset[event]} for event in EVENTS_BY_LOAD[load]],
    }
    return truth


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', type=int, required=True)
    parser.add_argument('--benchmark-version', choices=['v0.4', 'v0.5', 'v0.6'], default='v0.4')
    parser.add_argument('--load', choices=LOADS, default='L2')
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    truth = generate(args.seed, args.load)
    if args.benchmark_version in ('v0.5', 'v0.6'):
        truth['horizon'] = 2400
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(truth, indent=2) + '\n')
    print(json.dumps({'truth': str(args.output), 'incidents': truth['incidents']}))


if __name__ == '__main__':
    main()
