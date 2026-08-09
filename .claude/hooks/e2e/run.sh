#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# naia-adk harness E2E suite — REAL-condition behavioral gate.
#
# Invokes each hook EXACTLY as Claude Code invokes it
# (`echo '<json>' | node .claude/hooks/<hook>.js`, the harness.yaml H1
# canonical form + the documented PreToolUse/PostToolUse/UserPromptSubmit
# stdin schema) under REAL conditions: real `git init` repos with real
# remotes (pr/commit/git-push execSync paths), real .claude markers /
# design-doc-unlock, real contracts + progress + registry bindings, real
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
bind_session_fixture() { # $1=root $2=session $3=contract $4=progress $5=issue $6=phase
  node "$HOOKS/e2e/session-contract-fixture.cjs" "$1" "$2" "$3" "$4" "$5" "$6"
}

echo "═══ naia-adk harness E2E (real conditions) ═══"

# ── destructive-git-guard ────────────────────────────────────────────────────
echo "destructive-git-guard:"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git status"}}')";              a_pass  "dgg pass: git status"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git checkout main"}}')";        a_pass  "dgg pass: checkout branch"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"echo '\''git reset --hard'\''"}}')"; a_pass "dgg pass: quoted (false-pos guard)"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git reset --hard HEAD~1"}}')";  a_block "dgg block: reset --hard"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"ls && git clean -fd"}}')";      a_block "dgg block: chained clean -fd (bypass attempt)"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git.exe reset --hard HEAD~1"}}')"; a_block "dgg block: Windows git executable reset"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git -c advice.detachedHead=false reset --hard HEAD~1"}}')"; a_block "dgg block: git global config reset"
fire destructive-git-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git --no-pager clean -fd"}}')"; a_block "dgg block: git global flag clean"
fire destructive-git-guard "$(J '{"tool_name":"Read","tool_input":{"command":"x"}}')";                        a_pass  "dgg pass: non-Bash"
fire destructive-git-guard 'NOT JSON';                                                                        a_pass  "dgg pass: bad json (fail-open)"
a_nostderr "dgg stderr clean"

# ── git-push-guard (routine push allowed, history rewriting blocked) ─────────
echo "git-push-guard:"
GP="$ROOT/gp"; mkdir -p "$GP/.claude"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git status"}}')";                      a_pass  "gpg pass: git status"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"echo '\''git push'\''"}}')";           a_pass  "gpg pass: quoted push"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}')";            a_pass  "gpg pass: routine non-force push"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push origin HEAD:feature/routine"}}')"; a_pass "gpg pass: normal destination refspec"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push origin refs/tags/v1.0.0"}}')";  a_pass  "gpg pass: normal tag push"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git -c push.default=current push origin main"}}')"; a_pass "gpg pass: git global config normal push"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git --no-pager push origin main"}}')"; a_pass "gpg pass: git global flag normal push"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git.exe push origin main"}}')";       a_pass "gpg pass: Windows git executable normal push"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}')";    a_block "gpg block: force push"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push --force-with-lease origin main"}}')"; a_block "gpg block: force-with-lease"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push -fu origin main"}}')";       a_block "gpg block: combined short force"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push '\''--force'\'' origin main"}}')"; a_block "gpg block: quoted force"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git -c push.default=current push --force origin main"}}')"; a_block "gpg block: git global config force"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git --no-pager push --force origin main"}}')"; a_block "gpg block: git global flag force"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git.exe push --force origin main"}}')"; a_block "gpg block: Windows git executable force"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push origin +main"}}')";             a_block "gpg block: forced refspec"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push --delete origin obsolete"}}')"; a_block "gpg block: --delete remote branch"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git -c push.default=current push --delete origin obsolete"}}')"; a_block "gpg block: git global config delete"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push --mirror origin"}}')";         a_block "gpg block: mirror remote refs"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push --prune origin"}}')";          a_block "gpg block: prune remote refs"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push origin :refs/heads/obsolete"}}')"; a_block "gpg block: delete branch refspec"
fire git-push-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"git push origin :refs/tags/v0.9.0"}}')"; a_block "gpg block: delete tag refspec"

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
# just not hermetic for deploy-guard's approval state. Temporarily install a
# minimal config at that real adapter path so the documented -dev bypass is
# exercised deterministically, then restore any machine-local config.
DEPLOY_CONFIG="$HOOKS/../deploy/config.json"
DEPLOY_CONFIG_BACKUP="$ROOT/deploy-config.backup"
DEPLOY_CONFIG_EXISTED=0
if [ -f "$DEPLOY_CONFIG" ]; then
  DEPLOY_CONFIG_EXISTED=1
  cp "$DEPLOY_CONFIG" "$DEPLOY_CONFIG_BACKUP"
