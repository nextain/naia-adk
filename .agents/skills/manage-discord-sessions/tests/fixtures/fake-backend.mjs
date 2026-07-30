#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => run());
process.stdin.resume();

function run() {
const codex = process.argv.includes("exec");
const structuredFailure = prompt.startsWith("__fake_structured_failure__") || prompt.startsWith("__fake_failure_then_success__");
const failureThenSuccess = prompt.startsWith("__fake_failure_then_success__");
if (codex) {
	console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-secret-not-persisted" }));
	console.log(JSON.stringify({ type: "turn.started" }));
	console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fake-model-content" } }));
	console.log(JSON.stringify(structuredFailure ? { type: "turn.failed" } : { type: "turn.completed", usage: { input_tokens: 1 } }));
	if (failureThenSuccess) console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }));
} else {
	console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "session-secret-not-persisted" }));
	console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "fake-model-content" }] } }));
	console.log(JSON.stringify(structuredFailure ? { type: "result", subtype: "error", is_error: true } : { type: "result", subtype: "success", result: "fake-model-content" }));
	if (failureThenSuccess) console.log(JSON.stringify({ type: "result", subtype: "success", result: "late-success" }));
}

if (prompt.startsWith("__fake_grandchild__:") || prompt.startsWith("__fake_orphan__:")) {
	const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
	writeFileSync(prompt.slice(prompt.indexOf(":") + 1), String(grandchild.pid));
	if (prompt.startsWith("__fake_orphan__:")) grandchild.unref();
}

if (prompt.startsWith("__fake_marker__:")) writeFileSync(prompt.slice(prompt.indexOf(":") + 1), "started");

if (prompt.startsWith("__fake_oversized_line__")) process.stdout.write("x".repeat(300 * 1024));

if (prompt.startsWith("__fake_hang__") || prompt.startsWith("__fake_grandchild__:") || prompt.startsWith("__fake_oversized_line__")) {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1_000);
} else {
	process.exitCode = prompt.startsWith("__fake_nonzero__") ? 7 : 0;
}
}
