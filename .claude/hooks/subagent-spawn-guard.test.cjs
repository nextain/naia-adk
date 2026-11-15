const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const guard = require("./subagent-spawn-guard.js");

const HOOK_PATH = path.join(__dirname, "subagent-spawn-guard.js");
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 15, 4, 0, 0);

function makeFixture(t, optIn, { roleMode = false, readMemInfo, totalMemBytes } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-concurrency-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	if (roleMode) fs.writeFileSync(path.join(root, ".naia-role.json"), JSON.stringify({ read: [] }));
	if (optIn !== null) {
		fs.writeFileSync(
			path.join(root, ".claude", "allow-subagents"),
			typeof optIn === "string" ? optIn : JSON.stringify(optIn),
		);
	}
	const tmpRoot = roleMode ? null : path.join(root, "budget");
	const budgetDir = roleMode ? path.join(root, ".claude", "subagent-budget") : tmpRoot;
	const env = { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_SUBAGENT_GUARD: "" };
	const fire = (payload, now = T0) => guard.handleEvent({
		hookEventName: payload.hook_event_name || "PreToolUse",
		toolName: payload.tool_name,
		toolInput: payload.tool_input,
		toolResponse: payload.tool_response,
		toolUseId: payload.tool_use_id,
		agentId: payload.agent_id,
		sessionId: payload.session_id || "sess-1",
		root,
		env,
		tmpRoot,
		now,
		...(payload.readMemInfo !== undefined ? { readMemInfo: payload.readMemInfo } : (readMemInfo !== undefined ? { readMemInfo } : {})),
		...(payload.totalMemBytes !== undefined ? { totalMemBytes: payload.totalMemBytes } : (totalMemBytes !== undefined ? { totalMemBytes } : {})),
	});
	return { root, tmpRoot, budgetDir, env, fire };
}

test("concurrency limit blocks at maxConcurrent with running list and denied calls take no slot", (t) => {
	const { budgetDir, fire } = makeFixture(t, { maxConcurrent: 2 });
	assert.equal(fire({
		tool_name: "Agent",
		tool_use_id: "tu-1",
		tool_input: { subagent_type: "Explore", description: "구조 확인", prompt: "Inspect repo" },
	}, T0), null);
	assert.equal(fire({
		tool_name: "Task",
		tool_use_id: "tu-2",
		tool_input: { description: "테스트 분석", prompt: "Analyze tests" },
	}, T0 + MIN), null);
	assert.equal(guard.readCount("sess-1", budgetDir, T0 + MIN), 2);

	const blocked = fire({
		tool_name: "Agent",
		tool_use_id: "tu-3",
		tool_input: { description: "세 번째 호출", prompt: "Should block" },
	}, T0 + 2 * MIN);
	assert.ok(blocked, "third concurrent subagent is blocked");
	assert.match(blocked.reason, /지금 동시 2개 구동 중\(상한 2\)/);
	assert.match(blocked.reason, /2026-11-15T04:00:00\.000Z \| \[Explore\] 구조 확인/);
	assert.match(blocked.reason, /2026-11-15T04:01:00\.000Z \| 테스트 분석/);
	assert.equal(guard.readCount("sess-1", budgetDir, T0 + 2 * MIN), 2, "denied call did not add a slot");
});

test("foreground PostToolUse releases slot and allows the next spawn", (t) => {
	const { budgetDir, fire } = makeFixture(t, { maxConcurrent: 1 });
	assert.equal(fire({
		tool_name: "Agent",
		tool_use_id: "tu-fg-1",
		tool_input: { description: "앞단 작업" },
	}, T0), null);
	assert.ok(fire({
		tool_name: "Agent",
		tool_use_id: "tu-fg-2",
		tool_input: { description: "대기 작업" },
	}, T0 + 1000));

	fire({
		hook_event_name: "PostToolUse",
		tool_name: "Agent",
		tool_use_id: "tu-fg-1",
		tool_response: { status: "completed", content: "done" },
	}, T0 + 2000);
	assert.equal(guard.readCount("sess-1", budgetDir, T0 + 2000), 0);

	assert.equal(fire({
		tool_name: "Agent",
		tool_use_id: "tu-fg-2",
		tool_input: { description: "대기 작업" },
	}, T0 + 3000), null, "slot freed after foreground completion");
});

