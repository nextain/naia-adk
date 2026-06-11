#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# naia-adk harness E2E suite — REAL-condition behavioral gate.
#
# Invokes each hook EXACTLY as Claude Code invokes it
# (`echo '<json>' | node .claude/hooks/<hook>.js`, the harness.yaml H1
# canonical form + the documented PreToolUse/PostToolUse/UserPromptSubmit
# stdin schema) under REAL conditions: real `git init` repos with real
# remotes (pr/commit/git-push execSync paths), real .claude markers /
# design-doc-unlock, real progress files + session-map (P0/P1), real
# deploy config+approvals, real .agents/.users dirs.
#
# Assertions are EFFECTIVE-behavior, not byte-parity: a SHOULD-block case
# must yield the block decision Claude acts on; SHOULD-pass must NOT block;
# allow must yield decision:allow; inject must carry the right state;
# disk side-effects (audit / marker-consume / mirror md) must really happen.
#
# Hermetic: all fixtures in mktemp dirs (no repo pollution). Committed
# (NOT tmp/) — this IS the part1 pass criterion. Exit non-zero on any fail.
# ─────────────────────────────────────────────────────────────────────────────
set -u
HOOKS="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0; FAILED_CASES=()

# fire <hook> <stdin-json> → sets $OUT (stdout), $RC (exit), $ERRF content
fire() {
  local hook="$1" json="$2"
  ERRTMP="$(mktemp)"
  OUT="$(printf '%s' "$json" | node "$HOOKS/$hook.js" 2>"$ERRTMP")"
  RC=$?
  ERRC="$(cat "$ERRTMP")"; rm -f "$ERRTMP"
}
ok()   { PASS=$((PASS+1)); }
bad()  { FAIL=$((FAIL+1)); FAILED_CASES+=("$1"); echo "  ✗ FAIL: $1"; echo "     rc=$RC out=${OUT:0:200}${ERRC:+ ERR=${ERRC:0:160}}"; }
# assertions
a_block()  { local n="$1"; { [ -n "$OUT" ] && printf '%s' "$OUT" | grep -q '"decision":"block"'; } && ok || bad "$n (expected block)"; }
a_allow()  { local n="$1"; printf '%s' "$OUT" | grep -q '"decision":"allow"' && ok || bad "$n (expected allow)"; }
a_pass()   { local n="$1"; { [ "$RC" = 0 ] && ! printf '%s' "$OUT" | grep -q '"decision":"block"'; } && ok || bad "$n (expected pass/no-block)"; }
a_has()    { local n="$1" s="$2"; printf '%s' "$OUT" | grep -qF "$s" && ok || bad "$n (missing: $s)"; }
a_nostderr(){ local n="$1"; [ -z "$ERRC" ] && ok || bad "$n (stderr not clean)"; }
J() { python3 -c 'import json,sys;print(json.dumps(json.loads(sys.argv[1])))' "$1"; }   # validate+compact

ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
mkrepo() { # $1=dir $2=origin-url ; real git repo
  local d="$1"; mkdir -p "$d"; ( cd "$d" && git init -q && git config user.email e@x && git config user.name x \
    && git remote add origin "$2" >/dev/null 2>&1 ); }

echo "═══ naia-adk harness E2E (real conditions) ═══"

# ── destructive-git-guard ────────────────────────────────────────────────────
echo "destructive-git-guard:"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git status"}}')";              a_pass  "dgg pass: git status"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git checkout main"}}')";        a_pass  "dgg pass: checkout branch"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"echo '\''git reset --hard'\''"}}')"; a_pass "dgg pass: quoted (false-pos guard)"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git reset --hard HEAD~1"}}')";  a_block "dgg block: reset --hard"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"ls && git clean -fd"}}')";      a_block "dgg block: chained clean -fd (bypass attempt)"
fire destructive-git-guard "$(J '{"tool_name":"Read","tool_input":{"command":"x"}}')";                        a_pass  "dgg pass: non-Bash"
fire destructive-git-guard 'NOT JSON';                                                                        a_pass  "dgg pass: bad json (fail-open)"
a_nostderr "dgg stderr clean"

