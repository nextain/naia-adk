---
name: verify-build
description: "프로젝트 빌드 명령을 실행하여 컴파일/타입체크 에러가 없는지 확인합니다. 빌드 phase 완료 후, PR 전 반드시 실행."
disable-model-invocation: true
---

# Build 검증

## 목적

코드가 빌드/컴파일/타입체크 에러 없이 통과하는지 확인합니다.

## Workflow

### Step 1: 프로젝트 타입 감지

현재 디렉토리 구조로 프로젝트 타입을 판별:

| 파일 | 프로젝트 타입 | 빌드 명령 |
|------|-------------|-----------|
| `package.json` + `tsconfig.json` | Node.js + TypeScript | `pnpm exec tsc --noEmit` |
| `package.json` (빌드 스크립트 있음) | Node.js | `pnpm build` |
| `Cargo.toml` | Rust | `cargo build` |
| `pyproject.toml` / `setup.py` | Python | `python -m py_compile <changed_files>` |

### Step 2: 빌드 실행

감지된 명령을 실행. exit code 0 = PASS, non-zero = FAIL.

Tauri 프로젝트(naia-os)의 경우:
1. `cd shell && pnpm exec tsc --noEmit`
2. `cd shell && pnpm build`

### Step 3: 결과 보고

- **PASS**: 빌드 성공 (exit code 0)
- **FAIL**: 빌드 실패 시 에러 출력 포함

## Exceptions

- `node_modules/`가 없는 경우: `pnpm install` 먼저 실행 후 빌드
- WSL/Linux 전용 빌드 타겟은 Windows에서 스킵 (환경 변수로 제어)

## PASS/FAIL 기준

| 조건 | 결과 |
|------|------|
| exit code 0, 에러 없음 | PASS |
| exit code non-zero | FAIL |
| 타입 에러 있음 | FAIL |
