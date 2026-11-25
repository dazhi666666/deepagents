"""Windows-owned native process trees; the launch gate prevents any pre-job descendant race."""
import ctypes
import json
import os
import pathlib
import signal
import subprocess
import sys
from ctypes import wintypes


class WindowsJob:
    """One kernel Job Object, held only by the owning supervisor process."""
    def __init__(self):
        if os.name != 'nt':
            raise RuntimeError('Windows Job Objects require Windows')
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel = kernel
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.SetInformationJobObject.restype = wintypes.BOOL
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel.GetProcessId.argtypes = [wintypes.HANDLE]
        kernel.GetProcessId.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL

        class BasicLimits(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong), ('flags', wintypes.DWORD),
                        ('minimum_working_set', ctypes.c_size_t), ('maximum_working_set', ctypes.c_size_t),
                        ('active_process_limit', wintypes.DWORD), ('affinity', ctypes.c_size_t),
                        ('priority_class', wintypes.DWORD), ('scheduling_class', wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ('read_operations', 'write_operations', 'other_operations',
                                                             'read_bytes', 'write_bytes', 'other_bytes')]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [('basic', BasicLimits), ('io', IoCounters), ('process_memory_limit', ctypes.c_size_t),
                        ('job_memory_limit', ctypes.c_size_t), ('peak_process_memory', ctypes.c_size_t), ('peak_job_memory', ctypes.c_size_t)]

        self.handle = kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.basic.flags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; breakaway is not enabled.
        if not kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(error)

    def assign(self, child):
        # Use the exact handle returned by our own Popen, never reopen an arbitrary PID.
        process = getattr(child, '_handle', None)
        if process is None or self.kernel.GetProcessId(int(process)) != child.pid:
            raise RuntimeError('The native launch gate has no exact owned Windows process handle')
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process)):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        handle, self.handle = self.handle, None
        if handle and not self.kernel.CloseHandle(handle):
            raise ctypes.WinError(ctypes.get_last_error())


def spawn_windows(command, *, cwd, env, stdout, stderr):
    """Start a trusted waiting helper, assign it to the job, then release its native launch."""
    job = WindowsJob()
    helper = None
    try:
        helper = subprocess.Popen([sys.executable, '-I', str(pathlib.Path(__file__).resolve()), '--launch-child'],
                                  stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, cwd=cwd, env=env,
                                  creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        job.assign(helper)
        helper._mars_job = job
        helper.stdin.write((json.dumps({'command': command, 'cwd': str(cwd)}) + '\n').encode('utf8'))
        helper.stdin.flush()
        helper.stdin.close()
        return helper
    except BaseException:
        try:
            job.close()
        finally:
            if helper is not None:
                helper.kill()
                helper.wait(timeout=15)
        raise


def stop_windows(child, grace_seconds=15):
    """Interrupt only this owned group, then close its job to drain all remaining descendants."""
    job = getattr(child, '_mars_job', None)
    if not isinstance(job, WindowsJob):
        raise RuntimeError('Refusing to stop a Windows process without its owned Job Object')
    try:
        if child.poll() is None:
            try:
                child.send_signal(signal.CTRL_BREAK_EVENT)
            except (OSError, ValueError):
                pass
            try:
                child.wait(timeout=grace_seconds)
            except subprocess.TimeoutExpired:
                pass
    finally:
        job.close()
        child.wait(timeout=15)


def launch_child():
    """No application process may be created before the supervisor's post-assignment message."""
    line = sys.stdin.buffer.readline()
    if not line:
        return 2
    request = json.loads(line.decode('utf8'))
    command = request['command']
    if not isinstance(command, list) or not command or any(not isinstance(arg, str) for arg in command):
        raise ValueError('Expected a native argument list')
    process = subprocess.Popen(command, cwd=request['cwd'], stdin=subprocess.DEVNULL)
    return process.wait()


if __name__ == '__main__':
    if sys.argv[1:] != ['--launch-child']:
        raise SystemExit('This module is a supervisor-owned launch helper')
    raise SystemExit(launch_child())
