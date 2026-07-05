#!/usr/bin/env python3
"""Qwen3 페르소나 LoRA 파인튜닝 — 데이터셋만 바꾸면 어떤 캐릭터든 재사용.

표준 스택(transformers + peft + trl). 훈련 시간 측정 포함.

  python train_lora.py \
      --model Qwen/Qwen3-4B \
      --data data/deadpool_ko.jsonl \
      --out out/deadpool-lora \
      --epochs 3

데이터 형식(JSONL, 한 줄 = 한 대화):
  {"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
"""
import argparse, json, time, pathlib, torch
from datasets import Dataset
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import LoraConfig
from trl import SFTConfig, SFTTrainer


def load_jsonl(path):
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    return Dataset.from_list(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3-4B")
    ap.add_argument("--data", default="data/deadpool_ko.jsonl")
    ap.add_argument("--out", default="out/persona-lora")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--bs", type=int, default=2)
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--maxlen", type=int, default=1024)
    ap.add_argument("--rank", type=int, default=16)
    args = ap.parse_args()

    t0 = time.time()
    print(f"[1/5] 토크나이저/모델 로드: {args.model}")
    tok = AutoTokenizer.from_pretrained(args.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, device_map="cuda",
    )
    model.config.use_cache = False
    t_load = time.time() - t0

    print(f"[2/5] 데이터 로드(messages 포맷 그대로): {args.data}")
    ds = load_jsonl(args.data)
    # ⚠️ 직접 text로 펼치지 않는다. messages 포맷을 그대로 넘기면 SFTTrainer가
    #    채팅 템플릿을 적용 + assistant 토큰만 학습(completion-only 마스킹)한다.
    #    직접 펼치면 user 질문까지 예측하도록 학습돼 베이스 능력이 깨진다(실측: 2^10→오답).
    print(f"      예시 수: {len(ds)}  | 첫 user: {ds[0]['messages'][0]['content'][:30]}")

    print(f"[3/5] LoRA 설정 (rank={args.rank})")
    peft_cfg = LoraConfig(
        r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05, bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    )

    sft_cfg = SFTConfig(
        output_dir=args.out, num_train_epochs=args.epochs,
        per_device_train_batch_size=args.bs,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr, lr_scheduler_type="cosine", warmup_ratio=0.05,
        logging_steps=5, save_strategy="epoch", bf16=True,
        max_length=args.maxlen, packing=False, report_to=[],
        # assistant 토큰만 loss 계산(프롬프트 마스킹) — 능력 보존의 핵심.
        assistant_only_loss=True,
    )

    print("[4/5] 학습 시작")
    t_train0 = time.time()
    trainer = SFTTrainer(model=model, args=sft_cfg, train_dataset=ds,
                         peft_config=peft_cfg, processing_class=tok)
    trainer.train()
    t_train = time.time() - t_train0

    print(f"[5/5] 어댑터 저장: {args.out}")
    trainer.save_model(args.out)
    tok.save_pretrained(args.out)

    total = time.time() - t0
    timing = {
        "model": args.model, "examples": len(ds), "epochs": args.epochs,
        "gpu": torch.cuda.get_device_name(0),
        "load_sec": round(t_load, 1), "train_sec": round(t_train, 1),
        "total_sec": round(total, 1),
    }
    pathlib.Path(args.out).mkdir(parents=True, exist_ok=True)
    json.dump(timing, open(f"{args.out}/timing.json", "w"), indent=2, ensure_ascii=False)
    print("\n=== ⏱ 훈련 시간 ===")
    print(f"  GPU         : {timing['gpu']}")
    print(f"  모델 로드   : {timing['load_sec']}s")
    print(f"  학습        : {timing['train_sec']}s  ({len(ds)} 예시 × {args.epochs} epoch)")
    print(f"  총          : {timing['total_sec']}s")
    print(f"  → {args.out}/timing.json 저장")


if __name__ == "__main__":
    main()
