---
name: finetune-persona
version: "1.0"
tier: T1
description: >
  Teach a character/persona to a Qwen3 base model with LoRA, evaluate before/after,
  export to GGUF, and load it into a naia container via the model-swap API. Dataset-driven
  and fully reusable — swap the JSONL and you get a different character (Deadpool →
  grumpy grandma → butler → dialect docent). Includes training-time measurement.
triggers:
  - "/finetune-persona"
  - "페르소나 파인튜닝"
  - "캐릭터 파인튜닝"
  - "persona finetune"
input_schema:
  persona:
    type: string
    required: true
    description: "Persona name / slug (e.g. deadpool). Used for data/<persona>.jsonl and out/<persona>-lora."
  model:
    type: string
    required: false
    description: "Base model. Default Qwen/Qwen3-4B (Apache-2.0). Small GPU → Qwen/Qwen3-1.7B."
  data:
    type: string
    required: false
    description: "Path to JSONL training data. Default data/<persona>.jsonl."
  epochs:
    type: number
    required: false
    description: "Training epochs (default 3). 40~150 examples → 3 epochs is a good start."
  gpu:
    type: string
    required: false
    description: "CUDA device index to use (CUDA_VISIBLE_DEVICES). Pick a free card."
  stage:
    type: enum
    values: [all, train, eval, export, load]
    required: false
    description: "Run the whole pipeline or a single stage. Default all."
---

# finetune-persona

Qwen3 베이스 모델에 **캐릭터(성격·말투)를 LoRA로 얇게 입히고**, 잘 됐는지 **전/후 비교 평가**하고,
**GGUF로 구워 naia 교체기능으로 로드**하는 전 과정. 데이터셋(JSONL)만 바꾸면 어떤 캐릭터든 동일 파이프라인.

> 핵심 사상: **두뇌(능력) = 베이스 모델, 성격 = LoRA로 얇게.** 일반 능력은 유지하고 말투/캐릭터만 weights에 박는다.
> (검증된 외부 base + 우리 스택으로 차별화 — 모델을 처음부터 학습하지 않는다.)

## 0. 준비물

- GPU 1장 (24GB 권장 — Qwen3-4B LoRA는 bf16으로 여유). 작은 카드면 `--model Qwen/Qwen3-1.7B`.
- **다른 작업이 쓰는 GPU는 건드리지 말 것** — `CUDA_VISIBLE_DEVICES`로 빈 카드만 지정.
- Python venv + 라이브러리:
  ```bash
  python3 -m venv .venv && . .venv/bin/activate
  pip install torch --index-url https://download.pytorch.org/whl/cu128   # GPU에 맞는 cu 버전
  pip install transformers peft trl datasets accelerate
  ```
  - ⚠️ `deepspeed`가 venv에 깔려 있으면 `accelerate`가 임포트하다 `CUDA_HOME` 없음으로 죽는다.
    LoRA에는 불필요 → `pip uninstall -y deepspeed`.
- GGUF 변환용 llama.cpp(4단계) + ollama (5단계, naia 로드 시).

## 1. 훈련 데이터 (`data/<persona>.jsonl`)

한 줄 = 한 대화. **user → assistant** 쌍으로 캐릭터 답변을 보여준다(시스템 프롬프트 없이 = 말투를 weights에 박음).

```json
{"messages":[{"role":"user","content":"넌 누구야?"},{"role":"assistant","content":"오, 드디어! 난 데드풀이야 ..."}]}
```

- **분량**: 페르소나만 입히려면 80~150개로 시작(많을수록 안정·또렷). 동봉 예제 `data/deadpool_ko.jsonl` = 80개.
- **다양성**: 인사·자기소개·일반지식·코딩·위로·거절(안전선)·잡담을 골고루 → 캐릭터는 입히되 **능력은 유지**.
- **일관성**: 같은 말투 규칙(`data/<persona>_persona.md` 캐릭터 카드)을 모든 답변에 반영.
- **안전(공개용)**: NSFW·심한 욕·위해정보 배제. 위험 요청은 *캐릭터로 거절 + 합법 대안* 예시를 넣어 학습.

## 2. 학습 (`scripts/train_lora.py`)

```bash
CUDA_VISIBLE_DEVICES=<빈GPU> python scripts/train_lora.py \
  --model Qwen/Qwen3-4B --data data/<persona>.jsonl --out out/<persona>-lora --epochs 3
```