# ── git-push-guard (real marker consume) ─────────────────────────────────────
echo "git-push-guard:"
GP="$ROOT/gp"; mkdir -p "$GP/.claude"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git status"}}')";                      a_pass  "gpg pass: git status"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"echo '\''git push'\''"}}')";           a_pass  "gpg pass: quoted push"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}')";            a_block "gpg block: plain push (no marker)"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}')";    a_block "gpg block: force push"
# real valid marker → normal push allowed + marker consumed (uses=1 → deleted)
( cd "$GP" && printf '{"expiresAt":%d,"uses":1}' "$(( ($(date +%s)+3600)*1000 ))" > .claude/git-push-approved.marker )
( cd "$GP" && printf '%s' "$(J '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}')" | node "$HOOKS/git-push-guard.js" >/dev/null 2>&1 )
[ ! -f "$GP/.claude/git-push-approved.marker" ] && ok || bad "gpg marker consumed (uses=1 → deleted)"
# force push still blocked even with marker
( cd "$GP" && printf '{"expiresAt":%d,"uses":3}' "$(( ($(date +%s)+3600)*1000 ))" > .claude/git-push-approved.marker )
OUT="$( cd "$GP" && printf '%s' "$(J '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}')" | node "$HOOKS/git-push-guard.js" 2>/dev/null )"
printf '%s' "$OUT" | grep -q '"decision":"block"' && ok || bad "gpg force blocked even WITH marker"

# ── pr-guard (real git remotes, execSync) ────────────────────────────────────
echo "pr-guard:"
PRN="$ROOT/pr-nx"; mkrepo "$PRN" "https://github.com/nextain/naia-adk.git"
PRX="$ROOT/pr-ext"; mkrepo "$PRX" "https://github.com/openclaw/openclaw.git"
fire pr-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"gh pr list"}}')";                            a_pass  "prg pass: read op"
fire pr-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"echo hello"}}')";                            a_pass  "prg pass: no write op"
# pr-guard conservatively BLOCKS any write-op without --repo (even in a
# nextain-remote cwd): findExternalUpstream→null, then the final
# "(--repo 미지정) conservative" block fires. This is the real (byte-identical)
# behavior — verified against the original. Only `--repo nextain/...` or a
# non-write-op passes. (Initial draft mis-expected pass; corrected per real run.)
OUT="$(printf '%s' "$(J '{"tool_name":"Bash","tool_input":{"command":"gh pr create -t x -b y"},"cwd":"'"$PRN"'"}')" | node "$HOOKS/pr-guard.js" 2>/dev/null)"; printf '%s' "$OUT"|grep -q '"decision":"block"' && ok || bad "prg block: write w/o --repo even in nextain cwd (conservative)"
fire pr-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"gh pr create --repo nextain/naia-adk -t x -b y"}}')"; a_pass "prg pass: --repo nextain"
fire pr-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"gh pr create --repo openclaw/openclaw -t x -b y"}}')"; a_block "prg block: --repo external"
OUT="$(printf '%s' "$(J '{"tool_name":"Bash","tool_input":{"command":"gh issue comment 1 -b hi"},"cwd":"'"$PRX"'"}')" | node "$HOOKS/pr-guard.js" 2>/dev/null)"; printf '%s' "$OUT"|grep -q '"decision":"block"' && ok || bad "prg block: write in external-remote cwd (real execSync)"

# ── commit-guard (real progress + real git remote match) ─────────────────────
echo "commit-guard:"
CG="$ROOT/cg"; mkrepo "$CG" "https://github.com/nextain/naia-adk.git"; mkdir -p "$CG/.agents/progress"
printf '{"issue":"X","issue_url":"https://github.com/nextain/naia-adk/issues/1","current_phase":"build"}' > "$CG/.agents/progress/x.json"
OUT="$(printf '%s' "$(J '{"tool_name":"Bash","tool_input":{"command":"git commit -m wip"},"cwd":"'"$CG"'"}')" | node "$HOOKS/commit-guard.js" 2>/dev/null)"; printf '%s' "$OUT"|grep -q '"decision":"block"' && ok || bad "cg block: commit at build phase (same repo)"
printf '{"issue":"X","current_phase":"sync_verify"}' > "$CG/.agents/progress/x.json"
OUT="$(printf '%s' "$(J '{"tool_name":"Bash","tool_input":{"command":"git commit -m ok"},"cwd":"'"$CG"'"}')" | node "$HOOKS/commit-guard.js" 2>/dev/null)"; { ! printf '%s' "$OUT"|grep -q '"decision":"block"'; } && ok || bad "cg pass: commit at sync_verify"
# different-repo issue_url → skip phase check (real git remote get-url)
printf '{"issue":"Y","issue_url":"https://github.com/other/repo/issues/9","current_phase":"build"}' > "$CG/.agents/progress/x.json"
OUT="$(printf '%s' "$(J '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"},"cwd":"'"$CG"'"}')" | node "$HOOKS/commit-guard.js" 2>/dev/null)"; { ! printf '%s' "$OUT"|grep -q '"decision":"block"'; } && ok || bad "cg pass: different-repo issue_url skips check"
fire commit-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"echo '\''git commit -m x'\''"}}')";       a_pass  "cg pass: quoted commit"
fire commit-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"ls"}}')";                                a_pass  "cg pass: non-commit"

