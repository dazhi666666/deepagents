"""Keyless installation tests use fresh temporary homes and never load credentials."""
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent
HARNESS = HERE.parents[3] / 'science-harness'


class ProtocolInstallTest(unittest.TestCase):
    def install(self, root, *extra):
        return subprocess.run([sys.executable, '-I', str(HERE / 'install.py'), '--home', str(root / 'home'),
                               '--directory', str(root / 'run'), '--mode', 'environment',
                               '--benchmark-version', 'v0.6', '--implementation', 'protocol_only', '--harness', str(HARNESS), *extra],
                              capture_output=True, text=True, encoding='utf8')

    def test_generates_explicit_unranked_environment_profile_without_a_model_provider(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            result = self.install(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            profile = root / 'home/profiles/mars-environment'
            rows = json.loads((profile / 'cordis.patch.yml').read_text(encoding='utf8'))[0]['insert']
            config = next(row['config'] for row in rows if row['id'] == 'mars-foundation')
            self.assertEqual(config['benchmarkVersion'], 'v0.6')
            self.assertEqual(config['stageProfile'], {'baselineTick': 720, 'finalTick': 1800, 'horizon': 2400})
            self.assertFalse(any(row['id'] in ('llm-pi-ai', 'laboratory-scripted') for row in rows))
            self.assertEqual(json.loads((root / 'run.evaluator/truth.json').read_text(encoding='utf8'))['horizon'], 2400)
            history = json.loads((root / 'run/public/history/manifest.json').read_text(encoding='utf8'))
            self.assertEqual(history['seed'], 0)
            install = json.loads((root / 'run/mars-install.json').read_text(encoding='utf8'))
            self.assertIn('v06/contracts.ts', install['sourceHashes'])
            self.assertEqual(install['implementation'], 'protocol_only')
            self.assertFalse((root / 'run/final-score.json').exists())

    def test_rejects_model_mode_and_invalid_boundaries_before_writing(self):
        for arguments in [('--mode', 'multi-agent'), ('--baseline-tick', '1800'), ('--final-tick', '2400')]:
            with self.subTest(arguments=arguments), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                result = self.install(root, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root / 'run').exists())
                self.assertFalse((root / 'home').exists())

    def test_refuses_existing_run_contents_and_owned_bootstrap_profiles(self):
        for relative in ['run/keep.txt', 'home/profiles/laboratory-multi-scripted/keep.txt']:
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                existing = root / relative
                existing.parent.mkdir(parents=True)
                existing.write_text('keep', encoding='utf8')
                result = self.install(root)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(existing.read_text(encoding='utf8'), 'keep')
                self.assertFalse((root / 'run.evaluator').exists())


class ScientificInstallTest(unittest.TestCase):
    def install(self, root, mode='environment', *extra):
        return subprocess.run([sys.executable, '-I', str(HERE / 'install.py'), '--home', str(root / 'home'),
            '--directory', str(root / mode), '--mode', mode, '--benchmark-version', 'v0.6',
            '--harness', str(HARNESS), *extra], capture_output=True, text=True, encoding='utf8')

    def test_prepares_a_shared_scientific_instance_without_starting_an_agent_or_adapter(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            prices = root / 'prices.json'
            prices.write_text(json.dumps({'limitUsd': 3, 'prices': [{'provider': 'intern-greenhouse', 'model': 'keyless-profile-fixture',
                'inputPerMillion': 1, 'cacheReadPerMillion': 0.1, 'cacheWritePerMillion': 1, 'outputPerMillion': 2,
                'maxInputTokens': 1000000, 'maxOutputTokens': 32768, 'verified': True, 'singleAttempt': True}]}), encoding='utf8')
            first = self.install(root, 'single-agent', '--model', 'keyless-profile-fixture', '--price-table', str(prices))
            self.assertEqual(first.returncode, 0, first.stderr)
            shared = root / 'single-agent.evaluator/v06-instance.json'
            second = self.install(root, 'multi-agent', '--model', 'keyless-profile-fixture', '--price-table', str(prices), '--instance-file', str(shared))
            self.assertEqual(second.returncode, 0, second.stderr)
            records = []
            for mode in ['single-agent', 'multi-agent']:
                run = root / mode
                rows = json.loads((root / 'home/profiles' / ('mars-' + mode) / 'cordis.patch.yml').read_text())[0]['insert']
                config = next(row['config'] for row in rows if row['id'] == 'mars-foundation')
                self.assertEqual(config['implementation'], 'scientific_candidate')
                self.assertEqual(config['budget']['limitUsd'], 3)
                self.assertEqual(config['model']['model'], 'keyless-profile-fixture')
                provider = next(row['config'] for row in rows if row['id'] == 'llm-pi-ai')['providers']['intern-greenhouse']
                self.assertEqual(provider['models'][0]['contextWindow'], 1000000)
                self.assertEqual(provider['retryPolicy'], {'mode': 'normal', 'maxRetries': 0})
                self.assertFalse(any(row['id'] == 'llm-retry' for row in rows))
                self.assertTrue((run / 'public/science.json').is_file())
                self.assertFalse((run / 'run.json').exists())
                self.assertFalse((run / 'execution').exists())
                self.assertFalse(pathlib.Path(str(run) + '.budget.sqlite').exists())
                records.append(json.loads((run / 'mars-install.json').read_text()))
            self.assertEqual(records[0]['instanceHash'], records[1]['instanceHash'])
            self.assertEqual(records[0]['providerPolicyHash'], records[1]['providerPolicyHash'])

    def test_requires_prices_and_model_before_writing_any_agent_profile(self):
        for extra in [(), ('--model', 'fixture')]:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                result = self.install(root, 'multi-agent', *extra)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root / 'home').exists())
                self.assertFalse((root / 'multi-agent').exists())

    def test_installs_a_keyless_reference_profile_with_no_model_provider(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            result = self.install(root, 'environment', '--reference')
            self.assertEqual(result.returncode, 0, result.stderr)
            rows = json.loads((root / 'home/profiles/mars-environment/cordis.patch.yml').read_text())[0]['insert']
            entry = next(row for row in rows if row['id'] == 'mars-foundation')
            self.assertTrue(entry['name'].endswith('v06/reference-plugin.ts'))
            self.assertFalse(any(row['id'] in ('llm-pi-ai', 'laboratory-scripted') for row in rows))
            self.assertFalse((root / 'environment/final-score.json').exists())


if __name__ == '__main__':
    unittest.main()