test("background subagent stays reserved on async_launched and frees on SubagentStop", (t) => {
	const { budgetDir, fire } = makeFixture(t, { maxConcurrent: 1 });
	assert.equal(fire({
		tool_name: "Agent",
		tool_use_id: "tu-bg-1",
		tool_input: { description: "배경 작업", run_in_background: true },
	}, T0), null);

	fire({
		hook_event_name: "PostToolUse",
		tool_name: "Agent",
		tool_use_id: "tu-bg-1",
		tool_response: { isAsync: true, status: "async_launched", agentId: "agent-bg-42" },
	}, T0 + 1000);
	assert.equal(guard.readCount("sess-1", budgetDir, T0 + 2000), 1, "async launch still occupies its slot");
	const blocked = fire({
		tool_name: "Agent",
		tool_use_id: "tu-bg-2",
		tool_input: { description: "추가 호출" },
	}, T0 + 2000);
	assert.match(blocked?.reason || "", /지금 동시 1개 구동 중\(상한 1\)/);

	fire({
		hook_event_name: "SubagentStop",
		agent_id: "agent-bg-42",
	}, T0 + 5000);
	assert.equal(guard.readCount("sess-1", budgetDir, T0 + 5000), 0);
	assert.equal(fire({
		tool_name: "Agent",
		tool_use_id: "tu-bg-2",
		tool_input: { description: "추가 호출" },
	}, T0 + 6000), null, "background slot opens after SubagentStop");
});

test("out-of-order SubagentStop before async_launched PostToolUse does not leak the slot", (t) => {
	const { budgetDir, fire } = makeFixture(t, { maxConcurrent: 1 });
	assert.equal(fire({
		tool_name: "Agent",
		tool_use_id: "tu-race-1",
		tool_input: { description: "빠른 배경 작업", run_in_background: true },
	}, T0), null);

	// SubagentStop arrives before PostToolUse(async_launched) wrote agentId.
	fire({ hook_event_name: "SubagentStop", agent_id: "agent-fast" }, T0 + 500);
	fire({
		hook_event_name: "PostToolUse",
		tool_name: "Agent",
		tool_use_id: "tu-race-1",
		tool_response: { status: "async_launched", agentId: "agent-fast" },
	}, T0 + 1000);
	assert.equal(guard.readCount("sess-1", budgetDir, T0 + 1500), 0);
	assert.equal(fire({
		tool_name: "Agent",
		tool_use_id: "tu-race-2",
		tool_input: { description: "후속 작업" },
	}, T0 + 2000), null);
});

test("PostToolUseFailure releases the reserved slot", (t) => {
	const { budgetDir, fire } = makeFixture(t, { maxConcurrent: 1 });
	assert.equal(fire({
		tool_name: "Task",
		tool_use_id: "tu-fail-1",
		tool_input: { description: "실패 예정" },
	}, T0), null);
	fire({
		hook_event_name: "PostToolUseFailure",
		tool_name: "Task",
		tool_use_id: "tu-fail-1",
	}, T0 + 1000);
	assert.equal(guard.readCount("sess-1", budgetDir, T0 + 1000), 0);
	assert.equal(fire({
		tool_name: "Task",
		tool_use_id: "tu-after-fail",
		tool_input: { description: "재시도" },
	}, T0 + 2000), null);
});

