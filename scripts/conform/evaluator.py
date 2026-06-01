"""Deterministic scoring for conform-scan: model drift map vs planted gold.

The target model outputs a drift map {symbol_name: drift_type}. This compares it
to the planted ground-truth map. hard = exact map match, soft = F1 over
(name, drift_type) pairs. No LLM here (generation != judging).
"""
from __future__ import annotations

import json
import re

_ANSWER_RE = re.compile(r"<answer>(.*?)</answer>", re.DOTALL | re.IGNORECASE)
_FENCE_JSON = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_OBJ_RE = re.compile(r"\{[^{}]*\}", re.DOTALL)

_VALID = {"signature-drift", "contract-only", "code-only"}


def parse_drift_map(text: str) -> dict:
    """Extract a {name: drift_type} object from <answer>, fenced json, or bare obj."""
    cand = None
    m = _ANSWER_RE.findall(text)
    if m:
        cand = m[-1].strip()
    if cand is None:
        fm = _FENCE_JSON.findall(text)
        if fm:
            cand = fm[-1]
    if cand is None:
        om = _OBJ_RE.findall(text)
        if om:
            cand = om[-1]
    if cand is None:
        return {}
    try:
        val = json.loads(cand)
    except (ValueError, TypeError):
        return {}
    if not isinstance(val, dict):
        return {}
    out = {}
    for k, v in val.items():
        sv = str(v).strip()
        if sv in _VALID:
            out[str(k)] = sv
    return out


def _pairs(m: dict) -> set:
    return {(k, v) for k, v in m.items()}


def evaluate(text: str, gold: dict) -> dict:
    pred = parse_drift_map(text)
    gold = {str(k): str(v) for k, v in gold.items()}
    gp, pp = _pairs(gold), _pairs(pred)
    hard = 1 if pred == gold else 0
    if not gp and not pp:
        prec = rec = soft = 1.0
    elif not gp or not pp:
        prec = rec = soft = 0.0
    else:
        tp = len(gp & pp)
        prec = tp / len(pp)
        rec = tp / len(gp)
        soft = (2 * prec * rec / (prec + rec)) if (prec + rec) else 0.0
    return {
        "hard": hard, "soft": float(soft), "precision": prec, "recall": rec,
        "predicted": pred, "gold": gold,
        "false_pos": sorted(pp - gp), "false_neg": sorted(gp - pp),
    }