# ── deploy-guard (real config+approvals+audit) ───────────────────────────────
echo "deploy-guard:"
DG="$ROOT/dg/.claude/deploy"; mkdir -p "$DG"
printf '{"projects":{"web":{"platform":"vercel","cwd":"%s","dev_service":"web-dev"}},"default_ttl_minutes":30}' "$ROOT/dg" > "$DG/config.json"
printf '{"approvals":[]}' > "$DG/approvals.json"
# HONEST LIMIT: deploy-guard resolves DEPLOY_DIR via __dirname (real
# .claude/deploy), NOT fixture-redirectable without modifying the hook
# (out of scope). So these assert only config-INDEPENDENT behavior that
# holds against the real repo deploy config: pattern→block when no
# project-scoped approval matches (detectProject→null for a fixture cwd,
# real approvals.json has no blanket entry), preview→pass, -dev→pass,
# alwaysBlock(builds submit)→block. This is true E2E against real config,
# just not hermetic for deploy-guard's approval state.
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"vercel"}}')";                            a_pass  "dpg pass: vercel preview"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"vercel env ls"}}')";                     a_pass  "dpg pass: vercel env"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"echo '\''vercel --prod'\''"}}')";        a_pass  "dpg pass: quoted (unwrap→still contains; echo-skip)"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"vercel --prod"}}')";                     a_block "dpg block: vercel --prod (no approval)"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"gcloud builds submit"}}')";              a_block "dpg block: builds submit (alwaysBlock)"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"gcloud run deploy svc-dev --image x"}}')"; a_pass "dpg pass: dev service (-dev)"

# ── email-send-guard ────────────────────────────────────────────────────────
echo "email-send-guard:"
fire email-send-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"node send.js test"}}')";             a_pass  "esg pass: test"
fire email-send-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"node send.js preview"}}')";          a_pass  "esg pass: preview"
fire email-send-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"node send.js send --test-only"}}')"; a_pass  "esg pass: send --test-only"
fire email-send-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"node send.js send"}}')";             a_block "esg block: real send"
fire email-send-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"gcloud run jobs execute press-release-send"}}')"; a_block "esg block: cloud send"

# ── design-doc-guard (real .claude/design-doc-unlock — the golden GAP) ────────
echo "design-doc-guard:"
fire design-doc-guard "$(J '{"tool_name":"Bash","tool_input":{"file_path":"docs/design/x.md"}}')";            a_pass  "ddg pass: non-Edit/Write"
fire design-doc-guard "$(J '{"tool_name":"Edit","tool_input":{"file_path":"src/app.ts"}}')";                  a_pass  "ddg pass: code file"
fire design-doc-guard "$(J '{"tool_name":"Write","tool_input":{"file_path":"/p/spec/api.yaml"}}')";           a_block "ddg block: spec doc no unlock"
fire design-doc-guard "$(J '{"tool_name":"Edit","tool_input":{"file_path":"/p/docs/design/d.md"}}')";         a_block "ddg block: design doc no unlock"
# REAL allow branch: create real .claude/design-doc-unlock (the path the hook resolves via __dirname), assert allow, then remove.
UNLOCK="$HOOKS/../design-doc-unlock"; UNLOCK_PREEXIST=0; [ -e "$UNLOCK" ] && UNLOCK_PREEXIST=1
if [ "$UNLOCK_PREEXIST" = 0 ]; then : > "$UNLOCK"; fi
fire design-doc-guard "$(J '{"tool_name":"Edit","tool_input":{"file_path":"/p/docs/design/d.md"}}')";         a_allow "ddg allow: design doc WITH real unlock file (golden-gap closed)"
if [ "$UNLOCK_PREEXIST" = 0 ]; then rm -f "$UNLOCK"; fi
fire design-doc-guard 'NOT JSON';                                                                             a_pass  "ddg pass: bad json"

