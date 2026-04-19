#!/usr/bin/env node
/**
 * Git Push Guard — PreToolUse on Bash
 * Blocks git push commands, requiring user confirmation.
 * Force push gets extra warning.
 *
 * Bypass: write an approval marker at .claude/git-push-approved.marker
 * Contents: JSON { "expiresAt": <epoch_ms>, "uses": <remaining_count> }
 * The marker is decremented on each allowed push and deleted when uses hits 0
 * or when expired.
 */
const fs = require("fs");
const path = require("path");

const MARKER_PATH = path.join(".claude", "git-push-approved.marker");

function checkAndConsumeApproval() {
	try {
		if (!fs.existsSync(MARKER_PATH)) return false;
		const raw = fs.readFileSync(MARKER_PATH, "utf8");
		const marker = JSON.parse(raw);
		const now = Date.now();
		if (!marker.expiresAt || marker.expiresAt < now) {
			// expired
			try { fs.unlinkSync(MARKER_PATH); } catch {}
			return false;
		}
		const uses = typeof marker.uses === "number" ? marker.uses : 1;
		if (uses <= 0) {
			try { fs.unlinkSync(MARKER_PATH); } catch {}
			return false;
		}
		// Consume one use
		const remaining = uses - 1;
		if (remaining <= 0) {
			try { fs.unlinkSync(MARKER_PATH); } catch {}
		} else {
			marker.uses = remaining;
			fs.writeFileSync(MARKER_PATH, JSON.stringify(marker));
		}
		return true;
	} catch {
		return false;
	}
}

async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;

	let data;
	try { data = JSON.parse(input); } catch { process.exit(0); }

	if ((data.tool_name || "") !== "Bash") process.exit(0);

	const command = data.tool_input?.command || "";

	// Strip quoted strings to avoid false positives
	const stripped = command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

	// Skip echo/printf without pipe
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|")) process.exit(0);

	// Match git push as real command
	if (!stripped.match(/(?:^|[;&|()$`])\s*git\s+push\b/m)) process.exit(0);

	// Detect force push
	const isForce = /git\s+push\s+.*(?:--force|-f)\b/.test(command);

	// Extract remote and branch
	const pushArgs = command.match(/git\s+push\s+(.*)/);
	let remote = "", branch = "";
	if (pushArgs) {
		const args = pushArgs[1].replace(/--[a-z-]+(=\S+)?/g, "").replace(/-[a-zA-Z]\s*/g, "").trim().split(/\s+/).filter(Boolean);
		if (args.length >= 1) remote = args[0];
		if (args.length >= 2) branch = args[1];
	}

	const remoteLabel = remote || "(default)";
	const branchLabel = branch || "(current branch)";

	// Check for approval marker — bypass if present and valid
	if (checkAndConsumeApproval()) {
		// Force push always requires fresh explicit approval per command
		// (not bypassable by bulk marker)
		if (isForce) {
			process.stdout.write(JSON.stringify({
				decision: "block",
				reason: `[Harness] ⚠️ FORCE PUSH는 일괄 승인 불가\n리모트: ${remoteLabel}, 브랜치: ${branchLabel}\n\nForce push는 매번 명시적 승인이 필요합니다.`
			}));
			process.exit(0);
		}
		// Normal push with valid marker — allow
		process.exit(0);
	}

	if (isForce) {
		process.stdout.write(JSON.stringify({
			decision: "block",
			reason: `[Harness] ⚠️ FORCE PUSH 차단\n리모트: ${remoteLabel}, 브랜치: ${branchLabel}\n\nForce push는 원격 히스토리를 덮어씁니다. 되돌릴 수 없습니다.\n사용자에게 확인받으세요.`
		}));
	} else {
		process.stdout.write(JSON.stringify({
			decision: "block",
			reason: `[Harness] git push 차단: 사용자 확인 필요\n리모트: ${remoteLabel}, 브랜치: ${branchLabel}\n명령: \`${command.trim().substring(0, 120)}\`\n\n원격 저장소에 push 전 사용자 확인이 필요합니다.\n\n사용자가 승인한 경우 다음 마커 파일 생성 후 재시도:\n  .claude/git-push-approved.marker\n  내용: { "expiresAt": <ms>, "uses": <n> }`
		}));
	}
	process.exit(0);
}
main().catch(() => process.exit(0));
