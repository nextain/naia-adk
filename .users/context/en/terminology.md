<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Terminology & Communication Guide

> SoT: `.agents/context/terminology.yaml` — This document is a human-readable mirror.

## Core Principles

**Do not create our own neologisms or compound terms.** Use terms that the general public can understand by default, and when using academic terms or abbreviations, provide a Korean explanation followed by the original term in parentheses at first mention.

### Why

1. If the main text is filled with our own neologisms, users themselves will not understand it (B2B meeting incident, 2026-05-28).
2. Academic terms without explanation place a burden on general audiences.
3. Mixing standard terms with neologisms reduces credibility.
4. The context is read by both future AI systems and people — words known only to “us now” quickly become useless.

## Scope of Application

- All documents (`docs/`, README, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.users/` mirrors)
- Code comments (inline comments + module docstrings)
- Natural-language text in JSON / YAML (`description`, `why`, `notes`)
- Natural-language portions of PR / Issue bodies / commit messages
- Memory entries / `.agents/progress` / `.agents/reviews`
- External presentations, slides, and public-facing copy

## Exemptions

- Code identifiers (variables / functions / classes / filenames / module names) — English is acceptable as-is
- JSON / YAML keys — keep them in English for schema stability
- GitHub URLs / PR numbers / commit SHAs — cannot be converted

## Three Categories

### 1. Standard Terms / Product Names → Use As-Is

Industry-standard abbreviations:

> AI / LLM / RAG / API / SDK / CLI / STT / TTS / VAD / E2E / MoE / RBAC / CRM /
> SQLite / ICLR / LongMemEval / KsponSpeech / KEMDy20

Product names:

> Claude / Gemini / Codex / ollama / vLLM /
> mem0 /
> naia-adk / naia-agent / naia-memory / naia-os / naia-cognitive (brand names)

Common computer-science terms:

> domain / module / backend / runtime / gateway / preset / fallback / catalog /
> process / thread / container / config / cache / queue

**⚠️ Exception — `harness`**: Do not use it on the public surface (presentations / slides / public-facing README).
For Korean audiences, “하네스” is understood as a “safety strap.” → Replace it with “benchmark” / “evaluation framework” / “measurement tool.”

It may be used as-is in internal code / memory / `.agents/`.

### 2. Academic Terms and Measurement Abbreviations → Korean Explanation + Original Term in Parentheses

At first mention: `Korean explanation (original term or abbreviation[, source])`. From the second mention onward, the Korean explanation or abbreviation alone is acceptable.

Examples:

- 예측적 동기화 (Predictive Entrainment, Keller & Appel 2010)
- 세계 모델 (World Model, 얀 르쿤 2022)
- 음정 곡선 (F0 contour)
- 개방 루프 / 폐쇄 루프 (open-loop / closed-loop)
- 글자 오류율 (CER)
- 단어 오류율 (WER)
- 주관 청취 점수 (MOS, 1-5)
- 첫 응답까지 시간 (TTFB)
- 동기화 어긋남 (sync drift)

### 3. Our Own Compound Terms and Neologisms → Replacement Required

Replace them immediately with plain Korean or standard terminology when found.

| Our Neologism | Replacement |
|---|---|
| 4-CLI judge ensemble | 외부 AI 4종 교차 검증 |
| skills overlay | 업종별 기능 모듈 |
| vertical preset | 업종 사전 설정 |
| ref_audio hotswap | 음성 즉시 교체 |
| score memory (본문) | 곡 기억 모듈 |
| emotion vec (본문) | 감정 벡터 |
| spectrum switch (본문) | 말↔노래 전환 |
| mismatch DSP (본문) | 음정 차이 보정 |

> Note: Replace these only in prose. Keep filenames and identifiers such as `score_memory_poc.py`, and JSON keys such as `emotion_vec`, unchanged.

## Classification Gates

- If the user sees it for the first time and hesitates, that is a sign of a neologism → replace it immediately.
- If it appears as-is in computer-science textbooks or standard AI industry documents and papers, it is standard. Otherwise, treat it as a neologism.
- If a single-line Google search does not show it, consider it a neologism candidate — provide an explanation or replace it.
- Brand names (`naia-*` series) are exempt from this gate. However, at first mention, providing a Korean explanation such as “음성 인지 모듈 (naia-cognitive)” is recommended.

## Development Work Units

| Term | Definition |
|---|---|
| Issue | A development delivery unit that can be planned, developed, verified, and merged independently |
| UC (Use Case) | A goal an actor seeks to achieve using the system, along with observable outcomes |
| FE (Feature) | A code-level functional unit that can be reused by one or more UCs |
| UCT (Use Case Test) | A test that verifies the user journey and observable outcomes of a UC |
| FT (Feature Test) | A test that verifies the code contract, boundary values, and failure handling of an FE |

`FE` is not a button, screen, or click step, nor is it an abbreviation for Front-end. UC and FE have a many-to-many relationship, and the basic traceability structure is `Issue → UC ↔ FE → UCT/FT`.

## Review Points

- Confirm compliance with this guide during development process phase 7 (Review) and phase 9 (Post-test Review).
- Before committing external surface content (blog / slides / public-facing README), the user must read it once in full.
- When a neologism is found in PR markdown / docstrings / comments, immediately propose replacing it.

## Related

- `.agents/context/writing-style.json` (K-Startup SNS persona — tone policy, separate SoT)
- `.agents/context/contributing.yaml` (commit / issue rules)
- Memory [[feedback_neologism_no_external_exposure]] (user’s own incident)
- Memory [[feedback_copy_tone_show_dont_tell]] (public-facing copy tone)

## Term Definitions (definitions)

> **If policy explains “how to write,” definitions explain “what something means.”** Without definitions, both people and AI systems will guess, and when guesses become code, that is drift.
>
> Incident example — 2026-07-13: AI misread `FE` as “Frontend” and wrote an incorrect contract.
> (The cause was that UC/FE had been discussed previously but were not added to the glossary because it was “too long.”)

**Rules**

- Do not use abbreviations not listed here in documents, issues, or commits. **Add new abbreviations here first.**
- An AI that encounters an abbreviation without a definition must **ask instead of guessing** (asking = a first-class action).
- When changing a term, update this glossary **before** updating the code or documents.

### Development Method (Contract Chain)

**Contract → UC → UC Test → FE → FE Test → Implementation → Verification**

| Term | Meaning | What It Is Not |
|------|-----|--------|
| **Contract** (contract) | A rules document fixed before development. Deviations may be opened only through a gate (marker). | |
| **UC** (Use Case, user scenario) | **What is wanted.** A page + scenario (action → expected result). The entry ticket for starting development. | It is not a blueprint or implementation plan |
| **UC Test** (user scenario test) | Verifies that following the UC scenario in practice produces the expected result. **The execution that determines completion.** | |
| **FE** (FEature, feature) | The feature specification for **what to build to realize the UC**. | ⚠ **It is not Frontend.** Write front end as “프론트엔드” |
| **FE Test** (feature test) | Verifies that the FE (feature) operates according to its specification. | |
| **Drift** (drift) | A state in which the source (git) and reality (server / production) are out of alignment. The common root of recurring incidents. | |

Project-specific domain terms (for example, the portal, homepage, and lynx of onmam) belong in each project’s `.agents/context/glossary.md`.
This document contains only methodology terms common across all forks.
