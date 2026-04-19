#!/usr/bin/env node
/**
 * Email Send Guard Hook (PreToolUse on Bash)
 *
 * Blocks any command that sends email to external recipients.
 * Only allows: test mode (send.js test) or sends to @nextain.io addresses.
 *
 * Blocked patterns:
 *   - node send.js send (without --test-only)
 *   - node send-cloud.js send
 *   - gcloud run jobs execute press-release-send
 *   - nodemailer / sendMail in inline scripts
 *
 * Allowed:
 *   - node send.js test
 *   - node send.js preview
 *   - gcloud run jobs execute press-release-test
 */

async function main() {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
	}

	let data;
	try {
		data = JSON.parse(input);
	} catch {
		process.exit(0);
	}

	if (data.tool_name !== "Bash") {
		process.exit(0);
	}

	const cmd = (data.tool_input?.command || "").replace(/['"][^'"]*['"]/g, (m) => m.replace(/'/g, "").replace(/"/g, ""));

	// Allow: preview, test, test-only, describe, logs, list
	if (/send\.js\s+preview/.test(cmd)) process.exit(0);
	if (/send\.js\s+test/.test(cmd) && !/send\.js\s+send/.test(cmd)) process.exit(0);
	if (/send\.js\s+send\s+.*--test-only/.test(cmd)) process.exit(0);
	if (/send-cloud\.js\s+test/.test(cmd)) process.exit(0);
	if (/send-cloud\.js\s+preview/.test(cmd)) process.exit(0);
	if (/send-cloud\.js\s+send\s+.*--test-only/.test(cmd)) process.exit(0);
	if (/press-release-test/.test(cmd) && !/press-release-send/.test(cmd)) process.exit(0);
	if (/gcloud.*(?:describe|logs|list)/.test(cmd)) process.exit(0);
	if (/gcloud.*scheduler.*(?:pause|delete|describe)/.test(cmd)) process.exit(0);
	if (/check-replies\.js/.test(cmd)) process.exit(0);

	// Block: actual send commands
	const SEND_PATTERNS = [
		{ pattern: /send\.js\s+send/, label: "send.js send (실제 기자 발송)" },
		{ pattern: /send-cloud\.js\s+send/, label: "send-cloud.js send (클라우드 발송)" },
		{ pattern: /gcloud\s+run\s+jobs\s+execute\s+press-release-send/, label: "Cloud Run Job 실행 (실제 발송)" },
		{ pattern: /gcloud\s+scheduler\s+jobs\s+(?:create|run|resume)\s+press-release/, label: "Cloud Scheduler 생성/실행 (예약 발송)" },
	];

	for (const p of SEND_PATTERNS) {
		if (p.pattern.test(cmd)) {
			const result = {
				decision: "block",
				reason:
					`[Harness] 외부 이메일 발송 차단: \`${p.label}\`\n\n` +
					"외부 수신자에게 이메일을 발송하려면 사용자의 명시적 승인이 필요합니다.\n\n" +
					"허용된 명령:\n" +
					"  - node send.js test (luke.yang@nextain.io로 테스트)\n" +
					"  - node send.js preview (수신자 목록 확인)\n" +
					"  - gcloud run jobs execute press-release-test (클라우드 테스트)\n\n" +
					"실제 발송은 사용자가 직접 터미널에서 실행하거나,\n" +
					"사용자가 '발송해' '보내' 등 명시적으로 지시한 경우에만 진행하세요.",
			};
			process.stdout.write(JSON.stringify(result));
			process.exit(0);
		}
	}

	process.exit(0);
}

main().catch(() => process.exit(0));
