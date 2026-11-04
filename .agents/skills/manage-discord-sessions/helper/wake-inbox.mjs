import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertOwnerOnly, protectOwnerOnly } from "./platform-security.mjs";

const MAX_BYTES = 32_768;
const MAX_FILES = 4_096;
const snowflake = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);

// The existing Gateway service owns this inbox too; no second daemon is needed.
export class WakeInbox {
	constructor({ paths, bindings, submit }) {
		this.paths = paths;
		this.submit = submit;
		this.channels = new Set(bindings.map((binding) => binding.threadId ?? binding.channelId).filter(Boolean));
		mkdirSync(paths.wakeDirectory, { recursive: true, mode: 0o700 });
		protectOwnerOnly(paths.wakeDirectory, "directory", "Discord wake inbox");
		this.seen = {};
		if (existsSync(paths.wakeSeenPath)) {
			assertOwnerOnly(paths.wakeSeenPath, "file", "Discord wake cursor");
			const value = JSON.parse(readFileSync(paths.wakeSeenPath, "utf8"));
			if (value?.schemaVersion !== 1 || !value.seen || Array.isArray(value.seen) || typeof value.seen !== "object") throw new Error("invalid wake cursor");
			this.seen = value.seen;
		}
	}

	#save() {
		const temporary = `${this.paths.wakeSeenPath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, seen: this.seen })}\n`, { mode: 0o600, flag: "wx" });
		protectOwnerOnly(temporary, "file", "Discord wake cursor");
		renameSync(temporary, this.paths.wakeSeenPath);
	}

	async poll() {
		assertOwnerOnly(this.paths.wakeDirectory, "directory", "Discord wake inbox");
		const entries = readdirSync(this.paths.wakeDirectory).filter((name) => name.endsWith(".json")).sort();
		if (entries.length > MAX_FILES) throw new Error("wake inbox capacity exceeded");
		// Completed files can be removed by the owner without growing the cursor.
		const live = new Set(entries);
		for (const name of Object.keys(this.seen)) if (!live.has(name)) delete this.seen[name];
		const receipts = [];
		for (const name of entries) {
			const file = join(this.paths.wakeDirectory, name);
			const stat = lstatSync(file);
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			if (stat.size > MAX_BYTES) { receipts.push({ file: name, state: "rejected", reasonCode: "wake_too_large" }); continue; }
			assertOwnerOnly(file, "file", "Discord wake request");
			let bytes;
			const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_BYTES) continue;
				bytes = readFileSync(fd, "utf8");
			} finally { closeSync(fd); }
			const digest = createHash("sha256").update(bytes).digest("hex");
			if (Object.hasOwn(this.seen, name) && this.seen[name] === digest) continue;
			let receipt;
			try {
				const request = JSON.parse(bytes);
				if (request?.schemaVersion !== 1 || typeof request.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId) || !snowflake(request.sourceChannelId) || !snowflake(request.channelId) || !snowflake(request.authorId) || typeof request.content !== "string" || !request.content.trim() || request.content.length > 4_000 || (request.access != null && request.access !== "read-only")) throw new Error("invalid wake request");
				if (this.channels.has(request.sourceChannelId)) receipt = { state: "skipped", reasonCode: "channel_already_watched" };
				else {
					// Stable ingress identity also deduplicates a crash after admission but
					// before the cursor rename. It never widens participant authority.
					const identity = createHash("sha256").update(request.requestId).digest("hex").slice(0, 16);
					const sourceMessageId = String(9_000_000_000_000_000_000n + BigInt(`0x${identity}`) % 1_000_000_000_000_000_000n);
					receipt = await this.submit({ channelId: request.channelId, authorId: request.authorId, content: request.content, access: request.access ?? null, sourceMessageId });
				}
			} catch (error) {
				if (!(error instanceof SyntaxError) && error.message !== "invalid wake request") throw error;
				receipt = { state: "rejected", reasonCode: "invalid_wake_request" };
			}
			this.seen[name] = digest;
			this.#save();
			receipts.push({ file: name, ...receipt });
		}
		return receipts;
	}
}
