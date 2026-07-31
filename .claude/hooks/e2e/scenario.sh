#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# naia-adk harness — SYSTEM E2E (intended-coding-task scenario).
#
# Not isolated per-hook assertions: a realistic IDD coding-task NARRATIVE
# driven through the harness EXACTLY as Claude Code dispatches it —
# reads the real .claude/settings.json, fires the registered hooks in
# array order per event/matcher, applies Claude's semantics (first
# PreToolUse {"decision":"block"} stops the tool; UserPromptSubmit /
# PostToolUse are additive), against a real git-init'd naia-adk-rooted
# temp workspace with real progress/context files.
#
# Verifies the WIRING (settings.json), multi-hook dispatch order, entry-point
# synchronization behavior, and end-to-end enforcement
# across a coherent task flow — the layer the per-hook suite omits.
# Hermetic (mktemp). Committed gate. Exit non-zero on any divergence.
# ─────────────────────────────────────────────────────────────────────────────
set -u
NAK="$(cd "$(dirname "$0")/../../.." && pwd)"          # naia-adk root
SET="$NAK/.claude/settings.json"
PASS=0; FAIL=0; FAILED=()
ok(){ PASS=$((PASS+1)); echo "  ✓ $1"; }
no(){ FAIL=$((FAIL+1)); FAILED+=("$1"); echo "  ✗ FAIL $1 — $2"; }

WS="$(mktemp -d)"; trap 'rm -rf "$WS"' EXIT
( cd "$WS" && git init -q && git config user.email e@x && git config user.name x \
  && git remote add origin "https://github.com/nextain/naia-adk.git" )
mkdir -p "$WS/.agents/progress" "$WS/.agents/context" "$WS/.users/context" "$WS/docs/design" "$WS/src"
SID="E2E-SCENARIO-SESSION"
# bound progress file at phase=build (an agent mid-implementation)
cat > "$WS/.agents/progress/task.json" <<JSON
{ "issue":"E2E task","current_phase":"build","session_id":"$SID","gates_cleared":["understand","scope","plan"] }
JSON
printf '{"x":1}' > "$WS/.agents/context/agents-rules.json"
printf 'export const a=1;\n' > "$WS/src/app.ts"
printf '# design\nDecision: X\n' > "$WS/docs/design/spec.md"

# dispatch <event> <toolName|-> <stdin-json>  → sets $DEC (block|allow|""),
# $CTX (concatenated additionalContext), $ERRN (count of hooks that errored)
# Claude semantics: a group's `matcher` is a regex tested against the TOOL
# NAME (re.search). UserPromptSubmit groups have no matcher → all run.
dispatch() {
  local event="$1" tool="$2" json="$3"
  local result
  result="$(python3 - "$SET" "$event" "$tool" "$NAK" "$WS" "$json" <<'PY'
import json,re,shlex,subprocess,sys
settings,event,tool,root,cwd,stdin_text=sys.argv[1:]
cfg=json.load(open(settings,encoding="utf-8"))
decision=""; context=""; errors=0
for group in cfg.get("hooks",{}).get(event,[]):
    matcher=group.get("matcher")
    if event in ("PreToolUse","PostToolUse") and matcher is not None and not re.search(matcher,tool or ""):
        continue
    for hook in group.get("hooks",[]):
        if hook.get("type")!="command": continue
        argv=shlex.split(hook["command"])+list(hook.get("args",[]))
        argv=[part.replace("${CLAUDE_PROJECT_DIR}",root) for part in argv]
        if len(argv)>1 and argv[0]=="node" and argv[1].startswith((".claude/",".codex/",".agents/")):
            argv[1]=root+"/"+argv[1]
        run=subprocess.run(argv,cwd=cwd,input=stdin_text,text=True,capture_output=True)
        if run.returncode or run.stderr: errors+=1
        try: envelope=json.loads(run.stdout) if run.stdout else {}
        except json.JSONDecodeError: envelope={}
        if event=="PreToolUse":
            current=envelope.get("decision") or envelope.get("hookSpecificOutput",{}).get("permissionDecision","")
            if current=="block": decision="block"; break
            if current=="allow": decision="allow"
        else:
            context+=envelope.get("additionalContext","")
            context+=envelope.get("hookSpecificOutput",{}).get("additionalContext","")
            if not envelope and run.stdout: context+=run.stdout
    if decision=="block": break
print(json.dumps({"decision":decision,"context":context,"errors":errors}))
PY
)"
  DEC="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["decision"])' "$result")"
  CTX="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["context"],end="")' "$result")"
  ERRN="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["errors"])' "$result")"
}
PJSON(){ python3 -c 'import json,sys;print(json.dumps(json.loads(sys.argv[1])))' "$1"; }

echo "═══ naia-adk SYSTEM E2E — intended coding-task scenario ═══"
echo "settings.json registered hooks:"
python3 -c 'import json;c=json.load(open("'"$SET"'"))["hooks"];[print(" ",e,[h["command"].split("/")[-1] for g in v for h in g["hooks"]]) for e,v in c.items()]'

