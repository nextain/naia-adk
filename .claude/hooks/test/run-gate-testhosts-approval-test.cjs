"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pin = require("../lib/gate-config-pin.js");

const repo = path.resolve(__dirname, "../../..");
const id = "123456789012345678", channelId = "234567890123456789", messageId = "345678901234567890";

function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-testhosts-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "root"), state = path.join(dir, "state");
	const install = path.join(dir, "install");
	fs.cpSync(path.join(repo, ".claude/hooks"), path.join(install, ".claude/hooks"), { recursive: true });
	fs.cpSync(path.join(repo, ".agents/hooks"), path.join(install, ".agents/hooks"), { recursive: true });
	const write = (rel, data) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
	const installWrite = (rel, data) => { const file = path.join(install, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(state, { recursive: true });
	write(".claude/deploy/config.json", "{}\n");
	const config = write("config/deploy-gate.json", JSON.stringify({ testHosts: ["box.example.invalid", "group.example.invalid"], discord: { instances: ["fixture"] } }));
	installWrite(".claude/hooks/instance/gate-approver.js", `module.exports = {discordUserId: ${JSON.stringify(id)}};`);
	installWrite(".agents/skills/manage-discord-sessions/helper/instance-paths.mjs", "export function messengerInstancePaths() { return {credentialsDirectory:'unused', configPath:'unused'}; }");
	installWrite(".agents/skills/manage-discord-sessions/helper/discord-config.mjs", "export function loadMessengerConfig() { return {discord:{credentialRef:'fixture'}}; } export class FileCredentialResolver { resolve() { return 'fixture-token'; } }");
	const log = path.join(dir, "fetch.log"), mock = path.join(dir, "mock.cjs");
	fs.writeFileSync(mock, `globalThis.fetch = async () => { require('fs').appendFileSync(process.env.FETCH_LOG, 'fetch\\n'); if (process.env.FETCH_FAIL === '1') throw Error('offline'); return {ok:true, json:async()=>JSON.parse(process.env.FETCH_MESSAGE)}; };`);
	const ref = () => ({ code: pin.approvalCode(pin.snapshotGateConfig(root).hash), channelId, messageId });
	const record = (r = ref()) => fs.writeFileSync(path.join(state, "gate-config-approval.json"), JSON.stringify(r));
	const run = (command, opts = {}) => {
		const message = { id: messageId, channel_id: channelId, author: { id }, content: ref().code, ...opts.message };
		const env = { PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: path.join(dir, "xdg"), DEPLOY_APPROVAL_STATE_DIR: state, CLAUDE_PROJECT_DIR: root, NODE_OPTIONS: `--require=${mock}`, FETCH_LOG: log, FETCH_MESSAGE: JSON.stringify(message), ...(opts.env || {}) };
		const cwd = opts.cwd || root;
		const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd, session_id: "fixture", hook_event_name: "PreToolUse" });
		const result = spawnSync(process.execPath, [path.join(install, ".claude/hooks/deploy-guard.js")], { cwd, env, input, encoding: "utf8", timeout: 20000 });
		assert.equal(result.status, 0, result.stderr);
		const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : {};
		return parsed.decision === "block" || parsed.hookSpecificOutput?.permissionDecision === "deny";
	};
	return { dir, root, install, state, config, log, ref, record, run, write, installWrite };
}

test("only a current human-approved snapshot permits host and resource group exceptions", (t) => {
	const f = fixture(t);
	const cmds = ["ssh box.example.invalid 'systemctl --user restart widget'", "az vm delete -n widget -g group.example.invalid"];
	for (const cmd of cmds) assert.equal(f.run(cmd), true, cmd);
	f.record();
	for (const cmd of cmds) assert.equal(f.run(cmd), false, cmd);
	assert.equal(f.run("ssh user@BOX.EXAMPLE.INVALID. 'systemctl --user restart widget'"), false, "approved host matching remains case and trailing-dot insensitive");
	assert.equal(f.run("ssh box.example.invalid 'az vm delete -n widget -g other.example.invalid'"), true, "approved outer host must not hide an inner mutation");
	const old = f.ref();
	fs.appendFileSync(f.config, " ");
	for (const cmd of cmds) assert.equal(f.run(cmd), true, cmd);
	f.record();
	for (const message of [{ author: { id: "456789012345678901" } }, { author: { id, bot: true } }, { webhook_id: "456789012345678901" }]) {
		for (const cmd of cmds) assert.equal(f.run(cmd, { message }), true, cmd);
	}
	for (const cmd of cmds) assert.equal(f.run(cmd, { env: { FETCH_FAIL: "1" } }), true, cmd);
	f.record(old);
	for (const cmd of cmds) assert.equal(f.run(cmd), true, cmd);
});

