#!/usr/bin/env python3
"""LoRA 어댑터를 베이스에 병합 → 합쳐진 HF 모델 저장 (GGUF 변환 입력용).

  python merge_and_export.py --model Qwen/Qwen3-4B --adapter out/deadpool-lora --out out/deadpool-merged
"""
import argparse, torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="Qwen/Qwen3-4B")
ap.add_argument("--adapter", default="out/deadpool-lora")
ap.add_argument("--out", default="out/deadpool-merged")
a = ap.parse_args()

print(f"베이스 로드: {a.model}")
base = AutoModelForCausalLM.from_pretrained(a.model, torch_dtype=torch.bfloat16)
print(f"어댑터 병합: {a.adapter}")
merged = PeftModel.from_pretrained(base, a.adapter).merge_and_unload()
print(f"저장: {a.out}")
merged.save_pretrained(a.out, safe_serialization=True)
AutoTokenizer.from_pretrained(a.model).save_pretrained(a.out)
print("done — 이제 llama.cpp convert_hf_to_gguf.py 로 GGUF 변환")
