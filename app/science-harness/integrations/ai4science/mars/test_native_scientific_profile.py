"""Real dsh scientific-profile smoke: tiny budgets forbid dispatch; the route is loopback only."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
HARNESS = HERE.parents[3] / 'science-harness'
spec = importlib.util.spec_from_file_location('mars_native_profile_supervisor', HERE / 'run.py')
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class NativeScientificProfileTest(unittest.TestCase):
    def test_both_installed_modes_finalize_with_zero_dispatched_model_requests(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            prices = root / 'prices.json'
            prices.write_text(json.dumps({'limitUsd': 0.000001, 'prices': [{'provider': 'intern-greenhouse', 'model': 'keyless-native-fixture',
                'inputPerMillion': 1, 'cacheReadPerMillion': 1, 'cacheWritePerMillion': 1, 'outputPerMillion': 1,
                'maxInputTokens': 1000000, 'maxOutputTokens': 32768, 'verified': True, 'singleAttempt': True}]}), encoding='utf8')
            for mode in ['single-agent', 'multi-agent']:
                with self.subTest(mode=mode):
                    run, home = root / mode, root / ('home-' + mode)
                    install = subprocess.run([sys.executable, '-I', str(HERE / 'install.py'), '--harness', str(HARNESS), '--home', str(home),
                        '--directory', str(run), '--mode', mode, '--benchmark-version', 'v0.6', '--model', 'keyless-native-fixture',
                        '--base-url', 'https://127.0.0.1:1', '--api-key-env', 'MARS_KEYLESS_UNUSED', '--price-table', str(prices),
                        '--baseline-tick', '8', '--final-tick', '16', '--horizon', '24', '--decision-ticks', '8'],
                        capture_output=True, text=True, encoding='utf8')
                    self.assertEqual(install.returncode, 0, install.stderr)
                    log_path = root / (mode + '.log')
                    with log_path.open('wb') as log:
                        child = supervisor.spawn_host(supervisor.native_command('mars-' + mode), cwd=HARNESS,
                            env={**os.environ, 'DSH_HOME': str(home), 'MARS_KEYLESS_UNUSED': 'keyless-fixture-only'}, stdout=log, stderr=log)
                        try:
                            deadline = time.monotonic() + 90
                            score = None
                            while time.monotonic() < deadline:
                                if (run / 'final-score.json').is_file():
                                    try:
                                        score = json.loads((run / 'final-score.json').read_text(encoding='utf8'))
                                        break
                                    except json.JSONDecodeError:
                                        pass
                                if child.poll() is not None:
                                    break
                                time.sleep(0.05)
                            self.assertIsNotNone(score, log_path.read_text(encoding='utf8', errors='replace')[-6000:])
                            self.assertEqual(score['completionStatus'], 'finalized')
                            self.assertEqual(score['stopReason'], 'budget_exhausted')
                            self.assertEqual(score['tick'], 24)
                            self.assertEqual(score['budget']['requests'], 0)
                            self.assertEqual(score['budget']['actualUsd'], 0)
                        finally:
                            supervisor.stop_process(child)


if __name__ == '__main__':
    unittest.main()
