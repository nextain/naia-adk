#!/usr/bin/env node
/**
 * Press Release — Cloud Run sender
 *
 * Usage:
 *   node send-cloud.js test                                    — Send test via cloud
 *   node send-cloud.js preview                                 — Print recipients
 *   node send-cloud.js send                                    — Send now via cloud
 *   node send-cloud.js send --schedule "2026-04-13T08:55:00+09:00"  — Schedule
 */

const fs = require("fs");
const path = require("path");

// ── Load .env ────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
	for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		if (!process.env[trimmed.slice(0, eq).trim()])
			process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
}

// 배포처는 조직마다 다르다. CLOUD_URL 로 지정한다.
const CLOUD_URL = process.env.CLOUD_URL || "";
const PRESS_SECRET = process.env.PRESS_SECRET || "";

const contacts = JSON.parse(fs.readFileSync(path.join(__dirname, "contacts.json"), "utf8"));
const templateHtml = fs.readFileSync(path.join(__dirname, "template.html"), "utf8");
const subject = fs.readFileSync(path.join(__dirname, "subject.txt"), "utf8").trim();

function getRecipients(group) {
	if (group === "priority") return contacts.priority || [];
	if (group === "general") return contacts.general || [];
	if (group === "outlet") return contacts.outlet_general || [];
	return [...(contacts.priority || []), ...(contacts.general || []), ...(contacts.outlet_general || [])];
}

async function main() {
	const args = process.argv.slice(2);
	const cmd = args[0] || "preview";

	if (cmd === "preview") {
		const group = args.find((a, i) => args[i - 1] === "--group") || "all";
		const recipients = getRecipients(group);
		console.log(`\n📋 Recipients (${group}): ${recipients.length}명\n`);
		for (const c of recipients) {
			console.log(`  ${c.name.padEnd(6)} | ${c.outlet.padEnd(12)} | ${c.email}`);
		}
		console.log(`\n📧 Subject: ${subject}`);
		console.log(`🌐 Cloud: ${CLOUD_URL}`);
		return;
	}

	const group = args.find((a, i) => args[i - 1] === "--group") || "all";
	const scheduleIdx = args.indexOf("--schedule");
	const scheduleAt = scheduleIdx >= 0 ? args[scheduleIdx + 1] : undefined;
	const delayIdx = args.indexOf("--delay");
	const delaySec = delayIdx >= 0 ? Number(args[delayIdx + 1]) || 30 : 30;

	const payload = {
		secret: PRESS_SECRET,
		mode: cmd === "test" ? "test" : "send",
		contacts: getRecipients(group),
		subject,
		templateHtml,
		delaySec,
		scheduleAt,
	};

	console.log(`\n🚀 Sending to Cloud Run (${cmd})...`);
	if (scheduleAt) console.log(`⏰ Scheduled: ${scheduleAt}`);
	console.log(`📧 Recipients: ${cmd === "test" ? "1 (test)" : payload.contacts.length}`);

	// 배포처를 지정하지 않았으면 fetch 가 알 수 없는 오류로 죽는다. 먼저 말해 준다.
	if (!CLOUD_URL) {
		console.error("❌ CLOUD_URL is not set. Point it at your own press-release endpoint.");
		process.exit(1);
	}
	const res = await fetch(CLOUD_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!res.ok) {
		const err = await res.text();
		console.error(`❌ Cloud error (${res.status}): ${err}`);
		process.exit(1);
	}

	const result = await res.json();
	console.log(`\n📊 Result: ${result.sent} sent, ${result.failed} failed / ${result.total} total`);
	if (result.results) {
		for (const r of result.results) {
			const icon = r.status === "sent" ? "✅" : "❌";
			console.log(`  ${icon} ${r.email} ${r.messageId || r.error || ""}`);
		}
	}
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
