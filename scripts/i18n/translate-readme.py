#!/usr/bin/env python3
# Copyright 2026 Nextain Inc. All rights reserved.
"""Multi-language README translator (structure-preserving, CLI backend).

Translates a verified source README into N target languages while keeping
EVERY structural line byte-identical: the language switcher, HTML tags,
fenced code blocks, tables, URLs, relative paths, image `src`, and
identifiers. Only natural-language prose / headings / table-cell text is
translated.

Source defaults to the **already path-corrected Korean** file
(`READMES/README.ko.md`) so the `../`-relative paths and the 14-language
switcher carry over verbatim to every language — no per-language path
rewriting, which is the main correctness risk.

Backend: claude CLI by default (large docs; `gemini -p` times out on
400+ line files). Override with LLM_CLI=claude|codex|gemini.

Env / flags:
    --src PATH        source markdown (default READMES/README.ko.md)
    --src-lang NAME   human name of source language (default Korean)
    --out-dir DIR     output dir (default dirname(src))
    --pattern PAT     output filename pattern (default README.{lang}.md)
    --langs a,b,c     target IETF codes (default: 12 ai_baseline)
    --force           ignore sha sidecar, re-translate all
    --only a,b        restrict to these langs
    --timeout SEC     per-file LLM timeout (default 420)

Idempotent: `.translate-readme-state.json` in out-dir maps lang → sha256
of the source; unchanged source is skipped.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import re
from pathlib import Path

from cli_invocation import build_cli_invocation
from cli_process import run_cli_process

LANG_NAMES = {
    "ja": "Japanese", "zh": "Chinese (Simplified)", "fr": "French",
    "de": "German", "ru": "Russian", "es": "Spanish", "ar": "Arabic",
    "hi": "Hindi", "bn": "Bengali", "pt": "Portuguese",
    "id": "Indonesian", "vi": "Vietnamese", "en": "English", "ko": "Korean",
}
DEFAULT_LANGS = ["ja", "zh", "fr", "de", "ru", "es", "ar", "hi", "bn", "pt", "id", "vi"]

LLM_CLI = os.environ.get("LLM_CLI", "claude").strip()


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def call_cli(prompt: str, timeout: int) -> str:
    try:
        cmd, stdin_text = build_cli_invocation(LLM_CLI, "", prompt, Path(__file__).resolve().parents[2])
    except ValueError as error:
        raise SystemExit(str(error)) from error
    r = run_cli_process(cmd, stdin_text, timeout)
    if r.returncode != 0:
        raise RuntimeError(f"{LLM_CLI} exit {r.returncode}: {r.stderr.strip()[:300]}")
    return r.stdout

_FENCE = re.compile(r"^\s*```[a-zA-Z]*\s*\n(.*)\n```\s*$", re.DOTALL)


def clean(raw: str) -> str:
    s = raw.strip()
    m = _FENCE.match(s)
    if m:
        s = m.group(1).strip()
    return s + "\n"


def prompt_for(src_lang: str, tgt_lang: str, tgt_code: str, text: str) -> str:
    return f"""Translate the following {src_lang} Markdown document into
{tgt_lang}. This is a public open-source project README.

ABSOLUTE RULES — violating any of these breaks the page:
1. Output ONLY the translated Markdown. No preamble, no fences around the
   whole document.
2. The FIRST line is a language switcher (`[English](...) | [한국어](...) |
   ...`). Reproduce it 100% BYTE-IDENTICAL — do not translate, reorder, or
   touch any link or path in it.
3. Keep BYTE-IDENTICAL: every fenced code block (``` … ```), every HTML
   tag and attribute (`<p>`, `<img src=...>`, `<details>`, `<br/>` …),
   every URL, every relative path (`../assets/...`, `../.agents/...`,
   `../LICENSE` …), every `src=`/`href=`, identifiers, and the Markdown
   table structure (pipes / separator rows).
4. Translate ONLY natural-language text: prose, headings, list item text,
   table CELL text, blockquotes, and image `alt` text.
5. Do NOT translate product/tech proper nouns: Naia, Nextain, OpenClaw,
   Bazzite, Tauri, VRM, Three.js, ClawHub, Alpha Memory System,
   naia-os/naia-agent/naia-adk/alpha-memory, @nextain/agent-types,
   Flatpak/AppImage/DEB/RPM/ISO, SQLite, Biome, Vitest, pnpm,
   Apache 2.0, CC-BY-SA 4.0, SPDX, Discord, OAuth, GHCR, BlueBuild,
   SELinux, SoT.
6. Keep the document's meaning and structure exactly. Same number of
   headings, list items, table rows, and code blocks as the source.

--- {src_lang} SOURCE ---
{text}
--- END SOURCE ---

Full {tgt_lang} translation (code `{tgt_code}`), Markdown only:"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="projects/naia-os/READMES/README.ko.md")
    ap.add_argument("--src-lang", default="Korean")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--pattern", default="README.{lang}.md")
    ap.add_argument("--langs", default=",".join(DEFAULT_LANGS))
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--timeout", type=int, default=420)
    a = ap.parse_args()

    repo = Path(__file__).resolve().parents[2]
    src = (repo / a.src).resolve()
    if not src.is_file():
        print(f"[i18n] source missing: {src}", file=sys.stderr)
        return 2
    out_dir = Path(a.out_dir).resolve() if a.out_dir else src.parent
    state_f = out_dir / ".translate-readme-state.json"
    try:
        state = json.loads(state_f.read_text("utf-8"))
    except Exception:
        state = {}

    langs = [x for x in a.langs.split(",") if x]
    only = {x for x in a.only.split(",") if x}
    src_bytes = src.read_bytes()
    h = sha(src_bytes)
    src_text = src_bytes.decode("utf-8")
    print(f"[i18n] src={a.src} ({len(src_text.splitlines())} lines) "
          f"backend=cli:{LLM_CLI} langs={len(langs)}")

    done = skip = fail = 0
    new_state = dict(state)
    for code in langs:
        if only and code not in only:
            continue
        name = LANG_NAMES.get(code, code)
        dst = out_dir / a.pattern.format(lang=code)
        if state.get(code) == h and dst.exists() and not a.force:
            print(f"  = {code} (unchanged)")
            skip += 1
            continue
        if a.dry_run:
            print(f"  ~ {code} ({name}) would translate")
            continue
        try:
            out = clean(call_cli(prompt_for(a.src_lang, name, code, src_text), a.timeout))
            if len(out.strip()) < int(len(src_text.strip()) * 0.4):
                raise RuntimeError(f"output too short ({len(out)} vs {len(src_text)})")
            dst.write_text(out, "utf-8")
            new_state[code] = h
            print(f"  ✓ {code} ({name})  {len(out.encode())}B")
            done += 1
        except Exception as e:
            print(f"  ✗ {code} ({name}) FAILED: {e}", file=sys.stderr)
            fail += 1

    if not a.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        state_f.write_text(json.dumps(new_state, ensure_ascii=False, indent=2, sort_keys=True) + "\n", "utf-8")
    print(f"[i18n] done={done} skip={skip} fail={fail}")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
