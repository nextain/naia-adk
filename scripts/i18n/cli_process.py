"""Cross-platform, shell-free CLI execution with bounded process-tree cleanup."""
from __future__ import annotations

import os
import signal
import subprocess
from types import SimpleNamespace


class _WindowsJob:
    """Native Job Object that kills the complete adapter tree when closed."""
    def __init__(self, process: subprocess.Popen):
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
            )]

        class BASIC_LIMITS(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED_LIMITS(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC_LIMITS), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self._kernel32 = kernel32
        self._handle = kernel32.CreateJobObjectW(None, None)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = EXTENDED_LIMITS()
        limits.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(self._handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel32.AssignProcessToJobObject(self._handle, wintypes.HANDLE(process._handle)):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())

    def terminate(self):
        if self._handle:
            self._kernel32.TerminateJobObject(self._handle, 1)

    def close(self):
        if self._handle:
            self._kernel32.CloseHandle(self._handle)
            self._handle = None


def run_cli_process(cmd: list[str], stdin_text: str, timeout: int):
    """Run one CLI adapter and ensure a timeout cannot leave descendants alive."""
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    process = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creationflags,
        start_new_session=os.name != "nt",
    )
    job = None
    if os.name == "nt":
        try:
            job = _WindowsJob(process)
        except Exception:
            process.kill()
            process.wait(timeout=5)
            raise
    try:
        stdout, stderr = process.communicate(input=stdin_text, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        if os.name == "nt":
            job.terminate()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            stdout, stderr = "", ""
        if job:
            job.close()
        raise subprocess.TimeoutExpired(cmd, timeout, output=stdout or error.output, stderr=stderr or error.stderr) from error
    if job:
        job.close()
    return SimpleNamespace(returncode=process.returncode, stdout=stdout, stderr=stderr)