# ── prod-gateway-guard ──────────────────────────────────────────────────────
echo "prod-gateway-guard:"
fire prod-gateway-guard "$(J '{"tool_name":"Edit","tool_input":{"file_path":"src/x.ts","new_string":"x"}}')"; a_pass  "pgg pass: non-env file"
fire prod-gateway-guard "$(J '{"tool_name":"Write","tool_input":{"file_path":".env.production.local","content":"URL=https://naia-gateway-181404717065.asia-northeast3.run.app"}}')"; a_pass "pgg pass: .env.production.local exempt"
fire prod-gateway-guard "$(J '{"tool_name":"Write","tool_input":{"file_path":".env.local","content":"GATEWAY=dev"}}')"; a_pass "pgg pass: env.local clean"
fire prod-gateway-guard "$(J '{"tool_name":"Write","tool_input":{"file_path":".env.local","content":"URL=https://naia-gateway-181404717065.asia-northeast3.run.app"}}')"; a_block "pgg block: prod url in .env.local"
fire prod-gateway-guard "$(J '{"tool_name":"Edit","tool_input":{"file_path":".env.local","new_string":"K=11ypvgv9LEBEeeOLXsJODhEyhCyQr36UzNA6nl5-Ptg"}}')"; a_block "pgg block: prod key in .env.local (Edit new_string)"

# ── cascade-check (PostToolUse) ─────────────────────────────────────────────
echo "cascade-check:"
fire cascade-check "$(J '{"tool_name":"Bash","tool_input":{"file_path":"x"}}')";                              a_pass  "ccg pass: non-Edit/Write"
fire cascade-check "$(J '{"tool_name":"Edit","tool_input":{"file_path":"src/app.ts"}}')";                     a_pass  "ccg pass: unrelated file (no reminder)"
fire cascade-check "$(J '{"tool_name":"Edit","tool_input":{"file_path":"x/.agents/context/agents-rules.json"}}')"; a_has "ccg ctx: agents-rules.json SoT reminder" "agents-rules.json is the SoT"
fire cascade-check "$(J '{"tool_name":"Write","tool_input":{"file_path":"x/.agents/context/project-index.yaml"}}')"; a_has "ccg ctx: triple-mirror reminder" "Triple-mirror rule"

# ── agents-context-mirror (real .agents/.users → real md write) ─────────────
echo "agents-context-mirror:"
ACM="$ROOT/acm"; mkdir -p "$ACM/.agents/context" "$ACM/.users/context"
printf '{"a":1,"b":{"c":"x"}}' > "$ACM/.agents/context/proj.json"
fire agents-context-mirror "$(J '{"tool_input":{"file_path":""}}')";                                          a_pass  "acm pass: no fp"
fire agents-context-mirror "$(J '{"tool_input":{"file_path":"src/x.ts"}}')";                                  a_pass  "acm pass: non-target"
OUT="$(printf '{"tool_input":{"file_path":"%s/.agents/context/proj.json"}}' "$ACM" | node "$HOOKS/agents-context-mirror.js" 2>/dev/null)"
{ printf '%s' "$OUT"|grep -q '"systemMessage"' && [ -f "$ACM/.users/context/proj.md" ] && grep -q 'AUTO-GENERATED' "$ACM/.users/context/proj.md"; } && ok || bad "acm write: real md generated + systemMessage"
# no .users dir → skip (no write, no crash)
ACM2="$ROOT/acm2"; mkdir -p "$ACM2/.agents/context"; printf '{"x":1}' > "$ACM2/.agents/context/p.json"
OUT="$(printf '{"tool_input":{"file_path":"%s/.agents/context/p.json"}}' "$ACM2" | node "$HOOKS/agents-context-mirror.js" 2>/dev/null)"; RC=$?
{ [ "$RC" = 0 ] && [ ! -f "$ACM2/.users/context/p.md" ]; } && ok || bad "acm skip: no .users dir → no write"