fi
printf '{"projects":{"e2e":{"platform":"gcloud","dev_service":"svc-dev"}},"default_ttl_minutes":30}' > "$DEPLOY_CONFIG"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"vercel"}}')";                            a_pass  "dpg pass: vercel preview"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"vercel env ls"}}')";                     a_pass  "dpg pass: vercel env"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"echo '\''vercel --prod'\''"}}')";        a_pass  "dpg pass: quoted (unwrap→still contains; echo-skip)"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"vercel --prod"}}')";                     a_block "dpg block: vercel --prod (no approval)"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"gcloud builds submit"}}')";              a_block "dpg block: builds submit (alwaysBlock)"
fire deploy-guard "$(J '{"tool_name":"Bash","tool_input":{"command":"gcloud run deploy svc-dev --image x"}}')"; a_pass "dpg pass: dev service (-dev)"
if [ "$DEPLOY_CONFIG_EXISTED" = 1 ]; then cp "$DEPLOY_CONFIG_BACKUP" "$DEPLOY_CONFIG"; else rm -f "$DEPLOY_CONFIG"; fi

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
# No real prod credentials in fixtures: the guard matches the URL by the
# `naia-gateway-<digits>.<region>.run.app` shape and the key by SHA-256 digest.
# We build a synthetic prod-shaped URL at runtime (so no literal *.run.app lives
# in this file) and exercise the key path via a sentinel whose digest the guard
# is told to recognize through PROD_MASTER_KEY_SHA256.
echo "prod-gateway-guard:"
RA="run.app"; PROD_URL="https://naia-gateway-000000000000.asia-northeast3.${RA}"
SENTINEL_KEY="TEST-SENTINEL-PROD-KEY-DO-NOT-USE"
export PROD_MASTER_KEY_SHA256="37b59dd7f7cf015be30167b7e324c3c2e8cae57133e01c83524a4cdbbbc4ce20"
fire prod-gateway-guard "$(J '{"tool_name":"Edit","tool_input":{"file_path":"src/x.ts","new_string":"x"}}')"; a_pass  "pgg pass: non-env file"
fire prod-gateway-guard "$(J "$(printf '{"tool_name":"Write","tool_input":{"file_path":".env.production.local","content":"URL=%s"}}' "$PROD_URL")")"; a_pass "pgg pass: .env.production.local exempt"
fire prod-gateway-guard "$(J '{"tool_name":"Write","tool_input":{"file_path":".env.local","content":"GATEWAY=dev"}}')"; a_pass "pgg pass: env.local clean"
fire prod-gateway-guard "$(J "$(printf '{"tool_name":"Write","tool_input":{"file_path":".env.local","content":"URL=%s"}}' "$PROD_URL")")"; a_block "pgg block: prod url in .env.local"
fire prod-gateway-guard "$(J "$(printf '{"tool_name":"Edit","tool_input":{"file_path":".env.local","new_string":"K=%s"}}' "$SENTINEL_KEY")")"; a_block "pgg block: prod key in .env.local (Edit new_string)"
unset PROD_MASTER_KEY_SHA256

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

