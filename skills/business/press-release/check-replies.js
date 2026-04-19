#!/usr/bin/env node
/**
 * Check email replies/bounces for press release campaigns.
 *
 * Usage:
 *   node check-replies.js                — Check last 24h
 *   node check-replies.js --hours 72     — Check last 72h
 *   node check-replies.js --subject "교회" — Filter by subject keyword
 */

const imaps = require("imap-simple");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");

// Load .env
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

const IMAP_HOST = process.env.IMAP_HOST || "outlook.office365.com";
const IMAP_PORT = Number(process.env.IMAP_PORT) || 993;
const IMAP_USER = process.env.SMTP_USER;
const IMAP_PASS = process.env.SMTP_PASS;

async function main() {
	const args = process.argv.slice(2);
	const hoursIdx = args.indexOf("--hours");
	const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) || 24 : 24;
	const subjectIdx = args.indexOf("--subject");
	const subjectFilter = subjectIdx >= 0 ? args[subjectIdx + 1] : null;

	const since = new Date(Date.now() - hours * 60 * 60 * 1000);
	const sinceStr = since.toISOString().slice(0, 10);

	console.log(`\n📬 Checking replies since ${sinceStr} (${hours}h)...\n`);

	const connection = await imaps.connect({
		imap: {
			host: IMAP_HOST,
			port: IMAP_PORT,
			user: IMAP_USER,
			password: IMAP_PASS,
			tls: true,
			authTimeout: 10000,
			tlsOptions: { rejectUnauthorized: false },
		},
	});

	await connection.openBox("INBOX");

	const criteria = ["ALL", ["SINCE", sinceStr]];
	const fetchOptions = { bodies: "", struct: true };
	const messages = await connection.search(criteria, fetchOptions);

	// Load contacts for matching
	const contacts = JSON.parse(fs.readFileSync(path.join(__dirname, "contacts.json"), "utf8"));
	const allContacts = [
		...(contacts.priority || []),
		...(contacts.general || []),
		...(contacts.outlet_general || []),
	];
	const contactEmails = new Set(allContacts.map((c) => c.email.toLowerCase()));

	const results = { bounces: [], replies: [], autoReplies: [], total: 0 };

	for (const msg of messages) {
		const raw = msg.parts.find((p) => p.which === "")?.body || "";
		const parsed = await simpleParser(raw);

		const from = (parsed.from?.value?.[0]?.address || "").toLowerCase();
		const subject = parsed.subject || "";
		const date = parsed.date ? parsed.date.toISOString() : "";

		// Filter by subject keyword if provided
		if (subjectFilter && !subject.includes(subjectFilter)) continue;

		// Classify
		const isBounce =
			from.includes("mailer-daemon") ||
			from.includes("postmaster") ||
			subject.includes("배달되지 않음") ||
			subject.includes("Undeliverable") ||
			subject.includes("couldn't be delivered");

		const isAutoReply =
			parsed.headers?.get("auto-submitted") === "auto-replied" ||
			subject.includes("자동 회신") ||
			subject.includes("부재중") ||
			subject.includes("Out of Office") ||
			subject.includes("Automatic reply");

		const isFromContact = contactEmails.has(from);

		if (isBounce) {
			// Extract failed recipient from body
			const bodyText = parsed.text || "";
			const recipientMatch = bodyText.match(/to\s+(\S+@\S+)/i) || bodyText.match(/Recipient.*?(\S+@\S+)/i);
			results.bounces.push({
				date,
				subject,
				failedRecipient: recipientMatch ? recipientMatch[1] : "unknown",
			});
		} else if (isAutoReply) {
			results.autoReplies.push({ date, from, subject });
		} else if (isFromContact) {
			results.replies.push({
				date,
				from,
				subject,
				snippet: (parsed.text || "").slice(0, 200),
			});
		}

		results.total++;
	}

	// Print results
	console.log(`📊 Scanned ${messages.length} messages, ${results.total} press-related\n`);

	if (results.bounces.length > 0) {
		console.log(`❌ Bounces (${results.bounces.length}):`);
		for (const b of results.bounces) {
			console.log(`  ${b.date.slice(0, 16)} → ${b.failedRecipient}`);
		}
		console.log();
	}

	if (results.replies.length > 0) {
		console.log(`💬 Journalist Replies (${results.replies.length}):`);
		for (const r of results.replies) {
			console.log(`  ${r.date.slice(0, 16)} ${r.from}`);
			console.log(`    Subject: ${r.subject}`);
			console.log(`    ${r.snippet.slice(0, 100)}...`);
		}
		console.log();
	}

	if (results.autoReplies.length > 0) {
		console.log(`🤖 Auto-replies (${results.autoReplies.length}):`);
		for (const a of results.autoReplies) {
			console.log(`  ${a.date.slice(0, 16)} ${a.from} — ${a.subject}`);
		}
		console.log();
	}

	if (results.bounces.length === 0 && results.replies.length === 0 && results.autoReplies.length === 0) {
		console.log("(관련 메일 없음)");
	}

	connection.end();
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
