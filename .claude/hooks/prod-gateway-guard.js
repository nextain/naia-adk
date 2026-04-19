#!/usr/bin/env node
/**
 * Prod Gateway Guard Hook (PreToolUse on Edit|Write)
 *
 * Blocks writing prod gateway credentials into .env.local files.
 * Dev projects should use naia-gateway-dev, not prod gateway.
 *
 * Exception: .env.production.local is allowed (Vercel deploy target).
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

	const toolName = data.tool_name || "";
	if (toolName !== "Edit" && toolName !== "Write") {
		process.exit(0);
	}

	const filePath = data.tool_input?.file_path || "";

	// Only check .env.local files (not .env.production.local — that's allowed to have prod values)
	const isEnvLocal =
		filePath.endsWith(".env.local") ||
		filePath.endsWith("/.env") ||
		filePath === ".env";

	if (!isEnvLocal) {
		process.exit(0);
	}

	const PROD_GATEWAY_URL = "naia-gateway-181404717065.asia-northeast3.run.app";
	const PROD_MASTER_KEY = "11ypvgv9LEBEeeOLXsJODhEyhCyQr36UzNA6nl5-Ptg";

	// For Write: check content. For Edit: check new_string.
	const contentToCheck =
		data.tool_input?.content || data.tool_input?.new_string || "";

	const hasProdUrl = contentToCheck.includes(PROD_GATEWAY_URL);
	const hasProdKey = contentToCheck.includes(PROD_MASTER_KEY);

	if (hasProdUrl || hasProdKey) {
		const detected = [
			hasProdUrl ? "prod GATEWAY_URL" : null,
			hasProdKey ? "prod MASTER_KEY" : null,
		]
			.filter(Boolean)
			.join(", ");

		const result = {
			decision: "block",
			reason:
				`[Harness] prod 게이트웨이 자격증명 차단: ${detected}\n` +
				".env.local에는 dev 게이트웨이를 사용해야 합니다.\n\n" +
				"  DEV URL:  https://naia-gateway-dev-181404717065.asia-northeast3.run.app\n" +
				"  DEV KEY:  qliT3Q4SC128rtR5o2dwud0vP25tu4usuvyFAP1oGAE\n\n" +
				"prod 값은 .env.production.local에만 허용됩니다.",
		};
		process.stdout.write(JSON.stringify(result));
		process.exit(0);
	}

	process.exit(0);
}

main().catch(() => process.exit(0));
