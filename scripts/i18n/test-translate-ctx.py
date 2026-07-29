#!/usr/bin/env python3
"""Focused no-network tests for translate-ctx.py queue and legacy-receipt handling."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import shutil
import tempfile
import time
import uuid
from types import SimpleNamespace
from pathlib import Path

SCRIPT = Path(__file__).with_name("translate-ctx.py")
SCRIPT_SOURCE = SCRIPT.read_text("utf-8")
CLI_SOURCE = Path(__file__).with_name("cli_invocation.py").read_text("utf-8")
PROCESS_SOURCE = Path(__file__).with_name("cli_process.py").read_text("utf-8")
SUBPROCESS_SOURCE = SCRIPT_SOURCE + CLI_SOURCE + PROCESS_SOURCE
EN_REPO_STRUCTURE = SCRIPT.parents[2] / ".users" / "context" / "en" / "repo-structure-standard.md"
assert "(Korean mirror)" not in EN_REPO_STRUCTURE.read_text("utf-8"), "English mirror title incorrectly labels itself Korean"

for required_cli_guard in ["build_cli_invocation", "parse_cli_route", "call_cli_adapter", '"--no-session-persistence"', '"--setting-sources"',
                           '"--skip-git-repo-check"', 'model_reasoning_effort=',
                           '"features.hooks=false"', "diagnostic = (r.stderr.strip() or r.stdout.strip()",
                           "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE", "TerminateJobObject", "os.killpg", "run_cli_process"]:
    assert required_cli_guard in SUBPROCESS_SOURCE, f"translation subprocess lacks {required_cli_guard}"

spec = importlib.util.spec_from_file_location("translate_ctx", SCRIPT)
assert spec and spec.loader
translate_ctx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(translate_ctx)
sample_prompt = "x" * 40000
claude_cmd, claude_stdin = translate_ctx.build_cli_invocation("claude", "haiku", sample_prompt, translate_ctx.REPO_ROOT)
assert claude_stdin == sample_prompt and sample_prompt not in claude_cmd
assert claude_cmd[claude_cmd.index("--setting-sources") + 1] == "user"
assert claude_cmd[claude_cmd.index("--tools") + 1] == ""
assert "--no-session-persistence" in claude_cmd
codex_cmd, codex_stdin = translate_ctx.build_cli_invocation("codex", "gpt-5.6-luna", sample_prompt, translate_ctx.REPO_ROOT)
assert codex_stdin == sample_prompt and sample_prompt not in codex_cmd
for expected in ["--ephemeral", "--skip-git-repo-check", "model_reasoning_effort=low", "features.hooks=false", "gpt-5.6-luna"]:
    assert expected in codex_cmd
assert translate_ctx.parse_cli_route(translate_ctx.DEFAULT_CLI_ROUTE) == [
    ("claude", "haiku"), ("codex", "gpt-5.6-luna"), ("claude", "sonnet")
]

# The shared runner must advance after a diagnostic failure and report the
# adapter that actually produced the bytes used for the receipt.
original_run = translate_ctx.run_cli_process
attempts = []
def fake_run(cmd, stdin_text, timeout):
    attempts.append(cmd)
    if len(attempts) == 1:
        return SimpleNamespace(returncode=1, stderr="", stdout="session limit")
    return SimpleNamespace(returncode=0, stderr="", stdout="# translated\n")
translate_ctx.run_cli_process = fake_run
translate_ctx.LLM_CLI = ""
translate_ctx.CLI_ROUTE = "claude:haiku,codex:gpt-5.6-luna,claude:sonnet"
fallback_output, fallback_backend, fallback_attempts = translate_ctx.call_cli(sample_prompt, 10)
second_output, second_backend, second_attempts = translate_ctx.call_cli(sample_prompt, 10)
translate_ctx.run_cli_process = original_run
assert fallback_output == "# translated\n"
assert fallback_backend == "cli:codex:gpt-5.6-luna"
assert fallback_attempts == [
    {"adapter": "claude:haiku", "status": "failed", "diagnostic": "claude:haiku exit 1: session limit"},
    {"adapter": "codex:gpt-5.6-luna", "status": "success"},
]
assert "haiku" in attempts[0] and "gpt-5.6-luna" in attempts[1]
assert second_output == '# translated\n' and second_backend == 'cli:codex:gpt-5.6-luna'
assert second_attempts[0] == {'adapter': 'claude:haiku', 'status': 'skipped', 'diagnostic': 'batch circuit breaker open'}
assert len(attempts) == 3 and 'gpt-5.6-luna' in attempts[2]

# A timed-out CLI wrapper must not leave the actual model process (or any of
# its descendants) holding inherited pipes on Windows or POSIX.
with tempfile.TemporaryDirectory(prefix="translate-cli-tree-") as timeout_dir:
    child_pid_file = Path(timeout_dir) / "child.pid"
    parent_code = (
        "import pathlib,subprocess,sys,time;"
        "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);"
        f"pathlib.Path({str(child_pid_file)!r}).write_text(str(child.pid));"
        "time.sleep(60)"
    )
    started = time.monotonic()
    try:
        translate_ctx.run_cli_process([sys.executable, "-c", parent_code], "", 1)
        raise AssertionError("timed-out CLI unexpectedly returned")
    except subprocess.TimeoutExpired:
        pass
    assert time.monotonic() - started < 20, "CLI timeout did not terminate promptly"
    child_pid = int(child_pid_file.read_text())
    child_dead = False
    for _ in range(20):
        try:
            os.kill(child_pid, 0)
        except OSError:
            child_dead = True
            break
        time.sleep(0.1)
    assert child_dead, f"timed-out CLI descendant still alive: {child_pid}"

gemini_cmd, gemini_stdin = translate_ctx.build_cli_invocation(
    "gemini", "gemini-2.5-flash", sample_prompt, translate_ctx.REPO_ROOT
)
assert gemini_stdin == sample_prompt and sample_prompt not in gemini_cmd
assert gemini_cmd[gemini_cmd.index("-p") + 1] == ""


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


test_tmp_root = SCRIPT.parents[2] / ".agents" / "work"
test_tmp_root.mkdir(parents=True, exist_ok=True)
root = test_tmp_root / ("translate-ctx-" + uuid.uuid4().hex)
root.mkdir(mode=0o777)
try:
        source = root / "ko"
        target = root / "en"
        source.mkdir()
        target.mkdir()
        ko = "# 한글\n\n내용\n".encode()
        (source / "guide.md").write_bytes(ko)
        (target / "guide.md").write_text("# English\n\ncontent\n", "utf-8")
        # Legacy source-only receipts cannot prove the current output bytes.
        (target / ".translate-state.json").write_text(json.dumps({"guide": digest(ko)}), "utf-8")
        env = {
            **os.environ,
            "I18N_SRC_DIR": str(source),
            "I18N_DST_DIR": str(target),
            "I18N_GLOSSARY": str(root / "missing-glossary.md"),
        }
        legacy = subprocess.run([sys.executable, str(SCRIPT), "--check"], env=env, text=True,
                                 capture_output=True, encoding="utf-8")
        assert legacy.returncode == 1, legacy.stderr + legacy.stdout
        assert "translation queued" in legacy.stdout
        output = (target / "guide.md").read_bytes()
        (target / ".translate-state.json").write_text(json.dumps({"schema_version": 2, "files": {"guide": {"source_sha256": digest(ko), "output_sha256": digest(output)}}}), "utf-8")
        clean = subprocess.run([sys.executable, str(SCRIPT), "--check"], env=env, text=True,
                               capture_output=True, encoding="utf-8")
        assert clean.returncode == 0, clean.stderr + clean.stdout
        (source / "guide.md").write_bytes(ko + "변경\n".encode())
        drift = subprocess.run([sys.executable, str(SCRIPT), "--check"], env=env, text=True,
                               capture_output=True, encoding="utf-8")
        assert drift.returncode == 1, drift.stderr + drift.stdout
        assert "translation queued" in drift.stdout

        removed_bypass = subprocess.run([sys.executable, str(SCRIPT), "--accept-existing", "--only", "guide"],
                                        env=env, text=True, capture_output=True, encoding="utf-8")
        assert removed_bypass.returncode == 2, removed_bypass.stderr + removed_bypass.stdout
        assert "unrecognized arguments: --accept-existing" in removed_bypass.stderr

        # A deleted or renamed managed source must not leave a stale English
        # translation or receipt. English-only files without receipts survive.
        (target / "english-only.md").write_text("# English only\n", "utf-8")
        (source / "guide.md").unlink()
        orphan_check = subprocess.run([sys.executable, str(SCRIPT), "--check", "--only", "guide"],
                                      env=env, text=True, capture_output=True, encoding="utf-8")
        assert orphan_check.returncode == 1, orphan_check.stderr + orphan_check.stdout
        assert "managed output removal queued" in orphan_check.stdout
        orphan_remove = subprocess.run([sys.executable, str(SCRIPT), "--only", "guide"],
                                       env=env, text=True, capture_output=True, encoding="utf-8")
        assert orphan_remove.returncode == 0, orphan_remove.stderr + orphan_remove.stdout
        assert not (target / "guide.md").exists()
        cleaned_state = json.loads((target / ".translate-state.json").read_text("utf-8"))
        assert "guide" not in cleaned_state.get("files", {})
        assert (target / "english-only.md").exists()
        mechanical = "<!-- AUTO-GENERATED from .agents/context/example.json -->\n# Mirror\n".encode()
        (source / "guide.md").write_bytes(mechanical)
        (target / "guide.md").write_text("# stale translation\n", "utf-8")
        mechanical_output = (target / "guide.md").read_bytes()
        (target / ".translate-state.json").write_text(json.dumps({
            "schema_version": 2,
            "files": {"guide": {
                "source_sha256": digest(mechanical),
                "output_sha256": digest(mechanical_output),
            }},
        }), "utf-8")
        mechanical_check = subprocess.run([sys.executable, str(SCRIPT), "--check", "--only", "guide"],
                                          env=env, text=True, capture_output=True, encoding="utf-8")
        assert mechanical_check.returncode == 1, mechanical_check.stderr + mechanical_check.stdout
        assert "source is now a mechanical mirror" in mechanical_check.stdout
        mechanical_remove = subprocess.run([sys.executable, str(SCRIPT), "--only", "guide"],
                                           env=env, text=True, capture_output=True, encoding="utf-8")
        assert mechanical_remove.returncode == 0, mechanical_remove.stderr + mechanical_remove.stdout
        assert not (target / "guide.md").exists()
        assert "guide" not in json.loads(
            (target / ".translate-state.json").read_text("utf-8")
        ).get("files", {})
        assert (target / "english-only.md").exists()
finally:
    shutil.rmtree(root, ignore_errors=True)

print("translate context tests passed")