echo "── Step 1: user prompt (UserPromptSubmit) — bound session, phase=build ──"
dispatch UserPromptSubmit - "$(PJSON "{\"cwd\":\"$WS\",\"session_id\":\"$SID\"}")"
printf '%s' "$CTX" | grep -q 'HARNESS: SESSION STATE' && ok "session-inject injects BOUND state" || no "session-inject BOUND" "got: ${CTX:0:120}"
printf '%s' "$CTX" | grep -q 'E2E task' && ok "injected the bound issue" || no "issue inject" "${CTX:0:120}"
printf '%s' "$CTX" | grep -q '6. Build' && ok "injected correct phase label" || no "phase label" "${CTX:0:120}"

echo "── Step 2: agent edits code (Edit src/app.ts) — must be ALLOWED ──"
dispatch PreToolUse "Edit" "$(PJSON "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$WS/src/app.ts\",\"new_string\":\"export const a=2;\"},\"cwd\":\"$WS\"}")"
[ "$DEC" != "block" ] && ok "code edit allowed (design-doc+prod-gateway pass)" || no "code edit" "blocked unexpectedly"

echo "── Step 3: agent tries to edit a DESIGN DOC — harness must BLOCK ──"
dispatch PreToolUse "Edit" "$(PJSON "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$WS/docs/design/spec.md\",\"new_string\":\"Decision: Y\"},\"cwd\":\"$WS\"}")"
[ "$DEC" = "block" ] && ok "design-doc edit BLOCKED (AI=reviewer)" || no "design-doc block" "DEC=$DEC"

echo "── Step 4: safe bash (git status) — all 6 bash guards pass ──"
dispatch PreToolUse "Bash" "$(PJSON "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git status\"},\"cwd\":\"$WS\"}")"
[ "$DEC" != "block" ] && ok "git status allowed through 6-guard chain" || no "git status" "blocked"

echo "── Step 5: destructive bash (git reset --hard) — harness must BLOCK ──"
dispatch PreToolUse "Bash" "$(PJSON "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git reset --hard HEAD~1\"},\"cwd\":\"$WS\"}")"
[ "$DEC" = "block" ] && ok "destructive git BLOCKED mid-chain" || no "destructive block" "DEC=$DEC"

echo "── Step 6: agent tries git commit at phase=build — commit-guard must BLOCK ──"
dispatch PreToolUse "Bash" "$(PJSON "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m wip\"},\"cwd\":\"$WS\"}")"
[ "$DEC" = "block" ] && ok "commit BLOCKED before sync_verify (IDD gate)" || no "commit-guard block" "DEC=$DEC"

echo "── Step 7: edit agents-rules.json → PostToolUse cascade + mirror ──"
dispatch PostToolUse "Edit" "$(PJSON "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$WS/.agents/context/agents-rules.json\"},\"cwd\":\"$WS\"}")"
printf '%s' "$CTX" | grep -q 'agents-rules.json is the SoT' && ok "cascade-check fires SoT mirror reminder" || no "cascade reminder" "${CTX:0:120}"
echo "    (registered PostToolUse hooks reported $ERRN error(s))"
[ "$ERRN" -eq 0 ] && ok "entry-point synchronization hook completes without error" || no "entry-point synchronization" "ERRN=$ERRN (expected 0)"
dispatch PostToolUse "Edit" "$(PJSON "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$WS/.agents/context/agents-rules.json\"},\"cwd\":\"$WS\"}")"
[ -f "$WS/.users/context/agents-rules.md" ] && grep -q 'AUTO-GENERATED' "$WS/.users/context/agents-rules.md" && ok "agents-context-mirror regenerated .users mirror" || no "mirror write" "no .users/context/agents-rules.md"

echo "── Step 8: gh pr create --repo external — pr-guard must BLOCK ──"
dispatch PreToolUse "Bash" "$(PJSON "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"gh pr create --repo openclaw/openclaw -t x -b y\"},\"cwd\":\"$WS\"}")"
[ "$DEC" = "block" ] && ok "external gh pr create BLOCKED (first in bash chain)" || no "pr-guard block" "DEC=$DEC"

echo "── Step 9: IDD gate progression — advance phase to sync_verify, commit now ALLOWED ──"
cat > "$WS/.agents/progress/task.json" <<JSON
{ "issue":"E2E task","current_phase":"sync_verify","session_id":"$SID" }
JSON
dispatch PreToolUse "Bash" "$(PJSON "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m done\"},\"cwd\":\"$WS\"}")"
[ "$DEC" != "block" ] && ok "commit ALLOWED at sync_verify (gate opened — IDD progression works)" || no "commit allowed@sync_verify" "DEC=$DEC"

echo "═══════════════════════════════════════════════"
echo "SYSTEM E2E: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then for f in "${FAILED[@]}"; do echo "  - $f"; done; echo "SYSTEM E2E: FAIL"; exit 1; fi
echo "SYSTEM E2E: PASS — harness enforces correctly across a real intended-task flow"