test("ordinary commands do not query Discord", (t) => {
	const f = fixture(t); f.record();
	for (const cmd of ["ls", "git status", "node --test", "ssh development.example.invalid ls"]) assert.equal(f.run(cmd), false, cmd);
	assert.equal(fs.existsSync(f.log), false);
});

test("sshAlwaysGated stays effective without approval, and config cannot nominate the approver", (t) => {
	const f = fixture(t);
	fs.writeFileSync(f.config, JSON.stringify({ testHosts: ["box.example.invalid"], sshAlwaysGated: [{ hosts: ["box.example.invalid"], service: "ssh:fixture" }], approver: id, discord: { instances: ["fixture"] } }));
	assert.equal(f.run("ssh box.example.invalid ls"), true);
	f.record();
	assert.equal(f.run("ssh box.example.invalid ls"), true);
	fs.writeFileSync(f.config, JSON.stringify({ testHosts: ["box.example.invalid"], approver: id, discord: { instances: ["fixture"] } }));
	f.record();
	fs.rmSync(path.join(f.install, ".claude/hooks/instance/gate-approver.js"));
	assert.equal(f.run("ssh box.example.invalid 'systemctl --user restart widget'"), true);
});

test("plugin and invalid production patterns retain their existing classifications", (t) => {
	const f = fixture(t);
	f.installWrite(".claude/hooks/instance/fixture-plugin.cjs", 'module.exports = { classifyCommand: command => /\\bfakeship\\b/.test(command) ? [{ service: "custom:fakeship", label: "fixture" }] : [] };');
	fs.writeFileSync(f.config, JSON.stringify({ testHosts: ["box.example.invalid"], plugin: "./.claude/hooks/instance/fixture-plugin.cjs", discord: { instances: ["fixture"] } }));
	f.record();
	for (const cmd of ["fakeship now", 'bash -c "fakeship now"']) assert.equal(f.run(cmd), true, cmd);
	fs.writeFileSync(f.config, JSON.stringify({ testHosts: ["box.example.invalid"], prodPatterns: [{ pattern: "(broken", service: "custom:broken" }], discord: { instances: ["fixture"] } }));
	f.record();
	assert.equal(f.run("ls"), true);
});

