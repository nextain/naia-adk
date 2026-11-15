/**
 * 배포 관문 시한 감시.
 *
 * 훅이 판정을 못 내고 멈추면 Claude Code 는 시간 초과로 훅을 취소하고 명령을 그대로 실행한다.
 * 11/13 사고: 디스크가 꽉 찬 채 관문 둘이 1183초 멈췄고, 취소된 뒤 운영 대본 v0 가 승인 없이 돌았다.
 * 멈춘 관문은 CPU 를 쓰는 동기 루프라 같은 프로세스의 타이머로는 끊을 수 없다.
 * 그래서 관문 본문을 자식 프로세스로 돌리고, 부모가 시한 안에 답이 없으면 자식을 죽이고 막는다.
 */
const fs = require("fs");
const { spawn } = require("child_process");

const CHILD_ENV = "NAIA_HOOK_WATCHDOG_CHILD";
const DEFAULT_MS = 90000;

function writeAll(buf) {
	for (let o = 0; o < buf.length;) {
		try { o += fs.writeSync(1, buf, o); } catch (e) { if (e.code !== "EAGAIN") throw e; }
	}
}

function block(reason) {
	writeAll(Buffer.from(JSON.stringify({ decision: "block", reason })));
	process.exit(0);
}

/**
 * 자식이면 false 를 돌려 호출한 쪽이 본문을 그대로 돌게 한다.
 * 부모면 자식을 띄워 결과를 그대로 옮기고 true 를 돌린다(호출한 쪽은 본문을 돌리지 않는다).
 */
function runWithWatchdog({ script, args = [], env = {}, defaultMs = DEFAULT_MS, msEnvVar = "NAIA_DEPLOY_GUARD_WATCHDOG_MS", label = "운영 관문" }) {
	if (process.env[CHILD_ENV] === "1") return false;
	const rawMs = Number(process.env[msEnvVar]);
	const ms = Number.isFinite(rawMs) && rawMs > 0 ? rawMs : defaultMs;
	const secLabel = ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1);
	const child = spawn(process.execPath, [script, ...args], {
		env: { ...process.env, ...env, [CHILD_ENV]: "1" },
		stdio: ["pipe", "pipe", "inherit"],
	});
	const out = [];
	let settled = false;
	child.stdout.on("data", (b) => out.push(b));
	child.stdin.on("error", () => {});
	process.stdin.pipe(child.stdin);
	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		try { child.kill("SIGKILL"); } catch {}
		block(`[Harness] ${label}이 ${secLabel}초 안에 판정하지 못해 막습니다. 멈춘 관문은 시간 초과로 통과되므로 기다리지 않습니다(11/13 v0 사고). 디스크 여유(df -h /)와 상태 잠금을 확인한 뒤 다시 실행하십시오.`);
	}, ms);
	child.on("error", (e) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		block(`[Harness] ${label}을 띄우지 못해 막습니다: ${e.message}`);
	});
	child.on("close", (code, signal) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (signal) block(`[Harness] ${label}이 신호 ${signal} 로 끝나 막습니다.`);
		const output = Buffer.concat(out);
		writeAll(output);
		if (code !== 0) {
			if (code === 2 && output.length === 0) process.exit(2);
			block(`[Harness] ${label}이 비정상 종료(코드 ${code ?? "null"})해 막습니다.`);
		}
		process.exit(0);
	});
	return true;
}

module.exports = { runWithWatchdog, CHILD_ENV };
