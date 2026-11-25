"""Collection keeps failures and candidate results distinct, with paired identity checks."""
import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('mars_v06_collection', pathlib.Path(__file__).with_name('v06-collection.py'))
collection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collection)


class ScientificCollectionTest(unittest.TestCase):
    def write_run(self, directory, mode, score=70, **change):
        directory.mkdir()
        manifest = {'benchmarkVersion': 'v0.6', 'implementation': 'scientific_candidate', 'mode': mode,
            'sourceHash': 'source', 'nodeVersion': 'node', 'horizon': 2400, 'stageProfile': {'baselineTick': 720, 'finalTick': 1800, 'horizon': 2400},
            'decisionTicks': 12, 'protocolHash': 'protocol', 'scenarioHash': 'scenario', 'caseManifestHash': 'same-instance-cases',
            'priceHash': 'price', 'model': {'provider': 'fixture', 'model': 'fixture'}, 'scientificProfile': {'candidate': True}, **change}
        (directory / 'manifest.public.json').write_text(json.dumps(manifest))
        (directory / 'mars-install.json').write_text(json.dumps({'stage': 'benchmark-v0.6', 'mode': mode,
            'pairId': 'pair', 'modelKey': 'model', 'providerPolicyHash': 'same-policy'}))
        (directory / 'final-score.json').write_text(json.dumps({'completionStatus': 'finalized', 'formalRankingEligible': False,
            'tick': 2400, 'R': score, 'F': True, 'O': {}, 'q': {task: score / 100 for task in ['T1', 'T2', 'T3', 'T4', 'T5']}, 'protocolHash': manifest['protocolHash'], 'caseManifestHash': manifest['caseManifestHash'],
            'modelSource': 'real-model', 'costComparisonValid': True, 'budget': {'limitUsd': 3, 'actualUsd': 1, 'costStatus': 'verified'}}))
        return collection.collect_scientific(directory)

    def test_collects_completed_candidates_and_does_not_confuse_unfrozen_with_partial(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            single = self.write_run(root / 'single', 'single-agent', 70)
            multi = self.write_run(root / 'multi', 'multi-agent', 80)
            self.assertEqual(single['status'], 'candidate_completed')
            pair = collection.compare_pairs([single, multi])[0]
            self.assertEqual(pair['status'], 'candidate_paired')
            self.assertEqual(pair['deltaR'], 10)
            self.assertFalse(single['formalRankingEligible'])

    def test_retains_missing_and_infrastructure_invalid_attempts_without_zero_imputation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            expected = {'id': 'missing', 'mode': 'single-agent', 'pairId': 'pair', 'modelKey': 'model'}
            missing = collection.collect_scientific(root / 'missing', expected)
            self.assertEqual(missing['status'], 'missing')
            self.assertIsNone(missing['R'])
            bad = root / 'bad'
            bad.mkdir()
            (bad / 'mars-install.json').write_text(json.dumps({'stage': 'benchmark-v0.6'}))
            (bad / 'infrastructure-invalid-report.json').write_text(json.dumps({'completionStatus': 'infrastructure_invalid'}))
            self.assertEqual(collection.collect_scientific(bad)['status'], 'infrastructure_invalid')

    def test_refuses_changed_instance_duplicate_modes_or_uncertain_cost(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            single = self.write_run(root / 'single', 'single-agent')
            different = self.write_run(root / 'different', 'multi-agent', scenarioHash='different')
            self.assertEqual(collection.compare_pairs([single, different])[0]['status'], 'identity_mismatch')
            self.assertEqual(collection.compare_pairs([single, single, different])[0]['status'], 'missing_or_duplicate_mode')
            matching = self.write_run(root / 'matching', 'multi-agent')
            matching['costComparisonValid'] = False
            self.assertEqual(collection.compare_pairs([single, matching])[0]['status'], 'cost_unverified')


if __name__ == '__main__':
    unittest.main()