# ── session-inject (UserPromptSubmit; real progress P0/P1/unbound/optout) ────
echo "session-inject:"
SI="$ROOT/si"; mkdir -p "$SI/.agents/progress"
printf '{"issue":"ISS-P0","current_phase":"build","session_id":"SID0","gates_cleared":["plan"]}' > "$SI/.agents/progress/p0.json"
fire session-inject "$(J '{"cwd":"'"$SI"'","session_id":"SID0"}')";                                           a_has  "si P0: bound state by embedded session_id" "ISS-P0"
a_has "si P0: phase label" "6. Build"
printf '{"issue":"ISS-P1","current_phase":"review"}' > "$SI/.agents/progress/p1.json"
printf '{"SID1":"p1.json"}' > "$SI/.agents/progress/.session-map.json"
fire session-inject "$(J '{"cwd":"'"$SI"'","session_id":"SID1"}')";                                           a_has  "si P1: bound via session-map" "ISS-P1"
fire session-inject "$(J '{"cwd":"'"$SI"'","session_id":"NOPE"}')";                                           a_has  "si unbound: selection prompt" "SESSION UNBOUND"
# opt-out: CLAUDE_HARNESS=off → hook must exit 0 silently (no inject)
SI_OO="$(mktemp)"; CLAUDE_HARNESS=off node "$HOOKS/session-inject.js" <<<"$(J '{"cwd":"'"$SI"'","session_id":"SID0"}')" >"$SI_OO" 2>&1; { [ ! -s "$SI_OO" ]; } && ok || bad "si opt-out env CLAUDE_HARNESS=off (must be silent)"; rm -f "$SI_OO"
# opt-out: <cwd>/.claude/no-harness marker → silent
mkdir -p "$SI/.claude"; : > "$SI/.claude/no-harness"
fire session-inject "$(J '{"cwd":"'"$SI"'","session_id":"SID0"}')"; { [ -z "$OUT" ]; } && ok || bad "si opt-out file .claude/no-harness (must be silent)"
rm -f "$SI/.claude/no-harness"
# e2e_test phase ⛔ enforcement present
printf '{"issue":"E","current_phase":"e2e_test","session_id":"SE"}' > "$SI/.agents/progress/e.json"
fire session-inject "$(J '{"cwd":"'"$SI"'","session_id":"SE"}')";                                             a_has  "si e2e_test ⛔ enforcement" "실제 사용자 시나리오"

# ── post-compact-context ────────────────────────────────────────────────────
echo "post-compact-context:"
fire post-compact-context '';                                                                                 a_has  "pcc: mandatory re-read msg" "agents-rules.json"
a_has "pcc: subproject rule" "subproject"

# ── BEH §3.1 ledger harness (fault-injection core + adapter replay + watchdog) ─
echo "beh-ledger:"
TESTD="$(cd "$HOOKS/test" && pwd)"
node "$TESTD/run-beh-ledger-test.js"     >/dev/null 2>&1 && ok || bad "beh ledger fault-injection suite (24 cases)"
node "$TESTD/run-beh-receipts-test.js"   >/dev/null 2>&1 && ok || bad "beh receipts fault-injection suite (12 cases)"
node "$TESTD/run-beh-supervise-test.js"  >/dev/null 2>&1 && ok || bad "beh supervise fault-injection suite (16 cases)"
node "$TESTD/run-beh-adapter-test.js"    >/dev/null 2>&1 && ok || bad "beh adapter replay suite (10 cases)"
node "$HOOKS/beh-watchdog.js" --selftest >/dev/null 2>&1 && ok || bad "beh watchdog selftest (flat→STUCK, fresh→clear)"
timeout 60 node "$TESTD/run-beh-supervise-wrapper-test.js" >/dev/null 2>&1 && ok || bad "beh supervise wrapper real-process (kill target, spare sibling)"

# ─────────────────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════"
echo "E2E RESULT: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then printf 'FAILED:\n'; for c in "${FAILED_CASES[@]}"; do echo "  - $c"; done; echo "E2E: FAIL"; exit 1; fi
echo "E2E: PASS — all $PASS real-condition behavioral assertions green"
