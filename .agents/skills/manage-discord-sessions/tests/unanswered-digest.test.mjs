import test from "node:test";
import assert from "node:assert/strict";
import { UnansweredDigest } from "../helper/unanswered-digest.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";

const id = (n) => String(BigInt(n) + 10n ** 17n);
const base = Date.UTC(2030, 0, 1);
const minute = 60_000;
const request = (n = 1) => ({ id: id(n), channel_id: id(2), guild_id: id(3), author: { id: id(4), bot: false }, timestamp: new Date(base).toISOString() });
const reply = (n = 5) => ({ ...request(6), author: { id: id(n), bot: true }, timestamp: new Date(base + minute).toISOString() });

test("human summary includes only 30-minute requests no older than two hours", () => {
	const digest = new UnansweredDigest();
	digest.track(request(), base);
	assert.equal(digest.due(base + 29 * minute).length, 0);
	assert.equal(digest.due(base + 120 * minute).length, 1);
	assert.deepEqual(digest.due(base + 120 * minute + 1), []);
	assert.equal(digest.entries.size, 0);
	digest.track(request(), base + 121 * minute);
	assert.equal(digest.entries.size, 0);
});

test("any configured team bot answers later in the same conversation", () => {
	const digest = new UnansweredDigest();
	digest.track(request(), base);
	digest.observeReply(reply(9), [id(5), id(7)], base + minute);
	assert.equal(digest.entries.size, 1);
	digest.observeReply({ ...reply(7), channel_id: id(8) }, [id(5), id(7)], base + minute);
	digest.observeReply({ ...reply(7), timestamp: new Date(base - minute).toISOString() }, [id(5), id(7)], base + minute);
	assert.equal(digest.entries.size, 1);
	digest.observeReply(reply(7), [id(5), id(7)], base + minute);
	assert.equal(digest.entries.size, 0);
});

test("digest marks sent entries and bounds memory", () => {
	const digest = new UnansweredDigest();
	for (let n = 0; n < 1_010; n++) digest.track(request(n), base);
	assert.equal(digest.entries.size, 1_000);
	const due = digest.due(base + 30 * minute);
	assert.equal(due.length, 10);
	digest.markSent(due);
	assert.ok(digest.due(base + 30 * minute).every((entry) => !due.includes(entry)));
});

function router(directMessage) {
	return new DiscordMessageRouter({
		config: { discord: { bindings: [], operatorUserIds: [id(4)], proactiveDmRecipientUserId: id(4), unansweredDigest: true, teamBotUserIds: [id(7)] } },
		store: { listOperationalJobs: () => [] }, botUserId: id(5), cwd: ".", token: "fixture-token", send: async () => ({}), directMessage, now: () => base + 30 * minute,
	});
}

test("watchdog sends configured operator a link-only digest once", async () => {
	const sent = [];
	const subject = router(async (input) => { sent.push(input); return { state: "confirmed" }; });
	subject.unansweredDigest.track({ ...request(), content: "private request body" }, base);
	await subject.watchdog();
	await subject.watchdog();
	assert.equal(sent.length, 1);
	assert.equal(sent[0].userId, id(4));
	assert.match(sent[0].content, /https:\/\/discord.com\/channels\//);
	assert.ok(!sent[0].content.includes("private request body"));
});

test("configured team bot clears digest while job admission still rejects it", async () => {
	const subject = router(async () => { throw new Error("unexpected DM"); });
	subject.unansweredDigest.track(request(), base);
	assert.deepEqual(await subject.onDispatch("MESSAGE_CREATE", reply(7), 1), { state: "rejected", reasonCode: "automated_sender" });
	await subject.watchdog();
	assert.equal(subject.unansweredDigest.entries.size, 0);
});

test("failed delivery remains eligible and expired entries never send", async () => {
	let count = 0;
	const subject = router(async () => { count++; throw new Error("offline"); });
	subject.unansweredDigest.track(request(), base);
	await subject.watchdog();
	assert.equal(subject.unansweredDigest.due(base + 31 * minute).length, 1);
	await subject.watchdog({ nowMs: base + 121 * minute });
	assert.equal(count, 1);
});


test("unconfirmed digest retries after existing job watchdog processes health", async () => {
	const events = [];
	let attempts = 0;
	const subject = router(async () => {
		assert.ok(events.some((event) => event.kind === "watchdog_intervened"));
		attempts++;
		return { state: "uncertain" };
	});
	subject.store = {
		listOperationalJobs: () => [{ jobId: "fixture-job", lifecycle: "running", activityHealth: { value: "unresponsive" } }],
		recordEvent: (event) => events.push(event),
	};
	subject.unansweredDigest.track(request(), base);
	assert.equal((await subject.watchdog()).noProgress, 1);
	await subject.watchdog();
	assert.equal(attempts, 2);
});