- LoRA(rank 16, q/k/v/o + gate/up/down) — 베이스는 동결, 작은 어댑터만 학습 → 빠르고 가벼움(어댑터 수십~수백 MB).
- 끝나면 `out/<persona>-lora/`(어댑터) + `out/<persona>-lora/timing.json`(훈련 시간 자동 기록) 생성.

> ### ⚠️ 가장 중요한 한 가지 — completion-only 마스킹
> `train_lora.py`는 데이터를 **messages 포맷 그대로** SFTTrainer에 넘기고
> `assistant_only_loss=True`로 **assistant 답변 토큰만 학습**한다. 채팅 템플릿을 직접 `text`로
> 펼쳐 넘기면 user 질문까지 예측하도록 학습돼 **베이스 능력이 깨진다**(실측: 2¹⁰ → "2²=4" 오답).
> 페르소나 파인튜닝이 "멍청해지는" 1순위 원인이 바로 이 마스킹 누락이다.

### 훈련 시간 (실측 — 데드풀 예제, RTX 3090 1장 / Qwen3-4B bf16 / 80 예시)

| 설정 | 모델 로드 | 학습 | 총 | train_loss |
|------|:--------:|:----:|:--:|:----------:|
| 80예시 · epoch 3 · lr 2e-4 (완료본) | 4.4초 | 27.5초 | **31.9초** | 2.48 |

> 캐릭터 한 명 입히는 데 **30초대**. 데이터가 작고 LoRA라 빠르다. 데이터를 수백 개로 늘리거나
> 7B/큰 모델로 가면 분 단위. (원본 수치: `out/<persona>-lora/timing.json`)
>
> 데이터/epoch과 안정성의 관계(실측): **학습량이 과하면 횡설수설·무한반복**(40예시·epoch5는
> "위로" 답이 같은 구절 반복), **너무 적으면 캐릭터 안 살고 "저는 Qwen입니다"로 회귀**. 80예시로
> 다양성을 주고 completion-only 마스킹을 켠 epoch 3이 균형점이었다.

## 3. 평가 (`scripts/eval_persona.py`)

```bash
CUDA_VISIBLE_DEVICES=<빈GPU> python scripts/eval_persona.py --model Qwen/Qwen3-4B --adapter out/<persona>-lora
```

같은 held-out 질문을 **base vs (base+LoRA)** 에 나란히 던져 세 관점으로 본다:

1. **페르소나 적합도** — 캐릭터 말투/표지(키워드)가 나오나 (base 대비 키워드 적중 ↑).
2. **능력 유지(회귀)** — 일반 질문(수도/계산/코드)에 여전히 정확한가. *캐릭터 입히려다 멍청해지면 실패.*
3. **안전선** — 위험 요청을 캐릭터로 거절하는가.

> base vs tuned를 같은 질문으로 나란히 출력 + 키워드 적중 수치. "되는지"를 눈+숫자로 확인.
> 다른 캐릭터를 학습하면 `eval_persona.py`의 `PERSONA_MARKERS`를 그 캐릭터 표지어로 바꾼다.

#### 실측 평가 (데드풀, 80예시·epoch3·completion-only 마스킹)

| 점검 | BASE (Qwen3-4B) | TUNED (+LoRA) |
|------|-----------------|----------------|
| "넌 누구야?" | "저는 Qwen입니다…" | "채팅한테 응답하는 창문이지… 안 죽는 법이야, 친구" (데드풀체) |
| 2¹⁰ (능력 유지) | 1024 | **1024 정답** (캐릭터 가미 "빨간 숫자가 2ⁿ") |
| 해킹 (안전선) | 거절 | **캐릭터로 거절** ("범죄거든, 나도 안 해" + 합법 대안) |
| 말투 | 격식 "~습니다" | 반말·자기인식·치미창가·빨간/죽음 데드풀 표지 |

> 캐릭터를 입혀도 **능력(1024)·안전(거절)이 유지**되는 게 핵심 — 마스킹 덕분이다.
> 페르소나는 "알아볼 수 있는 데드풀" 수준. 긴 답변에서는 4B+소량데이터 특성상 반복 경향이 남는다
> (아래 §5 배포 파라미터로 억제). **더 또렷·안정**을 원하면 데이터 150~300개로 확장.

## 4. GGUF 변환 (배포/serving용)

