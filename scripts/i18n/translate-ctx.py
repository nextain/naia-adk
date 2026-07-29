#!/usr/bin/env python3
# Copyright 2026 Nextain Inc. All rights reserved.
"""Context-doc translator — KO `.users/context/*.md` → EN `.users/context/en/*.md`.

The `.users/context/*.md` files at the alpha-adk root are *hand-curated*
human docs (NOT mechanical mirrors — that is the ADK-series convention).
Their English counterparts have no automation, so they drift. This script
is the "small-model translation on context update" pipeline: it translates
each Korean source with a small LLM, pins NAIA terminology via a glossary,
preserves markdown/code structure, and is idempotent via a content-hash
sidecar (only changed sources are re-translated).

Backends (no API key needed for the CLI path — matches the workspace
convention established by naia-sing/scripts/translate.py):

    I18N_BACKEND=cli  (default)
        default route: claude:haiku,codex:gpt-5.6-luna,claude:sonnet
        I18N_CLI_ROUTE=<cli:model,...>  override the fallback chain
        LLM_CLI + I18N_CLI_MODEL        explicit single-adapter override
    I18N_BACKEND=http
        I18N_ENDPOINT=http://localhost:8002/v1/chat/completions
        I18N_MODEL=<model id>
        (OpenAI-compatible; point at naia-serve for fully-local/private)

Env / flags:
    I18N_SRC_DIR   default .users/context
    I18N_DST_DIR   default .users/context/en
    I18N_GLOSSARY  default scripts/i18n/glossary.md
    --force        re-translate even if source hash unchanged
    --only NAME    translate only <NAME>.md (repeatable, comma-ok)
    --dry-run      list what would be translated, no LLM call, no write
    --timeout SEC  per-adapter, per-file timeout (default 60)
    --jobs N       parallel workers with deterministic ordered writes (default 2)

Run from the repo root:  python3 scripts/i18n/translate-ctx.py
Exit code is non-zero if any file failed (so a commit step can gate on it).
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import subprocess
import sys
from threading import Lock
import urllib.request
from pathlib import Path

from cli_invocation import build_cli_invocation

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = REPO_ROOT / os.environ.get("I18N_SRC_DIR", ".users/context")
DST_DIR = REPO_ROOT / os.environ.get("I18N_DST_DIR", ".users/context/en")
GLOSSARY = REPO_ROOT / os.environ.get("I18N_GLOSSARY", "scripts/i18n/glossary.md")
STATE_FILE = DST_DIR / ".translate-state.json"

BACKEND = os.environ.get("I18N_BACKEND", "cli").strip()
LLM_CLI = os.environ.get("LLM_CLI", "").strip()
CLI_MODEL = os.environ.get("I18N_CLI_MODEL", "").strip()
DEFAULT_CLI_ROUTE = "claude:haiku,codex:gpt-5.6-luna,claude:sonnet"
CLI_ROUTE = os.environ.get("I18N_CLI_ROUTE", DEFAULT_CLI_ROUTE).strip()
HTTP_ENDPOINT = os.environ.get("I18N_ENDPOINT", "http://localhost:8002/v1/chat/completions")
HTTP_MODEL = os.environ.get("I18N_MODEL", "").strip()
DISABLED_CLI_ADAPTERS: set[str] = set()
ADAPTER_STATE_LOCK = Lock()


def configure_utf8_console() -> None:
    """Avoid Windows legacy-console failures while reporting Korean filenames."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, OSError):
            pass


configure_utf8_console()


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def display_path(path: Path) -> str:
    """Return a stable path for logs even when test/CI uses external temp dirs."""
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def is_mechanical_mirror(text: str) -> bool:
    """True if the source is an AUTO-GENERATED render of a JSON SoT.

    Those files (ADK-convention mirror, e.g. `writing-style.md`) are
    re-derived by agents-context-mirror.js and must NOT be hand/LLM
    translated — that would be the wrong layer. Only hand-curated docs
    are translation targets here.
    """
    head = "\n".join(text.splitlines()[:3]).lower()
    return "auto-generated from .agents/context" in head


