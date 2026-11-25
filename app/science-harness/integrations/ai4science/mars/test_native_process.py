"""Owned Windows process-tree tests launch only disposable Python fixture processes."""
import ctypes
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from ctypes import wintypes

spec = importlib.util.spec_from_file_location('mars_native_process', pathlib.Path(__file__).with_name('native-process.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


@unittest.skipUnless(os.name == 'nt', 'Windows Job Object behavior')
class OwnedWindowsTreeTest(unittest.TestCase):
    def test_closing_owned_job_stops_parent_and_grandchild_without_adopting_pids(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            worker = root / 'worker.py'
            worker.write_text("import json,subprocess,sys,time,os\nchild=subprocess.Popen([sys.executable,'-I','-c','import time; time.sleep(60)'])\nprint(json.dumps([os.getpid(),child.pid]),flush=True)\ntime.sleep(60)\n", encoding='utf8')
            child = native.spawn_windows([sys.executable, '-I', str(worker)], cwd=root, env=dict(os.environ), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.WaitForSingleObject.restype = wintypes.DWORD
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel.CloseHandle.restype = wintypes.BOOL
            handles = []
            try:
                owned = json.loads(child.stdout.readline())
                self.assertEqual(len(owned), 2)
                for pid in owned:
                    handle = kernel.OpenProcess(0x00100000, False, pid)
                    self.assertTrue(handle, ctypes.get_last_error())
                    handles.append(handle)
                    self.assertEqual(kernel.WaitForSingleObject(handle, 0), 258)
                native.stop_windows(child, grace_seconds=0.1)
                self.assertIsNotNone(child.poll())
                for handle in handles:
                    self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0)
                self.assertIsNone(child._mars_job.handle)
            finally:
                if child._mars_job.handle:
                    native.stop_windows(child, grace_seconds=0.1)
                for handle in handles:
                    kernel.CloseHandle(handle)
                child.stdout.close()
                child.stderr.close()

    def test_refuses_to_stop_an_unowned_process(self):
        with self.assertRaisesRegex(RuntimeError, 'owned Job Object'):
            native.stop_windows(object(), grace_seconds=0)


if __name__ == '__main__':
    unittest.main()