test("duplicate PreToolUse for the same tool_use_id (dual repo + user hooks) counts once", (t) => {
	const { budgetDir, fire } = makeFixture(t, { maxConcurrent: 1 });
	const payload = { tool_name: "Agent", tool_use_id: "tu-dup-1", tool_input: { description: "중복 훅 시험" } };
	assert.equal(fire(payload, T0), null);
	assert.equal(fire(payload, T0 + 10), null, "second hook registration for same tool_use_id passes");
	assert.equal(guard.readCount("sess-1", budgetDir, T0 + 20), 1);
	assert.ok(fire({ ...payload, tool_use_id: "tu-other" }, T0 + 30), "distinct second tool_use_id still blocks");
});

test("unclosed slot auto-releases after stale timeout so sessions never permanently lock", (t) => {
	const { budgetDir, fire } = makeFixture(t, { maxConcurrent: 1 });
	assert.equal(fire({
		tool_name: "Agent",
		tool_use_id: "tu-lost",
		tool_input: { description: "신호 유실 작업" },
	}, T0), null);
	assert.ok(fire({
		tool_name: "Agent",
		tool_use_id: "tu-early",
		tool_input: { description: "시한 전" },
	}, T0 + (guard.DEFAULT_STALE_MINUTES - 1) * MIN));

	const afterExpiry = T0 + guard.DEFAULT_STALE_MINUTES * MIN;
	assert.equal(guard.readCount("sess-1", budgetDir, afterExpiry), 0);
	assert.equal(fire({
		tool_name: "Agent",
		tool_use_id: "tu-recovered",
		tool_input: { description: "시한 뒤 복구" },
	}, afterExpiry), null);
});

test("legacy allow-subagents keys (maxSpawns, ignored windowMinutes) and legacy counter files ({spawns:8}) do not block", (t) => {
	// Legacy counter {spawns:8} + {maxSpawns:8, windowMinutes:60}
	const { root, budgetDir, fire } = makeFixture(t, { maxSpawns: 8, windowMinutes: 60 });
	fs.mkdirSync(budgetDir, { recursive: true });
	fs.writeFileSync(path.join(budgetDir, "sess-1.json"), JSON.stringify({
		spawns: 8,
		updatedAt: "2026-11-10T01:00:00.000Z",
	}));
	assert.equal(guard.readCount("sess-1", budgetDir, T0), 0);
	assert.equal(fire({
		tool_name: "Agent",
		tool_use_id: "tu-legacy-1",
		tool_input: { description: "옛 카운터 이후 첫 호출" },
	}, T0), null);

	// Sliding-window format {spawns:8, times:[...]} also treated as 0 active slots
	fs.writeFileSync(path.join(budgetDir, "sess-2.json"), JSON.stringify({
		spawns: 8,
		times: [T0 - 5000, T0 - 4000],
	}));
	assert.equal(fire({
		session_id: "sess-2",
		tool_name: "Agent",
		tool_use_id: "tu-legacy-2",
		tool_input: { description: "옛 창 카운터" },
	}, T0), null);

	// maxConcurrent takes precedence if both maxConcurrent and maxSpawns are present, capped at HARD_MAX_CONCURRENT (40)
	assert.equal(guard.HARD_MAX_CONCURRENT, 40);
	fs.writeFileSync(path.join(root, ".claude", "allow-subagents"), JSON.stringify({ maxConcurrent: 1, maxSpawns: 8 }));
	assert.equal(fire({ session_id: "sess-prec", tool_name: "Agent", tool_use_id: "tu-p1" }, T0), null);
	assert.ok(fire({ session_id: "sess-prec", tool_name: "Agent", tool_use_id: "tu-p2" }, T0 + 1));

	// Alpha-adk scale limit 40 works without clamping to 8; 41st is blocked with 상한 40
	fs.writeFileSync(path.join(root, ".claude", "allow-subagents"), JSON.stringify({ maxConcurrent: 100 }));
	for (let i = 0; i < 40; i++) {
		assert.equal(fire({ session_id: "sess-40", tool_name: "Agent", tool_use_id: `tu-a-${i}` }, T0 + i), null);
	}
	const block41 = fire({ session_id: "sess-40", tool_name: "Agent", tool_use_id: "tu-a-40" }, T0 + 41);
	assert.match(block41?.reason || "", /지금 동시 40개 구동 중\(상한 40\)/);
});