# ── session-inject (UserPromptSubmit; real contract bindings/unbound/optout) ─
echo "session-inject:"
SI="$ROOT/si"
bind_session_fixture "$SI" SID0 contract-p0 p0.json ISS-P0 build
fire session-inject "$(J '{"cwd":"'"$SI"'","session_id":"SID0"}')";                                           a_has  "si P0: bound contract state" "ISS-P0"
a_has "si P0: phase label" "6. Build"
bind_session_fixture "$SI" SID1 contract-p1 p1.json ISS-P1 review
fire session-inject "$(J '{"cwd":"'"$SI"'","session_id":"SID1"}')";                                           a_has  "si P1: bound via contract registry" "ISS-P1"
fire session-inject "$(J '{"cwd":"'"$SI"'","session_id":"NOPE"}')"; { [ -z "$OUT" ]; } && ok || bad "si unbound: prompt injection stays silent"
# opt-out: CLAUDE_HARNESS=off → hook must exit 0 silently (no inject)
SI_OO="$(mktemp)"; CLAUDE_HARNESS=off node "$HOOKS/session-inject.js" <<<"$(J '{"cwd":"'"$SI"'","session_id":"SID0"}')" >"$SI_OO" 2>&1; { [ ! -s "$SI_OO" ]; } && ok || bad "si opt-out env CLAUDE_HARNESS=off (must be silent)"; rm -f "$SI_OO"
# opt-out: <cwd>/.claude/no-harness marker → silent
mkdir -p "$SI/.claude"; : > "$SI/.claude/no-harness"
fire session-inject "$(J '{"cwd":"'"$SI"'","session_id":"SID0"}')"; { [ -z "$OUT" ]; } && ok || bad "si opt-out file .claude/no-harness (must be silent)"
rm -f "$SI/.claude/no-harness"
# e2e_test phase ⛔ enforcement present
bind_session_fixture "$SI" SE contract-e2e e.json E e2e_test
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
node "$TESTD/run-beh-pretool-test.js"    >/dev/null 2>&1 && ok || bad "beh pretool/launcher suite (23 cases)"
node "$TESTD/run-beh-registry-test.js"   >/dev/null 2>&1 && ok || bad "beh registry + second-stream suite (12 cases)"
node "$TESTD/run-beh-manifest-test.js"   >/dev/null 2>&1 && ok || bad "beh manifest/propagation suite (14 cases)"
node "$TESTD/run-beh-adapter-test.js"    >/dev/null 2>&1 && ok || bad "beh adapter replay suite (10 cases)"
node "$HOOKS/beh-watchdog.js" --selftest >/dev/null 2>&1 && ok || bad "beh watchdog selftest (flat→STUCK, fresh→clear)"
timeout 60 node "$TESTD/run-beh-supervise-wrapper-test.js" >/dev/null 2>&1 && ok || bad "beh supervise wrapper real-process (kill target, spare sibling)"

# ── request-contract native integration (full fault suite is its own gate) ──
echo "request-contract:"
request_contract_case() {
  local filter="$1" expected="$2" output
  if output="$(TEST_FILTER="$filter" node "$TESTD/run-request-contract-test.js" 2>&1)" \
    && grep -Fq "ok 1 - $expected" <<<"$output" \
    && grep -Fq 'request-contract: PASS (1 cases)' <<<"$output"; then
    ok
  else
    bad "request-contract: $expected"
  fi
}
request_contract_case 'native Claude Code and Codex processes' 'native Claude Code and Codex processes discover the same nested project root'
request_contract_case 'native PreCompact blocks' 'native PreCompact blocks incomplete work before compaction for both clients'
request_contract_case 'native Codex apply_patch' 'native Codex apply_patch can bootstrap only one exact private control input'
request_contract_case 'client-native capability maps' 'client-native capability maps reject undeclared aliases and map native outputs explicitly'
request_contract_case 'full persisted lifecycle' 'full persisted lifecycle is policy-equivalent across Claude Code and Codex'

# ─────────────────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════"
echo "E2E RESULT: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then printf 'FAILED:\n'; for c in "${FAILED_CASES[@]}"; do echo "  - $c"; done; echo "E2E: FAIL"; exit 1; fi
echo "E2E: PASS — all $PASS real-condition behavioral assertions green"