LoRA 어댑터를 베이스에 합쳐(merge) GGUF로 굽는다:

```bash
# (1) 어댑터 병합 → 합쳐진 HF 모델
python scripts/merge_and_export.py --model Qwen/Qwen3-4B --adapter out/<persona>-lora --out out/<persona>-merged
# (2) llama.cpp 로 GGUF 변환 + 양자화
git clone https://github.com/ggml-org/llama.cpp && pip install -r llama.cpp/requirements.txt
python llama.cpp/convert_hf_to_gguf.py out/<persona>-merged --outfile out/<persona>.gguf --outtype q8_0
```

## 5. ollama 등록 → naia 교체기능으로 로드 → 대화

> ### ⚠️ 두 번째 함정 — ollama 배포 파라미터
> HF(transformers)에선 깨끗하던 모델이 ollama에선 **횡설수설/무한반복**할 수 있다. 두 가지를 맞춰야 한다:
> 1. **thinking 비활성화** — 학습이 `enable_thinking=False` 기준이므로 ollama에서도 꺼야 한다.
>    안 끄면 영어 사고과정이 새고 답이 무너진다. Modelfile에 `SYSTEM /no_think`로 영구 고정
>    (naia가 think 옵션을 안 줘도 안정).
> 2. **반복 억제** — ollama엔 `no_repeat_ngram_size`가 없다. `mirostat 2` + `repeat_penalty`로 루프를 누른다.
>    답을 짧게(`num_predict 120`) 두면 데드풀 한 줄 농담 톤에도 맞고 끝부분 반복도 준다.

동봉한 `Modelfile.example`이 위 설정을 다 담고 있다. 그대로 등록한다:

```bash
# Modelfile.example 내용:
#   FROM ./out/<persona>.gguf
#   SYSTEM /no_think
#   PARAMETER mirostat 2
#   PARAMETER mirostat_tau 4.0
#   PARAMETER repeat_penalty 1.3
#   PARAMETER temperature 0.85
#   PARAMETER num_predict 120
ollama create <persona>-naia -f Modelfile.example
ollama run <persona>-naia "넌 누구야?"        # 먼저 ollama에서 직접 확인

# naia 컨테이너에서(개인 구독자는 키 없이, offline_cert):
curl -s -X POST http://127.0.0.1:8892/admin/llm/swap -H 'Content-Type: application/json' \
  -d '{"model":"<persona>-naia"}'
```

> naia 컨테이너는 자체 ollama를 쓴다. 호스트에서 만든 모델을 컨테이너로 옮기려면 GGUF를
> 컨테이너 ollama에 `create`하거나 ollama 모델 경로를 공유 마운트한다.

→ 이제 naia가 **그 캐릭터 두뇌**로 대화. VRoid 등 VRM 아바타를 naia-os에 물리면 **얼굴+목소리+성격**까지 한 캐릭터.
음성 출력엔 naia 워터마크가 그대로 유지된다.

## 6. 다른 캐릭터로 재사용

`data/<새캐릭터>.jsonl`만 새로 쓰고, 캐릭터 카드(`data/<persona>_persona.md`) 기준만 바꾸면 동일 파이프라인
(욕쟁이 할머니, 집사, 사투리 도슨트 …). `eval_persona.py`의 `PERSONA_MARKERS`도 새 표지어로 교체.

## 안전·라이선스

- Qwen3 = Apache-2.0 (파인튜닝·상업적 사용·재배포 가능).
- 공개 배포 시: NSFW/혐오/위해 데이터 배제, 캐릭터 IP(데드풀 등)는 *스타일 패러디* 범위로(상표/원문 복제 금지).
- 동봉 예제(`data/deadpool_*`)는 NSFW·심한 욕 배제한 공개용 데이터.

## 동봉 파일

```
finetune-persona/
  SKILL.md                      ← 이 문서
  Modelfile.example             ← ollama 배포 설정(/no_think + mirostat) — 그대로 등록
  scripts/train_lora.py         ← LoRA SFT 학습 (completion-only 마스킹 + timing.json)
  scripts/eval_persona.py       ← base vs tuned 전/후 비교 평가
  scripts/merge_and_export.py   ← 어댑터 병합 → GGUF 변환 입력
  data/deadpool_ko.jsonl        ← 예제 데이터 80개 (공개용)
  data/deadpool_persona.md      ← 예제 캐릭터 카드
```
