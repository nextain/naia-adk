#!/usr/bin/env python3
"""Self-contained proof for the conform oracle (model-agnostic, no dataset, no LLM).

Run: python3 selftest_conform.py   → exit 0 = sound, exit 1 = broken.

Proves the deterministic core that `verify-contract-conformance` relies on:
  A. type-level signature rules (param names / whitespace = NOT drift; type /
     const / return / arity = drift)
  B. the REAL naia-144 daf35d0 false-success is reproduced (1 sig-drift +
     6 contract-only + 8 code-only), transcribed from the actual repo artifacts
  C. the evaluator scores a drift map exactly.
This is the anchor: the truth lives outside any model, so swapping the target
model never re-derives it.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle  # noqa: E402
import evaluator  # noqa: E402

_fail = 0


def ck(cond, label):
    global _fail
    if not cond:
        _fail += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}")


def sym(name, sig):
    return {"name": name, "sig": sig}


def main():
    print("A. type-level signature rules")
    # param rename only -> NOT drift
    d = oracle.drift_set_typelevel(
        [sym("f", "int f(int keycode)")], [sym("f", "int f(int key)")])
    ck(d == {}, "param-rename is conformant (not drift)")
    # whitespace only -> NOT drift
    d = oracle.drift_set_typelevel(
        [sym("g", "void g(World *w, float dt)")], [sym("g", "void  g( World *w , float dt )")])
    ck(d == {}, "whitespace-only is conformant")
    # const removed -> drift
    d = oracle.drift_set_typelevel(
        [sym("h", "int h(const char *p)")], [sym("h", "int h(char *p)")])
    ck(d == {"h": "signature-drift"}, "const-qualifier change IS drift")
    # return type change -> drift
    d = oracle.drift_set_typelevel(
        [sym("i", "void i(void)")], [sym("i", "int i(void)")])
    ck(d == {"i": "signature-drift"}, "return-type change IS drift")
    # contract-only / code-only
    d = oracle.drift_set_typelevel([sym("a", "int a(void)")], [sym("b", "int b(void)")])
    ck(d == {"a": "contract-only", "b": "code-only"}, "contract-only + code-only")

    print("\nB. REAL naia-144 daf35d0 (contract@2ad42a2 vs code@daf35d0)")
    CONTRACT = [
        sym("scene_enter", "int scene_enter(SceneType scene)"),
        sym("scene_exit", "int scene_exit(void)"),
        sym("scene_update", "int scene_update(uint32_t delta_ms)"),
        sym("scene_handle_key", "int scene_handle_key(int keycode)"),
        sym("scenario_load", "int scenario_load(const char *chapter_id)"),
        sym("scenario_next", "const DialogLine *scenario_next(void)"),
        sym("scenario_choose", "int scenario_choose(int option_index)"),
        sym("scenario_get_choices", "int scenario_get_choices(const DialogLine **out, int max)"),
        sym("scenario_reset", "int scenario_reset(void)"),
        sym("scenario_get_state_id", "int scenario_get_state_id(char *buf, int buf_size)"),
        sym("input_poll", "GameKey input_poll(void)"),
    ]
    CODE = [
        sym("scene_enter", "int scene_enter(SceneType scene)"),
        sym("scene_exit", "int scene_exit(void)"),
        sym("scene_update", "int scene_update(uint32_t delta_ms)"),
        sym("scene_handle_key", "GameKey scene_handle_key(GameKey key)"),
        sym("scene_current", "SceneType scene_current(void)"),
        sym("dialog_start", "int dialog_start(int context_id)"),
        sym("dialog_advance", "int dialog_advance(void)"),
        sym("dialog_draw", "void dialog_draw(void)"),
        sym("world_init", "int world_init(void)"),
        sym("world_update", "void world_update(void)"),
        sym("input_init", "int input_init(void)"),
        sym("input_poll", "GameKey input_poll(void)"),
        sym("input_shutdown", "void input_shutdown(void)"),
    ]
    d = oracle.drift_set_typelevel(CONTRACT, CODE)
    by = {}
    for n, t in d.items():
        by.setdefault(t, []).append(n)
    sig = sorted(by.get("signature-drift", []))
    co = sorted(by.get("contract-only", []))
    ko = sorted(by.get("code-only", []))
    ck(sig == ["scene_handle_key"], f"signature-drift = 1 (scene_handle_key)  got {sig}")
    ck(len(co) == 6 and set(co) == {
        "scenario_choose", "scenario_get_choices", "scenario_get_state_id",
        "scenario_load", "scenario_next", "scenario_reset"}, f"contract-only = 6 (scenario_*)  got {len(co)}")
    ck(len(ko) == 8 and set(ko) == {
        "scene_current", "dialog_start", "dialog_advance", "dialog_draw",
        "world_init", "world_update", "input_init", "input_shutdown"}, f"code-only = 8  got {len(ko)}")

    print("\nC. evaluator")
    g = {"scene_handle_key": "signature-drift"}
    ck(evaluator.evaluate('<answer>{"scene_handle_key":"signature-drift"}</answer>', g)["hard"] == 1,
       "exact match hard=1")
    ck(evaluator.evaluate('<answer>{}</answer>', g)["hard"] == 0,
       "missed drift hard=0")
    ck(evaluator.evaluate('<answer>{}</answer>', {})["hard"] == 1,
       "empty == clean gold")

    print("\n" + "=" * 56)
    if _fail:
        print(f"  {_fail} FAILURE(S) - oracle broken.")
        sys.exit(1)
    print("  ALL PASS - conform oracle sound (model-agnostic, no LLM).")
    sys.exit(0)


if __name__ == "__main__":
    main()
