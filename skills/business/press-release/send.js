#!/usr/bin/env node
/**
 * Press Release Email Sender
 *
 * Usage:
 *   node send.js test                 — Send test email to yourself
 *   node send.js preview              — Print all recipients, no send
 *   node send.js send                 — Send to all contacts immediately
 *   node send.js send --delay 60      — Send with 60s delay between emails
 *   node send.js send --schedule "2026-04-14T09:00:00+09:00"  — Schedule send
 *   node send.js send --group priority — Send to priority group only
 */

const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

// ── Load .env manually (no dotenv dependency) ────────────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
	for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim();
		if (!process.env[key]) process.env[key] = val;
	}
}

// ── Config ───────────────────────────────────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SENDER_NAME = process.env.SENDER_NAME || "Nextain";
const SENDER_EMAIL = process.env.SENDER_EMAIL || SMTP_USER;
const TEST_RECIPIENT = process.env.TEST_RECIPIENT || SMTP_USER;

// ── Load contacts & template ─────────────────────────────────────────────
const contacts = JSON.parse(
	fs.readFileSync(path.join(__dirname, "contacts.json"), "utf8"),
);
const templatePath = path.join(__dirname, "template.html");
if (!fs.existsSync(templatePath)) {
	console.error("❌ template.html not found. Create it first.");
	process.exit(1);
}
const templateHtml = fs.readFileSync(templatePath, "utf8");

const subjectPath = path.join(__dirname, "subject.txt");
const subject = fs.existsSync(subjectPath)
	? fs.readFileSync(subjectPath, "utf8").trim()
	: "[보도자료] 넥스테인, AI 에이전트 특허 7건 출원 — SWDLC 전 주기 IP 확보";

// ── Transporter ──────────────────────────────────────────────────────────
function createTransporter() {
	return nodemailer.createTransport({
		host: SMTP_HOST,
		port: SMTP_PORT,
		secure: SMTP_PORT === 465,
		auth: { user: SMTP_USER, pass: SMTP_PASS },
	});
}

// ── Personalize template ─────────────────────────────────────────────────
function personalize(html, contact) {
	const isEditor = contact.name === "편집부" || contact.name === "보도자료";
	const greeting = isEditor
		? `보도자료를 보내드립니다. 관련하여 궁금하신 점이 있으시면 언제든 편하게 연락 주시기 바랍니다. (luke.yang@nextain.io)`
		: `${contact.note || "AI 관련"} 취재하고 계신 것으로 파악되어 넥스테인의 AI 에이전트가 개인화하여 보내드리는 보도자료입니다. 관련하여 궁금하신 점이 있으시면 언제든 편하게 연락 주시기 바랍니다. (luke.yang@nextain.io)`;
	const nameLabel = isEditor ? `${contact.outlet} 담당자` : `${contact.name} 기자`;
	return html
		.replace("{{name}} 기자님께,", `${nameLabel}님께,`)
		.replace(/{{greeting}}/g, greeting)
		.replace(/{{name}}/g, contact.name)
		.replace(/{{outlet}}/g, contact.outlet || "")
		.replace(/{{email}}/g, contact.email)
		.replace(/{{note}}/g, contact.note || "AI 관련");
}

