#!/usr/bin/env node
/**
 * Deploy Guard Hook (PreToolUse on Bash) — policy-only adapter.
 * Envelope: ./_claude-bash-guard.js. Sanitizer: harness-core (unwrap).
 * Behavior byte-identical to original (G-OC01 part1 S2, pure refactor).
 * Blocks prod deploy unless approved via .claude/deploy/approvals.json.
 */
const fs = require("fs");
const path = require("path");
let H, core;
try {
	H = require("./_claude-bash-guard.js");
	core = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "harness-core.js"));
} catch {
	process.exit(0); // original main().catch fail-open
}

const DEPLOY_DIR = path.resolve(__dirname, "..", "deploy");
const CONFIG_PATH = path.join(DEPLOY_DIR, "config.json");
const APPROVALS_PATH = path.join(DEPLOY_DIR, "approvals.json");
const AUDIT_PATH = path.join(DEPLOY_DIR, "audit.jsonl");

const PROD_PATTERNS = [
	{ pattern: /\bvercel\b.*(?:--prod|--production)\b/, platform: "vercel", label: "vercel --prod" },
	{ pattern: /\bgcloud\s+run\s+deploy\s+(\S+)/, platform: "gcloud", label: "gcloud run deploy", serviceGroup: 1 },
	{ pattern: /\bgcloud\s+app\s+deploy\b/, platform: "gcloud", label: "gcloud app deploy" },
	{ pattern: /\bgcloud\s+builds?\s+submit\b/, platform: "gcloud", label: "gcloud builds submit", alwaysBlock: true },
	{ pattern: /\bgcloud\s+run\s+services?\s+update\s+(\S+)/, platform: "gcloud", label: "gcloud run services update", serviceGroup: 1 },
	{ pattern: /\bgcloud\s+run\s+services?\s+replace\b/, platform: "gcloud", label: "gcloud run services replace" },
	{ pattern: /\bdocker\s+push\s+\S*(?:pkg\.dev|gcr\.io)\b/, platform: "gcloud", label: "docker push (registry)" },
];

function loadJSON(filePath, fallback) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return fallback;
	}
}

function appendAudit(entry) {
	try {
		entry.ts = new Date().toISOString();
		fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + "\n");
	} catch {
		// Audit logging failure should not block
	}
}

function detectProject(command, config, cwd) {
	for (const [name, proj] of Object.entries(config.projects || {})) {
		if (proj.platform === "vercel" && /\bvercel\b/.test(command)) {
			if (/(?:--prod|--production)\b/.test(command)) {
				if (cwd.includes(proj.cwd)) return name;
			}
		}
		if (proj.platform === "gcloud" && /\bgcloud\s+run\s+deploy\b/.test(command)) {
			const serviceMatch = command.match(/gcloud\s+run\s+deploy\s+(\S+)/);
			if (serviceMatch) {
				const service = serviceMatch[1];
				if (name === service || proj.prod_command?.includes(service)) {
					if (proj.dev_service && service === proj.dev_service) continue;
					return name;
				}
			}
		}
	}

	if (/\bvercel\b/.test(command) && /(?:--prod|--production)\b/.test(command)) {
		for (const [name, proj] of Object.entries(config.projects || {})) {
			if (proj.platform === "vercel" && cwd.includes(proj.cwd)) return name;
		}
	}

	return null;
}

function findApproval(project) {
	const approvals = loadJSON(APPROVALS_PATH, { approvals: [] });
	const now = new Date();

	for (const approval of approvals.approvals || []) {
		if (approval.project !== project) continue;
		const expires = new Date(approval.expires_at);
		if (expires > now) {
			return approval;
		}
	}
	return null;
}

function consumeApproval(project, approvedAt) {
	try {
		const raw = fs.readFileSync(APPROVALS_PATH, "utf8");
		const approvals = JSON.parse(raw);
		const before = approvals.approvals.length;
		approvals.approvals = approvals.approvals.filter(
			(a) => !(a.project === project && a.approved_at === approvedAt && a.single_use)
		);
		if (approvals.approvals.length < before) {
			fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals, null, 2));
		}
	} catch {
		// Best-effort consumption
	}
}

H.start((command, data) => {
	// Strip quoted strings while preserving inner text
	const stripped = core.stripQuotesUnwrap(command);

	// Skip display-only commands (false positive prevention)
	if (/^\s*(echo|printf)\s/.test(stripped) && !stripped.includes("|")) {
		return null;
	}

	let matchedPattern = null;
	for (const p of PROD_PATTERNS) {
		if (p.pattern.test(stripped)) {
			matchedPattern = p;
			break;
		}
	}

	if (!matchedPattern) {
		return null;
	}

	// For gcloud: dev service allowed, never for alwaysBlock
	if (matchedPattern.platform === "gcloud" && matchedPattern.serviceGroup && !matchedPattern.alwaysBlock) {
		const serviceMatch = stripped.match(matchedPattern.pattern);
		if (serviceMatch) {
			const service = serviceMatch[matchedPattern.serviceGroup];
			const config = loadJSON(CONFIG_PATH, { projects: {} });
			for (const proj of Object.values(config.projects || {})) {
				if (proj.dev_service === service || service.endsWith("-dev")) {
					return null; // Dev service — allow
				}
			}
		}
	}

	const config = loadJSON(CONFIG_PATH, { projects: {} });
	const cwd = data.cwd || process.cwd();
	const project = detectProject(stripped, config, cwd);
	const sessionId = data.session_id || "unknown";

	const approval = findApproval(project);

	if (approval) {
		appendAudit({
			event: "executed",
			project: project || "unknown",
			session: sessionId,
			command: stripped.substring(0, 200),
			original_command: command.substring(0, 200),
			approved_by: approval.approved_by,
			approval_expires: approval.expires_at,
		});

		if (approval.single_use) {
			consumeApproval(project, approval.approved_at);
			appendAudit({
				event: "approval_consumed",
				project: project || "unknown",
				single_use: true,
			});
		}

		return null;
	}

	appendAudit({
		event: "blocked",
		project: project || "unknown",
		command: stripped.substring(0, 200),
		session: sessionId,
		reason: project ? "no_approval" : "unknown_project",
	});

	const projectLabel = project || "(project not detected from cwd)";
	const remainingMin = config.default_ttl_minutes || 30;

	return {
		reason:
			`[Harness] prod 배포 명령 차단: \`${matchedPattern.label}\`\n` +
			`프로젝트: ${projectLabel}\n\n` +
			"prod 배포는 사전 승인이 필요합니다.\n\n" +
			"승인 방법:\n" +
			`  1. .claude/deploy/approvals.json에 "${project || "project"}" 승인 항목 추가\n` +
			`  2. 또는 .claude/deploy/prod-deploy.sh 사용\n\n` +
			`승인 TTL: ${remainingMin}분\n` +
			"AI는 prod 배포를 직접 실행하지 않습니다.",
	};
});
