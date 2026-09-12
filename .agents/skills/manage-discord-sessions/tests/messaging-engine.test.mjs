import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createManagedRuntimeArtifact } from "../helper/cutover-managed-runtime.mjs";
import {
	installPinnedMessagingEngine,
	materializeMessagingRuntime,
	messagingRuntimeTreeId,
	resolveMessagingEngineSource,
	validateMessagingEngineLock,
} from "../helper/messaging-engine.mjs";
import { engineSnapshotDigest } from "../helper/messaging-snapshot.mjs";

const TOKEN_FINGERPRINT = "f".repeat(64);
const temporaryRoots = [];
const temporaryDirectory = (prefix) => {
	const root = mkdtempSync(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
};
test.after(() => temporaryRoots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function writeMessagingSource(root) {
	const files = {
		"LICENSE": "Apache-2.0\n",
		"package.json": `${JSON.stringify({ name: "naia-messaging", version: "0.0.0-test", type: "module" }, null, 2)}\n`,
		"core/index.mjs": "export {}\n",
		"adapters/discord/index.mjs": "export {}\n",
		"engine/discord/service.mjs": "export const entry = \"service\";\n",
		"engine/discord/supervisor-entry.mjs": "export const entry = \"supervisor\";\n",
		"runtime/engine-snapshot.mjs": "export {}\n",
	};
	for (const [relative, body] of Object.entries(files)) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body);
	}
	const lock = {
		schemaVersion: 1,
		repository: "nextain/naia-messaging",
		revision: "a".repeat(40),
		snapshotSha256: engineSnapshotDigest(root),
	};
	return { root, lock };
}

test("FE-MSG-1: lock schema rejects a bad digest or repository", () => {
	assert.throws(() => validateMessagingEngineLock({}), /invalid pinned engine lock/);
	assert.throws(() => validateMessagingEngineLock({
		schemaVersion: 1,
		repository: "nextain/naia-adk",
		revision: "a".repeat(40),
		snapshotSha256: "b".repeat(64),
	}), /invalid pinned engine lock/);
});

test("FE-MSG-2: digest mismatch does not activate a snapshot destination", () => {
	const source = writeMessagingSource(temporaryDirectory("msg-src-"));
	const destination = join(temporaryDirectory("msg-dst-"), "snap");
	const bad = { ...source.lock, snapshotSha256: "c".repeat(64) };
	assert.throws(() => installPinnedMessagingEngine({ sourceRoot: source.root, destination, lock: bad }), /digest mismatch/);
	assert.equal(existsSync(destination), false);
});

test("ET: pinned snapshot materializes engine entrypoints into helper/", () => {
	const source = writeMessagingSource(temporaryDirectory("msg-src-"));
	const parent = temporaryDirectory("msg-art-");
	const runtimePath = join(parent, "runtime/manage-discord-sessions");
	materializeMessagingRuntime({
		sourceRoot: source.root,
		snapshotDestination: join(parent, "naia-messaging"),
		lock: source.lock,
		runtimePath,
	});
	assert.equal(readFileSync(join(runtimePath, "helper/service.mjs"), "utf8"), "export const entry = \"service\";\n");
	assert.equal(readFileSync(join(runtimePath, "helper/supervisor-entry.mjs"), "utf8"), "export const entry = \"supervisor\";\n");
});

test("ET: createManagedRuntimeArtifact can bind a messaging engine instead of the git skill tree", () => {
	const source = writeMessagingSource(temporaryDirectory("msg-src-"));
	const adkRoot = temporaryDirectory("msg-adk-");
	const artifact = createManagedRuntimeArtifact({
		adkRoot,
		sourceRevision: source.lock.revision,
		sourceRuntimeTreeId: messagingRuntimeTreeId(source.lock),
		tokenFingerprint: TOKEN_FINGERPRINT,
		nodePath: process.execPath,
		messagingEngine: { sourceRoot: source.root, lock: source.lock },
	});
	assert.equal(artifact.manifest.sourceRevision, source.lock.revision);
	assert.equal(existsSync(join(artifact.runtimePath, "helper/service.mjs")), true);
	assert.match(artifact.service.content, /helper\/service\.mjs/);
});

test("resolveMessagingEngineSource honours NAIA_MESSAGING_ROOT", () => {
	const source = writeMessagingSource(temporaryDirectory("msg-src-"));
	const adkRoot = temporaryDirectory("msg-adk-");
	assert.equal(resolveMessagingEngineSource(adkRoot, {}), null);
	assert.equal(resolveMessagingEngineSource(adkRoot, { NAIA_MESSAGING_ROOT: source.root }), source.root);
});

test("example lock matches the published schema", () => {
	const example = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../engine-lock.example.json"), "utf8"));
	validateMessagingEngineLock(example);
	assert.equal(example.repository, "nextain/naia-messaging");
});