/** Strip HTML tags for text/plain version */
function htmlToPlain(html) {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<\/tr>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&#8226;/g, "•")
		.replace(/&[a-z]+;/gi, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// Images are now referenced via URL (about.nextain.io), no CID attachments needed.

// ── Send one email ───────────────────────────────────────────────────────
async function sendOne(transporter, to, contact) {
	const html = personalize(templateHtml, contact);
	const info = await transporter.sendMail({
		from: `"${SENDER_NAME}" <${SENDER_EMAIL}>`,
		to,
		subject,
		html,
		text: htmlToPlain(html),
	});
	return info.messageId;
}

// ── Sleep helper ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Get recipients by group ──────────────────────────────────────────────
function getRecipients(group) {
	if (group === "priority") return contacts.priority || [];
	if (group === "general") return contacts.general || [];
	if (group === "outlet") return contacts.outlet_general || [];
	// all
	return [
		...(contacts.priority || []),
		...(contacts.general || []),
		...(contacts.outlet_general || []),
	];
}

// ── Dedup: prevent duplicate sends ───────────────────────────────────────
const crypto = require("crypto");
const SENT_LOG = path.join(__dirname, "sent-log.json");

function campaignId() {
	const date = new Date().toISOString().slice(0, 10);
	const hash = crypto.createHash("md5").update(subject).digest("hex").slice(0, 8);
	return `${date}-${hash}`;
}

function alreadySent(cid) {
	try {
		const log = JSON.parse(fs.readFileSync(SENT_LOG, "utf8"));
		return log.campaigns?.includes(cid);
	} catch {
		return false;
	}
}

function markSent(cid) {
	let log = { campaigns: [] };
	try { log = JSON.parse(fs.readFileSync(SENT_LOG, "utf8")); } catch {}
	if (!log.campaigns) log.campaigns = [];
	log.campaigns.push(cid);
	fs.writeFileSync(SENT_LOG, JSON.stringify(log, null, 2));
}

// ── Main ─────────────────────────────────────────────────────────────────
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
		return;
	}

	if (cmd === "test") {
		console.log(`\n📧 Sending test email to ${TEST_RECIPIENT}...`);
		const t = createTransporter();
		const testContact = { name: "양병석", outlet: "Nextain (테스트)", email: TEST_RECIPIENT };
		const msgId = await sendOne(t, TEST_RECIPIENT, testContact);
		console.log(`✅ Test sent! MessageId: ${msgId}`);
		return;
	}

	if (cmd === "send") {
		const testOnly = args.includes("--test-only");
		const cid = testOnly ? `test-${campaignId()}` : campaignId();
		const forceFlag = args.includes("--force");

		if (!testOnly && alreadySent(cid) && !forceFlag) {
			console.error(`\n🚫 Campaign ${cid} already sent! Use --force to override.`);
			process.exit(1);
		}

		const group = args.find((a, i) => args[i - 1] === "--group") || "all";
		const delayIdx = args.indexOf("--delay");
		const delaySec = delayIdx >= 0 ? Number(args[delayIdx + 1]) || 30 : 30;
		const scheduleIdx = args.indexOf("--schedule");
		const scheduleTime = scheduleIdx >= 0 ? args[scheduleIdx + 1] : null;

		// Lock immediately BEFORE sending (skip for test-only)
		if (!testOnly) markSent(cid);

		// --test-only: replace all recipients with TEST_RECIPIENT
		const realRecipients = getRecipients(group);
		const recipients = testOnly
			? realRecipients.map((c) => ({ ...c, email: TEST_RECIPIENT }))
			: realRecipients;

		if (testOnly) {
			console.log(`\n🧪 TEST MODE — all ${realRecipients.length} emails redirected to ${TEST_RECIPIENT}`);
		}
		console.log(`🔒 Campaign: ${cid}${testOnly ? " (test)" : " (locked)"}`);
		console.log(`📧 Sending to ${recipients.length} recipients (${group})`);
		console.log(`⏱  Delay: ${delaySec}s between emails`);

		if (scheduleTime) {
			const targetMs = new Date(scheduleTime).getTime() - Date.now();
			if (targetMs > 0) {
				const mins = Math.round(targetMs / 60000);
				console.log(`⏰ Scheduled: ${scheduleTime} (${mins}분 후)`);
				await sleep(targetMs);
			}
		}

		const t = createTransporter();
		let sent = 0;
		let failed = 0;

		for (const c of recipients) {
			try {
				const msgId = await sendOne(t, c.email, c);
				sent++;
				console.log(`  ✅ [${sent}/${recipients.length}] ${c.name} (${c.outlet}) — ${msgId}`);
			} catch (err) {
				failed++;
				console.error(`  ❌ [${sent + failed}/${recipients.length}] ${c.name} (${c.outlet}) — ${err.message}`);
			}
			if (sent + failed < recipients.length) {
				await sleep(delaySec * 1000);
			}
		}

		console.log(`\n📊 Result: ${sent} sent, ${failed} failed out of ${recipients.length}`);
		return;
	}

	console.log("Usage: node send.js [test|preview|send] [--group all|priority|general|outlet] [--delay 30] [--schedule ISO]");
}

main().catch((err) => {
	console.error("Fatal:", err.message);
	process.exit(1);
});
