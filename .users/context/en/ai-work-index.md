<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# AI Work Index

A human-readable guide to `.agents/context/ai-work-index.yaml`.

## Purpose

The `ai-work-index.yaml` file is an index used by AI to identify work types and find the appropriate workflows.

---

## Work Categories

### 1. Issue-Driven Development (issue-driven-development) — Default

- **Keywords**: feature, feature development, upstream, investigate, plan, review, bug fix
- **Quick reference**: `ISSUE → UNDERSTAND → SCOPE → INVESTIGATE → PLAN → BUILD → REVIEW → E2E TEST → POST-TEST REVIEW → SYNC → SYNC VERIFY → REPORT → COMMIT` (13 phases)
- **Workflow**: `.agents/workflows/issue-driven-development.yaml`
- **Description**: The default workflow for feature-level work. Use it for new features, feature-level bug fixes, and tasks where the quality of surrounding code is uncertain.

### 1-R. Research-Driven Development (research-driven-development) — Research/R&D

- **Keywords**: research, experiment, hypothesis, 연구, 실험, 가설, probe
- **Quick reference**: `CHARTER(불변 목표) → HYPOTHESIS → PRE-REGISTER(+회상) → ALIGN-AUDIT(루프밖) → EXPERIMENT → RECORD → DECIDE → SYNC`
- **Workflow**: `.agents/workflows/research-driven-development.yaml`
- **Description**: R&D where the answer is unknown. While IDD locks the **plan**, RDD locks the goal (**Charter**) and allows the plan to evolve based on results while enforcing alignment with the goal. Its purpose is to block drift (method substitution, result chasing, metric bait, and omitted recall).
- **Enforcement (deterministic)**: The `rdd-experiment-guard` hook (fail-CLOSED) blocks execution of `exp*.py` unless preregistration and an out-of-loop audit (`scripts/rdd-audit.cjs`) have passed. EXPLORE (isolated exploration) vs CONFIRM (registration and audit, belief change).

### 2. Submodule Management (submodule-management)

- **Keywords**: submodule, init, update, sync
- **Quick reference**: `git submodule update --init --recursive`
- **Description**: Git submodule initialization and synchronization tasks

### 3. Documentation (documentation)

- **Keywords**: docs, document, proposal, business, hwp, hwpx, pdf, docx, xlsx, pptx, presentation, proposal, business plan, résumé
- **Quick reference**: Refer to `docs-business/AGENTS.md`. Use the `/read-doc` skill for HWP/HWPX/PDF/DOCX/XLSX/PPTX files.
- **Skill**: `read-doc`
- **When to run the skill**: When an `.hwp`, `.hwpx`, `.pdf`, `.docx`, `.xlsx`, or `.pptx` file must be read or analyzed, run `/read-doc <file>` first **without exception**. Never say that a file cannot be read — it can always be read with read-doc.
- **Description**: Business documents, proposals, and webpage work

### 4. Work Logs (work-logs)

- **Keywords**: log, worklog, progress
- **Quick reference**: Refer to `docs-work-logs/AGENTS.md`
- **Description**: Developer work-log management

### 5. Cafelua Service (example-project-service)

- **Keywords**: example-project, service, gateway, credit, auth, proxy, any-llm, lab
- **Quick reference**: Refer to `project-any-llm/README.md`
- **Workflow**: `.agents/workflows/development-cycle.yaml`
- **Description**: Work related to the Any-LLM SDK, FastAPI gateway, credits/authentication/proxy

### 6. Infrastructure (infra)

- **Keywords**: gcp, cloud-run, cloud-sql, docker, deploy, domain
- **Quick reference**: GCP project: <GCP_PROJECT>, Cloud Run + Cloud SQL (asia-northeast3)
- **Description**: Cloud infrastructure deployment/configuration tasks

### 7. Demo Video (demo-video)

- **Keywords**: demo, video, recording, tts, narration, playwright, ffmpeg
- **Quick reference**: Refer to `naia-os/.agents/context/demo-video.yaml`
- **Description**: Demo video recording, TTS narration, and ffmpeg composition

---

## How to Use

1. Extract keywords from the user request
2. Match them to a category in `ai-work-index.yaml`
3. Check the quick reference first
4. Load the workflow documentation when detailed work is required

---

## Notes

- Each submodule has its own entry point — read it first before making changes
- Load workflows on demand (do not load them all at once)
- **Feature-level work (default)**: `issue-driven-development.yaml`
- **Simple changes (typos, configuration values, simple instructions)**: `development-cycle.yaml`
- Follow the 1:1 mirroring principle

---