def load_state() -> dict:
    try:
        loaded = json.loads(STATE_FILE.read_text("utf-8"))
        files = loaded.get("files", {}) if isinstance(loaded, dict) and loaded.get("schema_version") == 2 else {}
        return {name: receipt for name, receipt in files.items() if isinstance(receipt, dict)}
    except Exception:
        return {}


def save_state(state: dict) -> None:
    DST_DIR.mkdir(parents=True, exist_ok=True)
    receipt = {"schema_version": 2, "files": state}
    STATE_FILE.write_text(json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n", "utf-8")


def build_prompt(name: str, ko_text: str, glossary: str) -> str:
    return f"""You are a precise technical translator for the Nextain / Naia
engineering documentation set. Translate the following Korean document into
English.

STRICT RULES:
1. Output ONLY the translated Markdown. No preamble, no explanation, no code
   fence around the whole document.
2. Preserve the Markdown structure exactly: headings levels, lists, tables,
   blockquotes, links, and the relative order of all sections.
3. Do NOT translate or alter code, identifiers, file paths, URLs, or shell
   commands — copy them verbatim, including inside fenced blocks. EXCEPTION:
   natural-language annotation text inside ```text / diagram / ascii blocks
   (e.g. a Korean label after a `→` or `#`) SHOULD be translated; keep the
   identifiers, arrows, indentation, and box structure intact.
4. Preserve the very first line verbatim if it is an HTML comment
   (e.g. a Copyright or AUTO-GENERATED banner).
5. Apply the glossary below exactly. "Keep verbatim" terms must appear
   unchanged in the English output.
6. Faithful, professional, idiomatic technical English. Do NOT add marketing
   flourish, do NOT editorialize, do NOT use blunt "not A but B" rhetorical
   contrasts, do NOT soften or strengthen any claim.
7. Keep the document's meaning and register identical to the source.

--- GLOSSARY ---
{glossary}
--- END GLOSSARY ---

--- KOREAN SOURCE: {name}.md ---
{ko_text}
--- END KOREAN SOURCE ---

English translation of {name}.md (Markdown only):"""


def parse_cli_route(route: str) -> list[tuple[str, str]]:
    parsed = []
    for raw_entry in route.split(","):
        entry = raw_entry.strip()
        if not entry:
            continue
        cli, separator, model = entry.partition(":")
        if not separator or not cli.strip() or not model.strip():
            raise ValueError(f"invalid I18N_CLI_ROUTE entry {entry!r}; expected cli:model")
        parsed.append((cli.strip(), model.strip()))
    if not parsed:
        raise ValueError("I18N_CLI_ROUTE must contain at least one cli:model entry")
    return parsed


def call_cli_adapter(cli: str, model: str, prompt: str, timeout: int) -> str:
    """Execute one adapter; command construction remains centralized above."""
    cmd, stdin_text = build_cli_invocation(cli, model, prompt, REPO_ROOT)
    r = subprocess.run(
        cmd,
        input=stdin_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if r.returncode != 0:
        diagnostic = (r.stderr.strip() or r.stdout.strip() or "no diagnostic output")
        raise RuntimeError(f"{cli}:{model} exit {r.returncode}: {diagnostic[:300]}")
    return r.stdout


def call_cli(prompt: str, timeout: int) -> tuple[str, str, list[dict[str, str]]]:
    """Try the declared low-cost route and return output, backend, and attempts."""
    route = [(LLM_CLI, CLI_MODEL)] if LLM_CLI else parse_cli_route(CLI_ROUTE)
    attempts = []
    for cli, model in route:
        adapter = f'{cli}:{model}'
        with ADAPTER_STATE_LOCK:
            disabled = adapter in DISABLED_CLI_ADAPTERS
        if disabled:
            attempts.append({'adapter': adapter, 'status': 'skipped', 'diagnostic': 'batch circuit breaker open'})
            continue
        try:
            output = call_cli_adapter(cli, model, prompt, timeout)
            attempts.append({"adapter": f"{cli}:{model}", "status": "success"})
            return output, f"cli:{cli}:{model}", attempts
        except Exception as error:
            diagnostic = str(error)[:300]
            if any(marker in diagnostic.lower() for marker in ('session limit', 'usage limit', 'timed out', 'timeout')):
                with ADAPTER_STATE_LOCK:
                    DISABLED_CLI_ADAPTERS.add(adapter)
            attempts.append({"adapter": f"{cli}:{model}", "status": "failed", "diagnostic": diagnostic})
            print(f"  ! translation fallback {cli}:{model}: {diagnostic}", file=sys.stderr)
    raise RuntimeError("all translation adapters failed: " + " | ".join(a.get("diagnostic", "") for a in attempts))


def call_http(prompt: str, timeout: int) -> str:
    body = {
        "model": HTTP_MODEL or "default",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": 8192,
    }
    req = urllib.request.Request(
        HTTP_ENDPOINT,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        d = json.loads(resp.read().decode())
    return d["choices"][0]["message"]["content"]


_FENCE_RE = re.compile(r"^\s*```[a-zA-Z]*\s*\n(.*)\n```\s*$", re.DOTALL)


def clean_output(raw: str) -> str:
    s = raw.strip()
    m = _FENCE_RE.match(s)
    if m:  # model wrapped the whole doc in a ``` fence — unwrap
        s = m.group(1).strip()
    # Keep generated mirrors friendly to `git diff --check`. Markdown hard
    # breaks are not part of the source contract and must not create whitespace drift.
    return "\n".join(line.rstrip() for line in s.splitlines()) + "\n"


def translate_one(path: Path, glossary: str, timeout: int) -> tuple[str, str, list[dict[str, str]]]:
    ko = path.read_text("utf-8")
    prompt = build_prompt(path.stem, ko, glossary)
    if BACKEND == "cli":
        raw, backend_used, attempts = call_cli(prompt, timeout)
    else:
        raw, backend_used = call_http(prompt, timeout), f"http:{HTTP_ENDPOINT}"
        attempts = [{"adapter": backend_used, "status": "success"}]
    out = clean_output(raw)
    # Sanity: refuse to write a suspiciously short / empty translation.
    if len(out.strip()) < max(40, int(len(ko.strip()) * 0.25)):
        raise RuntimeError(
            f"output too short ({len(out.strip())} vs src {len(ko.strip())}) — refusing to write; "
            f"preview={out.strip()[:240]!r}"
        )
    return out, backend_used, attempts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", action="append", default=[])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true",
                    help="report pending translations without invoking an LLM; exit 1 when drift exists")
    ap.add_argument("--timeout", type=int, default=60)
    ap.add_argument("--jobs", type=int, default=2,
                    help="parallel translation workers; receipts are still written once, deterministically")
    args = ap.parse_args()

    only = {x for item in args.only for x in item.split(",") if x}

    if not SRC_DIR.is_dir():
        print(f"[i18n] source dir missing: {SRC_DIR}", file=sys.stderr)
        return 2
    glossary = GLOSSARY.read_text("utf-8") if GLOSSARY.exists() else ""
    if not glossary:
        print(f"[i18n] WARNING: glossary not found at {GLOSSARY}", file=sys.stderr)

    sources = sorted(p for p in SRC_DIR.glob("*.md") if p.is_file())
    state = load_state()
    backend_desc = (f"cli:{LLM_CLI}:{CLI_MODEL}" if LLM_CLI else f"cli-route:{CLI_ROUTE}") if BACKEND == "cli" else f"http:{HTTP_ENDPOINT}"
    print(f"[i18n] backend={backend_desc}  src={display_path(SRC_DIR)}  "
          f"dst={display_path(DST_DIR)}  files={len(sources)}")

    if args.jobs < 1 or args.jobs > 4:
        ap.error("--jobs must be between 1 and 4")

    done = skipped = failed = pending = 0
    new_state = dict(state)
    queued = []
    source_by_name = {src.stem: src for src in sources}
    retired = {}
    for name in state:
        src = source_by_name.get(name)
        if src is None:
            retired[name] = "source missing"
        elif is_mechanical_mirror(src.read_text("utf-8", errors="ignore")):
            retired[name] = "source is now a mechanical mirror"
    for name in sorted(retired):
        if only and name not in only:
            continue
        dst = DST_DIR / f"{name}.md"
        if args.dry_run or args.check:
            print(f"  ~ {name}.md (managed output removal queued: {retired[name]})")
            pending += 1
            continue
        if dst.exists():
            dst.unlink()
        new_state.pop(name, None)
        print(f"  - {name}.md (removed retired translation and receipt: {retired[name]})")
        done += 1
    for src in sources:
        name = src.stem
        if only and name not in only:
            continue
        ko_bytes = src.read_bytes()
        if is_mechanical_mirror(ko_bytes.decode("utf-8", "ignore")):
            print(f"  - {name}.md (mechanical mirror — skipped, not a translation target)")
            skipped += 1
            continue
        h = sha(ko_bytes)
        dst = DST_DIR / src.name
        receipt = state.get(name)
        recorded_hash = (receipt or {}).get("source_sha256")
        output_fresh = (
            isinstance(receipt, dict)
            and dst.exists() and receipt.get("output_sha256") == sha(dst.read_bytes())
        )
        fresh = recorded_hash == h and dst.exists() and output_fresh
        if fresh and not args.force:
            print(f"  = {name}.md (unchanged)")
            skipped += 1
            continue
        if args.dry_run or args.check:
            print(f"  ~ {name}.md (translation queued)")
            pending += 1
            continue
        queued.append((src, name, ko_bytes, h, dst))

    def record_success(src: Path, name: str, ko_bytes: bytes, h: str, dst: Path, out: str, backend_used: str, attempts: list[dict[str, str]]) -> None:
            nonlocal done
            DST_DIR.mkdir(parents=True, exist_ok=True)
            dst.write_text(out, "utf-8")
            new_state[name] = {
                "source_path": display_path(src).replace("\\", "/"),
                "source_sha256": h,
                # Hash persisted bytes, not the in-memory string: Windows text
                # I/O may normalize LF to CRLF.
                "output_sha256": sha(dst.read_bytes()),
                "translated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                "backend": backend_used,
                "attempts": attempts,
            }
            print(f"  ✓ {name}.md  ({len(ko_bytes)}B → {len(out.encode())}B)")
            done += 1

    if queued and args.jobs == 1:
        for src, name, ko_bytes, h, dst in queued:
            try:
                out, backend_used, attempts = translate_one(src, glossary, args.timeout)
                record_success(src, name, ko_bytes, h, dst, out, backend_used, attempts)
            except Exception as e:
                print(f"  ✗ {name}.md  FAILED: {e}", file=sys.stderr)
                failed += 1
    elif queued:
        results = {}
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            futures = {pool.submit(translate_one, item[0], glossary, args.timeout): item for item in queued}
            for future in as_completed(futures):
                item = futures[future]
                try:
                    out, backend_used, attempts = future.result()
                    results[item[1]] = (item, out, backend_used, attempts, None)
                except Exception as e:
                    results[item[1]] = (item, None, None, None, e)
        # Writes and receipt updates remain source-name ordered regardless of completion order.
        for name in sorted(results):
            (src, _, ko_bytes, h, dst), out, backend_used, attempts, error = results[name]
            if error is not None:
                print(f"  ✗ {name}.md  FAILED: {error}", file=sys.stderr)
                failed += 1
            else:
                record_success(src, name, ko_bytes, h, dst, out, backend_used, attempts)

    if not args.dry_run and not args.check:
        save_state(new_state)
    print(f"[i18n] done={done} skipped={skipped} pending={pending} failed={failed}")
    return 1 if failed or (args.check and pending) else 0


if __name__ == "__main__":
    raise SystemExit(main())
