"""Shared stdin-based non-interactive LLM CLI invocation builder."""
from __future__ import annotations

import os
from pathlib import Path


def build_cli_invocation(
    cli: str,
    model: str,
    prompt: str,
    repo_root: Path,
    reasoning_effort: str = "low",
) -> tuple[list[str], str]:
    """Return a shell-free command and the prompt that must be sent on stdin."""
    executable = f"{cli}.cmd" if os.name == "nt" else cli
    if cli == "claude":
        command = [executable]
        if model:
            command += ["--model", model]
        command += [
            "-p", "--input-format", "text", "--output-format", "text",
            "--no-session-persistence", "--setting-sources", "user",
            "--tools", "", "--disable-slash-commands",
        ]
        return command, prompt
    if cli == "codex":
        command = [
            executable, "exec", "--ephemeral", "--sandbox", "read-only",
            "--skip-git-repo-check", "-C", str(repo_root),
            "-c", f"model_reasoning_effort={reasoning_effort}",
            "-c", "features.hooks=false",
        ]
        if model:
            command += ["--model", model]
        command += ["-"]
        return command, prompt
    if cli == "gemini":
        command = [executable, "-p", "", "--approval-mode", "plan"]
        if model:
            command += ["--model", model]
        return command, prompt
    raise ValueError(f"unknown LLM CLI: {cli!r}")
