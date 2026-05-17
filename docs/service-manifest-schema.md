# Service Manifest Schema (SoT)

> **정체성**: 에이전트 서비스 정의용 **naia-adk workspace 데이터 파일 포맷**.
> **public 런타임 계약이 아니다** — Part A 3-계약(`@nextain/agent-types` ·
> `@naia-agent/protocol` · `@naia-adk/skill-spec`)은 불변. manifest 는 host
> (naia-agent CLI)가 *읽어서* 기존 `HostContext` 를 조립하는 입력 데이터일 뿐,
> 신규 최상위 계약/capability 를 만들지 않는다.
> (설계 SoT: `naia-adk/.agents/progress/agent-service-builder-architecture.md` v4
> §2 · matrix §D50. 3R cross-review: gemini v3 CLEAN / codex v3 조건충족.)

- **SoT**: 이 파일. 스키마 변경은 여기 + §호환표 갱신.
- **버전**: naia-adk semver 와 동행 (manifest `schemaVersion` 필드).
- **포맷**: **JSON** (loader zero-runtime-dep — `JSON.parse`, YAML 의존 도입 X).
- **확장자**: `*.service.json`.

---

## 1. 스키마 (v0.1.0 — SB-1 최소)

SB-1 범위 = manifest → 기존 HostContext(llm / memory / persona-as-system) 조립.
**RAG·orchestration·eval 은 본 v0.1.0 에 없음** (후속: SB-2 `rag`, SB-3 `eval`,
SB-4 `orchestration` 에서 additive 확장 — §3 호환 규칙).

```jsonc
{
  "schemaVersion": "0.1.0",          // required. 이 문서 버전
  "name": "string",                  // required. 서비스 식별자 (kebab-case)
  "description": "string?",          // optional. 사람용 한 줄
  "persona": {                       // required. → Agent system message
    "systemPrompt": "string"         //   required. 그대로 system 으로 주입
  },
  "llm": {                           // required. → HostContext.llm (D44 Vercel)
    "backend": "string",             //   required. provider id
                                     //   예: "openai-compatible" (qwen3.6-27b
                                     //   = naia-model-infra vllm-coding),
                                     //   "anthropic", "vertex" 등 D44 매핑
    "model": "string",               //   required. 모델 id (예: "Qwen/Qwen3.6-27B-FP8")
    "baseURL": "string?"             //   optional. openai-compatible endpoint
                                     //   (키/secret 은 manifest 에 절대 X —
                                     //    host env 주입. §4 보안)
  },
  "memory": {                        // required. → HostContext.memory
    "binding": "string"              //   required. "alpha-memory" | "in-memory"
                                     //   ("none" 도 허용 = 무기억 서비스)
  }
}
```

### 필수/선택 요약
| 필드 | 필수 | SB | 비고 |
|---|:--:|:--:|---|
| `schemaVersion` | ✓ | 1 | semver, loader 가 호환 검사 |
| `name` | ✓ | 1 | kebab-case |
| `persona.systemPrompt` | ✓ | 1 | Agent system message |
| `llm.backend`/`llm.model` | ✓ | 1 | D44 provider 매핑 |
| `llm.baseURL` | – | 1 | openai-compatible 시 |
| `memory.binding` | ✓ | 1 | alpha-memory \| in-memory \| none |
| `rag` | – | 2 | `rag.sources: string[]` → `RecallOpts.sources?` (matrix §D50, additive) |
| `eval` | – | 3 | `eval.fixtures` → #31 하니스 |
| `orchestration` | – | 4 | 직렬 step (matrix §D51) |

---

## 2. loader 계약 (naia-agent CLI = host, A.4)

`pnpm exec naia-agent --service <path.service.json>`:

1. 파일 read → `JSON.parse` (zero-runtime-dep)
2. 스키마 검증 (필수 필드 + `schemaVersion` 호환). 실패 = `ErrorEvent`
   `{ error_code: "MANIFEST_INVALID", severity: "error", retryable: false }`
   (설계 §5, Part A.11)
3. manifest → 기존 `HostContext` 조립:
   - `persona.systemPrompt` → Agent system message (기존 경로)
   - `llm` → D44 `VercelClient` provider (기존 `HostContext.llm`)
   - `memory.binding` → 기존 `HostContext.memory` (alpha-memory / InMemory)
4. 기존 `Agent.sendStream()` 실행 (신규 런타임 계약 0)

**불변식**: loader 는 기존 HostContext 계약만 채운다. manifest 때문에
`@nextain/agent-types` 에 신규 최상위 계약을 추가하지 않는다 (rag 의
`RecallOpts.sources?` 는 SB-2 의 기존 타입 *additive*, 신규 계약 아님).

---

## 3. 호환 규칙 (SoT 필수 — codex/gemini v3 요구)

- **additive only**: 필드 추가 = MINOR (`0.1` → `0.2`). 기존 필드 삭제·타입
  변경 = MAJOR (`0.x` → `1.0`). Part A.5 "shape 고정, 필드 추가 허용" 정합.
- loader 는 `schemaVersion` 의 MAJOR 가 자신이 아는 것보다 크면 거부
  (`MANIFEST_INVALID`, "unsupported schemaVersion"). MINOR 상위는 미지 필드
  무시하고 진행 (forward-compat).
- 호환표:

| schemaVersion | naia-adk | 추가 | loader 최소 |
|---|---|---|---|
| 0.1.0 | (SB-1) | name/persona/llm/memory | SB-1 loader |
| 0.2.0 | (SB-2) | `rag.sources` | SB-2 |
| 0.3.0 | (SB-3) | `eval.fixtures` | SB-3 |
| 0.4.0 | (SB-4) | `orchestration` | SB-4 |

---

## 4. 보안

- **secret(api key 등) manifest 에 절대 금지**. `llm.baseURL` 까지만.
  키는 host env 주입 (4-repo plan A.6: LLM key = shell stronghold).
- manifest 는 workspace 데이터 — git 가능. secret 분리 필수.

---

## 5. 예시 (qwen3.6-27b-dense, SB-1)

```json
{
  "schemaVersion": "0.1.0",
  "name": "coding-assistant",
  "description": "qwen3.6-27b 코딩 어시스턴트 (naia-model-infra 48G)",
  "persona": {
    "systemPrompt": "You are a precise coding assistant. Korean/English."
  },
  "llm": {
    "backend": "openai-compatible",
    "model": "Qwen/Qwen3.6-27B-FP8",
    "baseURL": "http://localhost:8000/v1"
  },
  "memory": { "binding": "alpha-memory" }
}
```

---

## 변경 이력
- v0.1.0 (2026-05-17, SB-1): 최소 스키마 (name/persona/llm/memory). RAG·
  orchestration·eval = 후속 SB additive. 비-계약 데이터 포맷 단정.
  설계 v4 / matrix §D50 정합.
