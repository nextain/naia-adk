<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Terminology & Communication Guide

> SoT: `.agents/context/terminology.yaml` — this is the human-readable English mirror.
> Primary mirror (Korean): `../terminology.md`.

## Core Principle

**Do not invent our own neologisms or compound words.** Default to plain terms a
general audience can understand. For academic terms and acronyms, give a plain
translation on first use and put the original in parentheses.

### Why

1. When our internal compounds fill the prose, even we can't parse it (2026-05-28 B2B pitch incident).
2. Academic terms without translation overload general audiences.
3. Mixing standard vocabulary with our coinages erodes credibility.
4. Context outlives the moment — words only "we right now" recognize rot quickly.

## Scope

- All documents (`docs/`, READMEs, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.users/` mirrors)
- Code comments (inline + module docstrings)
- Natural-language fields in JSON / YAML (`description`, `why`, `notes`)
- PR / Issue bodies, the natural-language parts of commit messages
- Memory entries, `.agents/progress`, `.agents/reviews`
- External surface: talks, slides, public copy

## Exempt

- Code identifiers (variables, functions, classes, file names, module names) — English as is
- JSON / YAML keys — English as is for schema stability
- GitHub URLs / PR numbers / commit SHAs — not translatable

## Three-Category Classification

### 1. Standard terms / product names → keep as is

Industry acronyms:
> AI / LLM / RAG / API / SDK / CLI / STT / TTS / VAD / E2E / MoE / RBAC / CRM /
> SQLite / ICLR / LongMemEval / KsponSpeech / KEMDy20

Product names:
> Claude / Gemini / Codex / ollama / vLLM /
> mem0 /
> naia-adk / naia-agent / naia-memory / naia-os / naia-cognitive (brand names)

CS common terms:
> domain / module / backend / runtime / gateway / preset / fallback / catalog /
> process / thread / container / config / cache / queue

**⚠️ Exception — `harness`**: do not use on external surfaces (talks, slides, public READMEs).
Korean audiences hear "하네스" as "safety strap". Replace with "benchmark" / "evaluation system" /
"measurement tool". Inside code, memory, and `.agents/` — `harness` is fine.

### 2. Academic / measurement terms → translate + parenthesize the original

First use: `<plain translation> (<original or acronym>[, <source>])`. Later uses
may drop either part.

Examples:
- 예측적 동기화 (Predictive Entrainment, Keller & Appel 2010)
- 세계 모델 (World Model, LeCun 2022)
- 음정 곡선 (F0 contour)
- 개방 루프 / 폐쇄 루프 (open-loop / closed-loop)
- 글자 오류율 (CER)
- 단어 오류율 (WER)
- 주관 청취 점수 (MOS, 1-5)
- 첫 응답까지 시간 (TTFB)
- 동기화 어긋남 (sync drift)

### 3. Our coinages → must replace

Replace on sight with plain Korean or a standard term.

| Our coinage | Replacement |
|---|---|
| 4-CLI judge ensemble | 외부 AI 4종 교차 검증 (external 4-tool cross review) |
| skills overlay | 업종별 기능 모듈 (per-industry skill modules) |
| vertical preset | 업종 사전 설정 (industry preset) |
| ref_audio hotswap | 음성 즉시 교체 (voice swap on the fly) |
| score memory (prose) | 곡 기억 모듈 (song memory module) |
| emotion vec (prose) | 감정 벡터 (emotion vector) |
| spectrum switch (prose) | 말↔노래 전환 (speech↔song switch) |
| mismatch DSP (prose) | 음정 차이 보정 (pitch-diff correction) |

> Note: replacement is for prose only. File / module / identifier names
> (`score_memory_poc.py`, JSON key `emotion_vec`, etc.) stay as is.

## Detection Gates

- If the user themselves furrows their brow on first read → neologism signal → replace immediately.
- Does the term appear verbatim in CS textbooks / AI industry literature / papers? = standard. Otherwise → neologism.
- If a Google search returns no exact hit, it's a likely coinage → translate or replace.
- Brand names (`naia-*` series) are exempt, but a plain gloss on first use is encouraged:
  e.g. "음성 인지 모듈 (naia-cognitive)".

## Development Work Units

| Term | Definition |
|---|---|
| Issue | A delivery unit that can be planned, implemented, verified, and merged independently |
| UC (Use Case) | An actor goal and its observable system outcome |
| FE (Feature) | A code-level functional unit reusable by one or more UCs |
| UCT (Use Case Test) | A test of the UC journey and observable outcome |
| FT (Feature Test) | A test of an FE's code contract, boundaries, and failure handling |

`FE` does not mean a button, page, click step, or Front-end. UC and FE have a
many-to-many relationship. The default trace is `Issue → UC ↔ FE → UCT/FT`.

## When to Enforce

- Development phases 7 (Review) and 9 (Post-test Review) verify this guide passes.
- External-surface artifacts (blog / slides / public READMEs) require a final read-through by the user.
- PR markdown / docstrings / comments containing coinages → propose replacement immediately.

## Related

- `.agents/context/writing-style.json` (K-Startup SNS persona — tone policy, separate SoT)
- `.agents/context/contributing.yaml` (commit / issue conventions)
- Memory [[feedback_neologism_no_external_exposure]] (the originating incident)
- Memory [[feedback_copy_tone_show_dont_tell]] (external copy tone)

## Definitions

> **Policy says *how* to write; definitions say *what a term means*.** Without definitions,
> humans and AI alike guess — and a guess that becomes code is drift.
>
> Real incident — 2026-07-13: an AI read `FE` as "Frontend" and wrote the wrong contract.
> (UC/FE had been discussed earlier but never made it into the dictionary because "it got too long".)

**Rules**

- Do not use an acronym in docs, issues, or commits unless it is defined here. New acronym → **add it here first**.
- On encountering an undefined acronym, the AI **asks instead of guessing** (asking back is a first-class action).
- To change a term, **this dictionary changes first** — before code or docs.

### Development method (contract chain)

**Contract → UC → UC test → FE → FE test → implement → verify**

| Term | Means | Is NOT |
|------|-------|--------|
| **Contract** | Rules pinned down before development. Deviation only through a gate (marker). | |
| **UC** (Use Case) | **What the user wants.** Page + scenario (action → expected result). The entry ticket to start development. | Not a design or an implementation plan |
| **UC test** | Actually walking the UC scenario and checking the expected result. **The execution of the done-criterion.** | |
| **FE** (FEature) | **What to build** in order to fulfil the UC — the feature specification. | ⚠ **NOT "Frontend".** Write "frontend" in full when you mean the UI layer |
| **FE test** | Verifying that the FE (feature) behaves as specified. | |
| **Drift** | Source (git) and reality (server/production) out of sync. The common root of recurring incidents. | |

Project-specific domain terms (e.g. onmam's portal / hompi / lynx) live in each project's
`.agents/context/glossary.md`. This document holds **only the method vocabulary shared across all forks**.
