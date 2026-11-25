"""Physical interface outages keep supervision alive before launching a native host."""
import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mars_supervisor', pathlib.Path(__file__).with_name('run.py'))
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class InterfaceRecoveryTest(unittest.TestCase):
    def test_ignores_transport_errors_from_discarded_branches(self):
        identity = {'runId': 'run', 'branchId': 'current', 'epoch': 2}
        record = {'kind': 'model-finish', 'data': {**identity, 'reason': {'kind': 'error', 'failure': {'code': 'TRANSPORT'}}}}
        self.assertTrue(supervisor.current_network_failure(record, identity))
        for key, value in [('runId', 'another-run'), ('branchId', 'discarded'), ('epoch', 1)]:
            stale = {'kind': record['kind'], 'data': {**record['data'], key: value}}
            self.assertFalse(supervisor.current_network_failure(stale, identity))

    def test_selects_the_recorded_pre_decision_checkpoint_and_legacy_predecessor(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = pathlib.Path(temporary) / 'run'
            identity = {'runId': 'run', 'branchId': 'current', 'epoch': 2, 'checkpointId': 'baseline'}
            for checkpoint_id, branch, tick, serial in [('baseline', 'parent', 10, 1), ('before', 'current', 10, 2), ('after', 'current', 11, 3)]:
                directory = pathlib.Path(str(run) + '.checkpoints') / checkpoint_id
                directory.mkdir(parents=True)
                (directory / 'manifest.json').write_text(json.dumps({'id': checkpoint_id, 'tick': tick, 'serial': serial,
                    'cursor': serial, 'metadata': {'runId': 'run', 'branchId': branch}}))
            fault = {'data': {**identity, 'tick': 11, 'recoveryCheckpointId': 'before'}}
            self.assertEqual(supervisor.recovery_checkpoint(run, identity, fault)['id'], 'before')
            del fault['data']['recoveryCheckpointId']
            self.assertEqual(supervisor.recovery_checkpoint(run, identity, fault)['id'], 'before')
            identity['branchId'] = 'freshly-restored'
            self.assertEqual(supervisor.recovery_checkpoint(run, identity, fault)['id'], 'baseline')
            fault['data']['recoveryCheckpointId'] = 'after'
            with self.assertRaises(RuntimeError):
                supervisor.recovery_checkpoint(run, identity, fault)

    def test_adopts_only_the_group_owning_the_matching_live_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / 'viewer-connection.json').write_text(json.dumps({'origin': 'http://127.0.0.1:58100', 'token': 'test-only'}))
            (root / 'run.json').write_text(json.dumps({'runId': 'expected-run'}))
            for listener_group, reported_run, accepted in [(123, 'expected-run', True),
                                                            (456, 'expected-run', False),
                                                            (123, 'different-run', False)]:
                with self.subTest(listener_group=listener_group, reported_run=reported_run), \
                        patch.object(supervisor, 'WINDOWS', False), \
                        patch.object(supervisor.os, 'getpgid', side_effect=lambda pid: 123 if pid == 123 else listener_group, create=True), \
                        patch.object(supervisor.subprocess, 'check_output', side_effect=['node /bin/pnpm dsh --profile mars-environment', '999\n']), \
                        patch.object(supervisor.urllib.request, 'urlopen', return_value=io.StringIO(json.dumps({'runId': reported_run}))):
                    if accepted:
                        self.assertEqual(supervisor.ExistingHost(123, 'mars-environment', root).pid, 123)
                    else:
                        with self.assertRaises(ValueError):
                            supervisor.ExistingHost(123, 'mars-environment', root)

    def test_waits_for_physical_ipv4_and_preserves_native_launch_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            home, run = root / 'home', root / 'run'
            profile = home / 'profiles/mars-environment'
            profile.mkdir(parents=True)
            config = {'port': 58100, 'directTransport': {'interface': 'en0'}}
            (profile / 'mars-install.json').write_text(json.dumps({'directory': str(run), 'mode': 'environment'}))
            (profile / 'cordis.patch.yml').write_text(json.dumps([{'insert': [{'id': 'mars-foundation', 'config': config}]}]))
            handlers, launched = {}, []
            interfaces = [types.SimpleNamespace(returncode=0, stdout='en0: flags=UP\n'),
                          types.SimpleNamespace(returncode=0, stdout='en0: flags=UP\n inet 172.20.10.9\n')]
            child = types.SimpleNamespace(pid=123, poll=lambda: None)

            def pause(seconds):
                if seconds == 0.5:
                    handlers[supervisor.signal.SIGTERM](None, None)

            def launch(*args, **kwargs):
                launched.append(json.loads((profile / 'cordis.patch.yml').read_text())[0]['insert'][0]['config'])
                return child

            with patch.object(sys, 'argv',
                              ['run.py', '--home', str(home), '--profile', 'mars-environment', '--no-proxy']), \
                    patch.object(supervisor.signal, 'signal', side_effect=lambda kind, callback: handlers.update({kind: callback})), \
                    patch.object(supervisor, 'interface_ipv4', side_effect=interfaces), \
                    patch.object(supervisor, 'spawn_host', side_effect=launch), \
                    patch.object(supervisor.time, 'sleep', side_effect=pause), \
                    patch.object(supervisor, 'stop_process') as stop, contextlib.redirect_stdout(io.StringIO()):
                supervisor.main()
            records = [json.loads(line) for line in pathlib.Path(str(run) + '.audit.jsonl').read_text().splitlines()]
            self.assertEqual([record['kind'] for record in records], ['network-interface-unavailable', 'network-interface-restored'])
            self.assertEqual(len(launched), 1)
            self.assertEqual(launched[0]['port'], 58100)
            self.assertTrue(launched[0]['automaticCheckpoints'])
            self.assertTrue(launched[0]['supervised'])
            self.assertFalse(pathlib.Path(str(run) + '.owner.json').exists())
            stop.assert_called_once_with(child)


if __name__ == '__main__':
    unittest.main()