test("unknown opt-in keys still block and corrupt counters fail closed", (t) => {
	const { root, budgetDir, fire } = makeFixture(t, { badKey: 3 });
	const badOpt = fire({ tool_name: "Agent", tool_use_id: "tu-1" }, T0);
	assert.match(badOpt?.reason || "", /모르는 키가 있다: badKey/);
	assert.match(badOpt?.reason || "", /maxConcurrent/);

	fs.writeFileSync(path.join(root, ".claude", "allow-subagents"), JSON.stringify({ maxConcurrent: 2 }));
	fs.mkdirSync(budgetDir, { recursive: true });
	fs.writeFileSync(path.join(budgetDir, "sess-1.json"), "{corrupt");
	const corrupt = fire({ tool_name: "Agent", tool_use_id: "tu-2" }, T0);
	assert.match(corrupt?.reason || "", /카운터 손상/);
});

test("two role folders stay isolated across reserve and SubagentStop with the same session_id", (t) => {
	const f1 = makeFixture(t, { maxConcurrent: 1 }, { roleMode: true });
	const f2 = makeFixture(t, { maxConcurrent: 1 }, { roleMode: true });
	assert.equal(f1.fire({
		session_id: "shared-sess",
		tool_name: "Agent",
		tool_use_id: "tu-r1",
		tool_input: { description: "역할 A 배경 작업", run_in_background: true },
	}, T0), null);
	f1.fire({
		hook_event_name: "PostToolUse",
		session_id: "shared-sess",
		tool_name: "Agent",
		tool_use_id: "tu-r1",
		tool_response: { status: "async_launched", agentId: "agent-role-a" },
	}, T0 + 100);
	assert.ok(f1.fire({ session_id: "shared-sess", tool_name: "Agent", tool_use_id: "tu-r1b" }, T0 + 200));

	assert.equal(f2.fire({ session_id: "shared-sess", tool_name: "Agent", tool_use_id: "tu-r2" }, T0 + 300), null, "second role has independent budget");
	assert.equal(guard.readCount("shared-sess", f1.budgetDir, T0 + 300), 1);
	assert.equal(guard.readCount("shared-sess", f2.budgetDir, T0 + 300), 1);

	f1.fire({ hook_event_name: "SubagentStop", session_id: "shared-sess", agent_id: "agent-role-a" }, T0 + 400);
	assert.equal(guard.readCount("shared-sess", f1.budgetDir, T0 + 400), 0);
	assert.equal(guard.readCount("shared-sess", f2.budgetDir, T0 + 400), 1, "role B slot untouched");
});

