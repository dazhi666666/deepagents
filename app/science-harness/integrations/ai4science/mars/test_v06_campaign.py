"""Campaign preparation only invokes installers; missing trials stay in the paired denominator."""
import importlib.util
import json
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mars_campaign', pathlib.Path(__file__).with_name('campaign.py'))
campaign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(campaign)


class CampaignTest(unittest.TestCase):
    def test_prepares_both_modes_with_one_shared_instance_without_executing_launch_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / 'spec.json'
            source.write_text(json.dumps({'version': 'v0.6-campaign-spec', 'id': 'local',
                'models': [{'id': 'model', 'model': 'fixture', 'baseURL': 'https://example.invalid/v1', 'priceTable': 'prices.json'}],
                'instances': [{'id': 'instance', 'condition': 'G0', 'seed': 1}]}))
            calls = []

            def install(command, **kwargs):
                calls.append(command)
                self.assertEqual(pathlib.Path(command[2]).name, 'install.py')
                directory = pathlib.Path(command[command.index('--directory') + 1])
                home = pathlib.Path(command[command.index('--home') + 1])
                mode = command[command.index('--mode') + 1]
                record = {'stage': 'benchmark-v0.6', 'mode': mode, 'sourceHash': 'fixture-source'}
                for path in [directory, home / 'profiles' / ('mars-' + mode)]:
                    path.mkdir(parents=True)
                    (path / 'mars-install.json').write_text(json.dumps(record))
                return types.SimpleNamespace(returncode=0, stdout='', stderr='')

            with patch.object(campaign.subprocess, 'run', side_effect=install):
                result = campaign.prepare(source, root / 'prepared', root / 'harness')
            self.assertEqual(result['modelCalls'], 0)
            self.assertEqual(len(calls), 2)
            self.assertNotIn('--instance-file', calls[0])
            self.assertIn('--instance-file', calls[1])
            analysis = campaign.analyze(root / 'prepared/campaign.json', root / 'analysis.json')
            self.assertEqual(analysis['attemptCount'], 2)
            self.assertEqual(analysis['outcomeCounts'], {'missing': 2})
            self.assertEqual(analysis['plannedPairCount'], 1)
            self.assertEqual(analysis['completeComparablePairCount'], 0)
            self.assertIsNone(analysis['meanDeltaRAmongCompletePairs'])

    def test_does_not_freeze_without_actual_pilot_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / 'campaign.json').write_text(json.dumps({'status': 'prepared_not_run', 'sourceHash': 'source'}))
            (root / 'pilot.json').write_text(json.dumps({'pairedComparisons': []}))
            with self.assertRaisesRegex(ValueError, 'pilot pair'):
                campaign.freeze(root / 'campaign.json', root / 'pilot.json', [], root / 'frozen.json')
            self.assertFalse((root / 'frozen.json').exists())


if __name__ == '__main__':
    unittest.main()