test("working directory cannot supply approver, token helpers, or plugin code", (t) => {
	const f = fixture(t);
	const commands = ["ssh box.example.invalid 'systemctl --user restart widget'", "az vm delete -n widget -g group.example.invalid"];
	const pinPath = path.join(f.install, ".claude/hooks/lib/gate-config-pin.js");
	const attack = `const p=require(${JSON.stringify(pinPath)});process.stdout.write(p.snapshotGateConfig(process.argv[2]).hash);process.exit(0);`;
	for (const dir of [path.join(f.dir, "outside"), path.join(f.root, "tmp/sub")]) {
		for (const [rel, content] of [["config/deploy-gate.json", fs.readFileSync(f.config)], [".claude/deploy/config.json", "{}"], [".claude/hooks/instance/gate-approver.js", attack]]) {
			const file = path.join(dir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
		}
		for (const cmd of commands) assert.equal(f.run(cmd, { cwd: dir }), true, `${dir}: ${cmd}`);
	}
	f.record();
	f.write(".agents/skills/manage-discord-sessions/helper/discord-config.mjs", `globalThis.fetch = async () => ({ok:true,json:async()=>JSON.parse(process.env.FORGED_MESSAGE)}); export function loadMessengerConfig(){return {discord:{credentialRef:'x'}}} export class FileCredentialResolver{resolve(){return 'x'}}`);
	assert.equal(f.run(commands[0], { message: { content: "no approval" }, env: { FORGED_MESSAGE: JSON.stringify({ id: messageId, channel_id: channelId, author: { id }, content: f.ref().code }) } }), true);
	f.write(".naia-role.json", "{}");
	assert.equal(f.run(commands[0], { env: { NAIA_ADK_ROOT: f.root } }), false, "role sessions use the executing hook's approver and helpers");
	const marker = path.join(f.dir, "plugin-ran");
	f.write("config/hostile.cjs", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = {};`);
	fs.writeFileSync(f.config, JSON.stringify({ testHosts: ["box.example.invalid"], plugin: "config/hostile.cjs", discord: { instances: ["fixture"] } }));
	assert.equal(f.run(commands[0]), true);
	assert.equal(fs.existsSync(marker), false);
	fs.writeFileSync(f.config, JSON.stringify({ plugin: path.join(f.root, "config/hostile.cjs") }));
	assert.equal(f.run("ls"), true);
	assert.equal(fs.existsSync(marker), false);
	f.installWrite(".claude/hooks/instance/escape.cjs", "");
	fs.unlinkSync(path.join(f.install, ".claude/hooks/instance/escape.cjs"));
	fs.symlinkSync(path.join(f.root, "config/hostile.cjs"), path.join(f.install, ".claude/hooks/instance/escape.cjs"));
	fs.writeFileSync(f.config, JSON.stringify({ plugin: ".claude/hooks/instance/escape.cjs" }));
	assert.equal(f.run("ls"), true);
	assert.equal(fs.existsSync(marker), false);
	const nested = path.join(f.install, "tmp/sub");
	f.installWrite("tmp/sub/config/deploy-gate.json", JSON.stringify({ plugin: "tmp/sub/hostile.cjs" }));
	f.installWrite("tmp/sub/hostile.cjs", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = {};`);
	assert.equal(f.run("ls", { cwd: nested }), true, "an attacker directory inside the install tree is not a trusted plugin directory");
	assert.equal(fs.existsSync(marker), false);
});

test("one classification reuses both successful and failed checks for the same snapshot", (t) => {
	const f = fixture(t); f.record();
	const cmd = Array(6).fill("ssh box.example.invalid 'systemctl --user restart widget'").join("; ");
	assert.equal(f.run(cmd), false);
	assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 1);
	fs.unlinkSync(f.log);
	assert.equal(f.run(cmd, { message: { content: "no approval" } }), true);
	assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 1);
	fs.unlinkSync(f.log);
	assert.equal(f.run(cmd), false);
	assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 1);
});

test("hook scope shares checks across classifications and never across invocations or hashes", (t) => {
	const f = fixture(t); f.record();
	const script = path.join(f.dir, "scope.cjs");
	fs.writeFileSync(script, `
const fs = require('fs');
const classifier = require(${JSON.stringify(path.join(f.install, ".claude/hooks/lib/deploy-command-classifier.js"))});
const pin = require(${JSON.stringify(path.join(f.install, ".claude/hooks/lib/gate-config-pin.js"))});
const root = ${JSON.stringify(f.root)}, state = ${JSON.stringify(f.state)}, config = ${JSON.stringify(f.config)};
const cmd = "ssh box.example.invalid 'systemctl --user restart widget'";
const check = () => classifier.classifyProdMutations(cmd, root, 0, false, root).length;
const result = [];
classifier.withGateApprovalCache(() => {
  result.push(check(), check());
  fs.appendFileSync(config, ' ');
  const code = pin.approvalCode(pin.snapshotGateConfig(root).hash);
  fs.writeFileSync(state + '/gate-config-approval.json', JSON.stringify({code,channelId:${JSON.stringify(channelId)},messageId:${JSON.stringify(messageId)}}));
  process.env.FETCH_MESSAGE = JSON.stringify({id:${JSON.stringify(messageId)},channel_id:${JSON.stringify(channelId)},author:{id:${JSON.stringify(id)}},content:code});
  result.push(check());
});
classifier.withGateApprovalCache(() => result.push(check()));
process.stdout.write(JSON.stringify(result));
`);
	const env = { PATH: process.env.PATH, HOME: f.dir, XDG_STATE_HOME: path.join(f.dir, "xdg"), DEPLOY_APPROVAL_STATE_DIR: f.state, CLAUDE_PROJECT_DIR: f.root, NODE_OPTIONS: `--require=${path.join(f.dir, "mock.cjs")}`, FETCH_LOG: f.log, FETCH_MESSAGE: JSON.stringify({ id: messageId, channel_id: channelId, author: { id }, content: f.ref().code }) };
	const result = spawnSync(process.execPath, [script], { cwd: f.root, env, encoding: "utf8", timeout: 20000 });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), [0, 0, 0, 0]);
	assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 3);
});