test("CLI stdin handles PreToolUse, PostToolUse, SubagentStop, and fail-closed vs fail-open JSON errors", (t) => {
	const { root, env } = makeFixture(t, { maxConcurrent: 1 }, { roleMode: true });
	const runCli = (args, payload) => spawnSync(process.execPath, [HOOK_PATH, ...args], {
		cwd: root,
		env,
		input: typeof payload === "string" ? payload : JSON.stringify(payload),
		encoding: "utf8",
	});

	const pre1 = runCli([], {
		hook_event_name: "PreToolUse",
		session_id: "cli-sess",
		cwd: root,
		tool_name: "Agent",
		tool_use_id: "tu-cli-1",
		tool_input: { description: "CLI 시험", run_in_background: true },
	});
	assert.equal(pre1.status, 0);
	assert.equal(pre1.stdout.trim(), "");

	const asyncPost = runCli(["PostToolUse"], {
		session_id: "cli-sess",
		cwd: root,
		tool_name: "Agent",
		tool_use_id: "tu-cli-1",
		tool_response: { status: "async_launched", agentId: "cli-agent-1" },
	});
	assert.equal(asyncPost.status, 0);
	assert.equal(asyncPost.stdout.trim(), "");

	const pre2 = runCli([], {
		hook_event_name: "PreToolUse",
		session_id: "cli-sess",
		cwd: root,
		tool_name: "Agent",
		tool_use_id: "tu-cli-2",
		tool_input: { description: "CLI 막힘" },
	});
	assert.equal(pre2.status, 0);
	assert.equal(JSON.parse(pre2.stdout).decision, "block");
	assert.match(JSON.parse(pre2.stdout).reason, /지금 동시 1개 구동 중\(상한 1\)/);

	const stopBg = runCli(["SubagentStop"], {
		session_id: "cli-sess",
		cwd: root,
		agent_id: "cli-agent-1",
	});
	assert.equal(stopBg.status, 0);
	assert.equal(stopBg.stdout.trim(), "");

	const pre3 = runCli([], {
		hook_event_name: "PreToolUse",
		session_id: "cli-sess",
		cwd: root,
		tool_name: "Agent",
		tool_use_id: "tu-cli-3",
		tool_input: { description: "종료 뒤 재시도" },
	});
	assert.equal(pre3.status, 0);
	assert.equal(pre3.stdout.trim(), "");

	// Broken JSON on PreToolUse fails closed; broken JSON on SubagentStop fails open.
	const badPre = runCli([], "{broken");
	assert.equal(JSON.parse(badPre.stdout).decision, "block");
	const badStop = runCli(["SubagentStop"], "{broken");
	assert.equal(badStop.status, 0);
	assert.equal(badStop.stdout.trim(), "");
});

function makeMemInfoText(totalGb, availGb) {
	const totalKb = Math.round(totalGb * 1024 * 1024);
	const availKb = Math.round(availGb * 1024 * 1024);
	return `MemTotal:       ${totalKb} kB\nMemFree:        1048576 kB\nMemAvailable:   ${availKb} kB\n`;
}

test("memory-based auto cap scales from MemTotal without a fixed cap of 4 when maxConcurrent is unset", (t) => {
	// 8 GB total -> floor((8 - 4) / 0.5 / 2) = 4
	const f8 = makeFixture(t, {}, { readMemInfo: () => makeMemInfoText(8, 6.5) });
	for (let i = 1; i <= 4; i += 1) {
		assert.equal(f8.fire({ tool_name: "Agent", tool_use_id: `tu-8-${i}` }, T0 + i), null);
	}
	const block8 = f8.fire({ tool_name: "Agent", tool_use_id: "tu-8-5" }, T0 + 5);
	assert.match(block8?.reason || "", /지금 동시 4개 구동 중\(상한 4\)/);

	// 31 GB total -> floor((31 - 4) / 0.5 / 2) = 27 (no fixed cap at 4)
	const f31 = makeFixture(t, {}, { readMemInfo: () => makeMemInfoText(31, 20) });
	for (let i = 1; i <= 27; i += 1) {
		assert.equal(f31.fire({ tool_name: "Agent", tool_use_id: `tu-31-${i}` }, T0 + i), null);
	}
	const block31 = f31.fire({ tool_name: "Agent", tool_use_id: "tu-31-28" }, T0 + 28);
	assert.match(block31?.reason || "", /지금 동시 27개 구동 중\(상한 27\)/);

	// 4 GB total -> max(1, floor((4 - 4) / 0.5 / 2)) = 1
	const f4 = makeFixture(t, {}, { readMemInfo: () => makeMemInfoText(4, 5.5) });
	assert.equal(f4.fire({ tool_name: "Agent", tool_use_id: "tu-4-1" }, T0), null);
	const block4 = f4.fire({ tool_name: "Agent", tool_use_id: "tu-4-2" }, T0 + 1);
	assert.match(block4?.reason || "", /지금 동시 1개 구동 중\(상한 1\)/);
});

