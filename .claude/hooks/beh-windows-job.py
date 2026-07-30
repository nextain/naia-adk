"""Windows-native Job Object host for BEH supervision.

The target is created suspended, assigned to a kill-on-close Job Object, and
only then resumed.  This closes the spawn-before-assignment race and preserves
descendant ownership even when the target root exits first.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import time


CREATE_SUSPENDED = 0x00000004
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
WAIT_OBJECT_0 = 0
STILL_ACTIVE = 259


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]


class BASIC_LIMITS(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class EXTENDED_LIMITS(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", BASIC_LIMITS),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class BASIC_ACCOUNTING(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", ctypes.c_longlong),
        ("TotalKernelTime", ctypes.c_longlong),
        ("ThisPeriodTotalUserTime", ctypes.c_longlong),
        ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
        ("TotalPageFaultCount", wintypes.DWORD),
        ("TotalProcesses", wintypes.DWORD),
        ("ActiveProcesses", wintypes.DWORD),
        ("TotalTerminatedProcesses", wintypes.DWORD),
    ]


class STARTUPINFO(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
        ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD),
    ]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.CreateJobObjectW.restype = wintypes.HANDLE
kernel32.CreateProcessW.argtypes = [
    wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
    wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
    ctypes.POINTER(STARTUPINFO), ctypes.POINTER(PROCESS_INFORMATION),
]
kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
kernel32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def checked(ok: object) -> None:
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())


def publish(path: Path, value: dict) -> None:
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def active_processes(job: int) -> int:
    accounting = BASIC_ACCOUNTING()
    checked(kernel32.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None))
    return int(accounting.ActiveProcesses)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--status", required=True)
    parser.add_argument("--control", required=True)
    parser.add_argument("--owner-pid", required=True, type=int)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise ValueError("target command is required")

    status_path, control_path = Path(args.status), Path(args.control)
    job = kernel32.CreateJobObjectW(None, None)
    checked(job)
    process = PROCESS_INFORMATION()
    owner = None
    assigned = False
    try:
        limits = EXTENDED_LIMITS()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        checked(kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
        startup = STARTUPINFO()
        startup.cb = ctypes.sizeof(startup)
        command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(command))
        flags = CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        checked(kernel32.CreateProcessW(None, command_line, None, None, False, flags, None, args.cwd, ctypes.byref(startup), ctypes.byref(process)))
        publish(status_path, {"state": "created", "root_pid": int(process.dwProcessId), "exit_code": None, "active_processes": None})
        if os.environ.get("NAIA_BEH_TEST_ASSIGN_FAILURE") == "1":
            raise OSError("forced assignment failure")
        checked(kernel32.AssignProcessToJobObject(job, process.hProcess))
        assigned = True
        owner = kernel32.OpenProcess(0x00100000, False, args.owner_pid)  # SYNCHRONIZE
        checked(owner)
        checked(kernel32.ResumeThread(process.hThread) != 0xFFFFFFFF)
        publish(status_path, {"state": "ready", "root_pid": int(process.dwProcessId), "exit_code": None, "active_processes": active_processes(job)})

        root_exit = None
        while True:
            if kernel32.WaitForSingleObject(owner, 0) == WAIT_OBJECT_0:
                control = "terminate"
            else:
                try:
                    control = json.loads(control_path.read_text(encoding="utf-8")).get("action")
                except (FileNotFoundError, json.JSONDecodeError, OSError):
                    control = None
            exit_code = wintypes.DWORD(STILL_ACTIVE)
            checked(kernel32.GetExitCodeProcess(process.hProcess, ctypes.byref(exit_code)))
            if exit_code.value != STILL_ACTIVE and root_exit is None:
                root_exit = int(exit_code.value)
                publish(status_path, {"state": "exited", "root_pid": int(process.dwProcessId), "exit_code": root_exit, "active_processes": active_processes(job)})
            if control == "terminate":
                checked(kernel32.TerminateJobObject(job, 1))
                deadline = time.monotonic() + 10
                while active_processes(job) and time.monotonic() < deadline:
                    time.sleep(0.05)
                remaining = active_processes(job)
                publish(status_path, {"state": "terminated", "root_pid": int(process.dwProcessId), "exit_code": root_exit, "active_processes": remaining})
                return 0 if remaining == 0 else 3
            time.sleep(0.05)
    except Exception as error:
        if process.hProcess and not assigned:
            kernel32.TerminateProcess(process.hProcess, 2)
            kernel32.WaitForSingleObject(process.hProcess, 5000)
        publish(status_path, {"state": "error", "root_pid": int(process.dwProcessId) if process.dwProcessId else None, "error": f"{type(error).__name__}: {error}"})
        return 2
    finally:
        for handle in (process.hThread, process.hProcess, owner, job):
            if handle:
                kernel32.CloseHandle(handle)


if __name__ == "__main__":
    raise SystemExit(main())
