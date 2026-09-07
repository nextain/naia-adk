#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

let prompt = "";
// Grok takes its single-turn prompt from a file rather than stdin. Read the
// staged file so prompt-driven fixture behaviour works for that backend too.
const promptFileIndex = process.argv.indexOf("--prompt-file");
if (promptFileIndex >= 0 && process.argv[promptFileIndex + 1]) {
	prompt = readFileSync(process.argv[promptFileIndex + 1], "utf8");
	queueMicrotask(run);
} else {
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => { prompt += chunk; });
	process.stdin.on("end", () => run());
	process.stdin.resume();
}

function run() {
const codex = process.argv.includes("exec");
	const structuredFailure = prompt.startsWith("__fake_structured_failure__") || prompt.startsWith("__fake_failure_then_success__");
	const failureThenSuccess = prompt.startsWith("__fake_failure_then_success__");
	const approvalUi = prompt.startsWith("__fake_approval_ui__");
	const stderrApprovalUi = prompt.startsWith("__fake_stderr_approval_ui__");
	const approvalTextInResult = prompt.startsWith("__fake_approval_text_in_result__");
		const oversizedToolThenSuccess = prompt.startsWith("__fake_oversized_tool_then_success__");
		const progressThenSuccess = prompt.startsWith("__fake_progress__");
		const meaningfulSession = prompt.startsWith("__fake_meaningful_session__");
	const quotaFailure = prompt.includes("__fake_quota_failure__");
	const successfulStderrQuota = prompt.includes("__fake_success_stderr_quota__");
	const successfulQuotaWords = prompt.includes("__fake_success_quota_words__");
	const successfulQuotaEnvelopeExample = prompt.includes("__fake_success_quota_envelope_example__");
		const nonzero = prompt.includes("__fake_nonzero__");
	const finalText = successfulQuotaWords ? "quota usage balance wording is ordinary response text" : successfulQuotaEnvelopeExample ? "quota envelope example is ordinary response text" : "fake-model-content";
	if (successfulQuotaEnvelopeExample) process.stdout.write('example: {"status_code":402} / {"code":"payment_required"}\n');
		const anyApprovalUi = approvalUi || stderrApprovalUi;
	if (codex) {
	console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-secret-not-persisted" }));
		console.log(JSON.stringify({ type: "turn.started" }));
		if (approvalUi) console.log(JSON.stringify({ type: "approval_required" }));
		if (oversizedToolThenSuccess) {
			console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution" } }));
			console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "x".repeat(300 * 1024) } }));
		}
		if (meaningfulSession) {
			console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "private-tool-command" } }));
			console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "private-tool-output" } }));
		}
		if (progressThenSuccess || meaningfulSession) console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "checking token=supersecretvalue /home/user/fixture-private-path" } }));
		console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: approvalTextInResult ? "The approval request text is diagnostic output, not an interactive prompt." : finalText } }));
		console.log(JSON.stringify(structuredFailure || anyApprovalUi ? { type: "turn.failed" } : { type: "turn.completed", usage: { input_tokens: 1 } }));
	if (failureThenSuccess) console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }));
} else if (process.argv.includes("run") && process.argv.includes("--pure")) {
	// OpenCode's stream has its own shape. Emitting the Claude shape here made
	// an opencode attempt look successful while carrying no deliverable result.
	console.log(JSON.stringify({ type: "step_start" }));
	if (progressThenSuccess) console.log(JSON.stringify({ type: "text", part: { text: "checking token=supersecretvalue /home/user/fixture-private-path" } }));
	console.log(JSON.stringify({ type: "text", part: { text: finalText } }));
	console.log(JSON.stringify(structuredFailure ? { type: "step_finish", error: { name: "fake" } } : { type: "step_finish" }));
	if (failureThenSuccess) console.log(JSON.stringify({ type: "step_finish" }));
} else {
	console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session-secret-not-persisted" }));
	if (progressThenSuccess) console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "checking token=supersecretvalue /home/user/fixture-private-path" }] } }));
	console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: finalText }] } }));
	console.log(JSON.stringify(structuredFailure ? { type: "result", subtype: "error", is_error: true } : { type: "result", subtype: "success", result: finalText }));
	if (failureThenSuccess) console.log(JSON.stringify({ type: "result", subtype: "success", result: "late-success" }));
}

	if (quotaFailure) {
		process.stderr.write('Error: Internal error: {\n  "message": "quota-account-secret-sentinel",\n  "http_status": 402\n}\n');
		process.exitCode = 1;
		return;
	}
	if (successfulStderrQuota) process.stderr.write('{"message":"quota-account-secret-sentinel","http_status":402}\n');

if (prompt.startsWith("__fake_grandchild__:") || prompt.startsWith("__fake_orphan__:")) {
	const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
	writeFileSync(prompt.slice(prompt.indexOf(":") + 1), String(grandchild.pid));
	if (prompt.startsWith("__fake_orphan__:")) grandchild.unref();
}

if (prompt.startsWith("__fake_marker__:")) writeFileSync(prompt.slice(prompt.indexOf(":") + 1), "started");
if (prompt.startsWith("__fake_cwd_marker__:")) writeFileSync(prompt.slice(prompt.indexOf(":") + 1), process.cwd());

if (prompt.startsWith("__fake_oversized_line__")) process.stdout.write("x".repeat(300 * 1024));

	if (stderrApprovalUi) process.stderr.write("permission request");

	if (prompt.startsWith("__fake_hang__") || anyApprovalUi || prompt.startsWith("__fake_grandchild__:") || prompt.startsWith("__fake_oversized_line__")) {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1_000);
} else {
	process.exitCode = nonzero ? 7 : 0;
}
}