test("memory formula keys are configurable via allow-subagents without unknown-key errors", (t) => {
	// floor((32 - 8) / 2 / 2) = 6, capped by optional defaultMaxConcurrentCap = 5
	const f = makeFixture(
		t,
		{
			reserveMemGb: 8,
			memPerSubagentGb: 2,
			estimatedSessions: 2,
			defaultMaxConcurrentCap: 5,
		},
		{ readMemInfo: () => makeMemInfoText(32, 11) },
	);
	for (let i = 1; i <= 5; i += 1) {
		assert.equal(f.fire({ tool_name: "Agent", tool_use_id: `tu-cfg-${i}` }, T0 + i), null);
	}
	const capBlock = f.fire({ tool_name: "Agent", tool_use_id: "tu-cfg-6" }, T0 + 6);
	assert.match(capBlock?.reason || "", /지금 동시 5개 구동 중\(상한 5\)/);

	// Required MemAvailable becomes reserve(8) + max(1, perSubagent(2)) = 10GB
	const fLow = makeFixture(
		t,
		{ reserveMemGb: 8, memPerSubagentGb: 2, estimatedSessions: 2, defaultMaxConcurrentCap: 5 },
		{ readMemInfo: () => makeMemInfoText(32, 9.5) },
	);
	const lowBlock = fLow.fire({ tool_name: "Agent", tool_use_id: "tu-cfg-low" }, T0);
	assert.match(lowBlock?.reason || "", /남은 가용 메모리 9\.50GB가 최소 기준 10\.00GB/);
});

test("MemAvailable check blocks low memory regardless of active count and allows when sufficient", (t) => {
	let availGb = 4.25;
	const { budgetDir, fire } = makeFixture(
		t,
		{ maxConcurrent: 8 },
		{ readMemInfo: () => makeMemInfoText(32, availGb) },
	);
	const blocked = fire({ tool_name: "Agent", tool_use_id: "tu-low-1" }, T0);
	assert.match(blocked?.reason || "", /남은 가용 메모리 4\.25GB가 최소 기준 5\.00GB/);
	assert.match(blocked?.reason || "", /현재 동시 0개 구동 중, 세션 상한 8/);
	assert.equal(guard.readCount("sess-1", budgetDir, T0), 0, "memory block takes no concurrency slot");

	availGb = 5.0;
	assert.equal(fire({ tool_name: "Agent", tool_use_id: "tu-ok-1" }, T0 + 100), null);
	assert.equal(guard.readCount("sess-1", budgetDir, T0 + 100), 1);

	// Duplicate tool_use_id from dual registration remains idempotent
	assert.equal(fire({ tool_name: "Agent", tool_use_id: "tu-ok-1" }, T0 + 150), null);
	assert.equal(guard.readCount("sess-1", budgetDir, T0 + 150), 1);
});

test("missing /proc/meminfo skips MemAvailable guard and uses totalMemBytes fallback for auto cap", (t) => {
	// Simulates non-Linux hosts (e.g., macOS): readMemInfo returns null, totalMemBytes provides 16 GiB -> 12.
	const sixteenGiB = 16 * 1024 * 1024 * 1024;
	const f = makeFixture(
		t,
		{},
		{ readMemInfo: () => null, totalMemBytes: () => sixteenGiB },
	);
	for (let i = 1; i <= 12; i += 1) {
		assert.equal(f.fire({ tool_name: "Agent", tool_use_id: `tu-mac-${i}` }, T0 + i), null);
	}
	const capBlock = f.fire({ tool_name: "Agent", tool_use_id: "tu-mac-13" }, T0 + 13);
	assert.match(capBlock?.reason || "", /지금 동시 12개 구동 중\(상한 12\)/);
});
