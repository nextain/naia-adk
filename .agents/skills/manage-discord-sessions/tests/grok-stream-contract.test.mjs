import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectBackendLine } from "../helper/adapters.mjs";

// This is a pinned documentation contract, not a live inference receipt. The
// fixture envelopes below follow the system/init, assistant/message.content,
// user/tool_result, and terminal result forms in the source document.
const OFFICIAL_HEADLESS_PROVENANCE = Object.freeze({
	revision: "72a61251fcffb464bcc687aeb5a998e5a98ec0c9",
	path: "crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md",
	url: "https://raw.githubusercontent.com/xai-org/grok-build/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md",
	sha256: "333f8ccfb66e4a97019777788ed404c20cb305339063c63affe501147e8eac26",
	live_inference: false,
});

function inspect(message, lineNumber) {
	return inspectBackendLine({
		backendId: "grok",
		attemptId: "grok-doc-contract",
		lineNumber,
		line: JSON.stringify(message),
	});
}

test("Grok parses the pinned headless streaming-messages-json success envelope", () => {
	assert.equal(OFFICIAL_HEADLESS_PROVENANCE.live_inference, false);
	assert.match(OFFICIAL_HEADLESS_PROVENANCE.url, /72a61251fcffb464bcc687aeb5a998e5a98ec0c9/);
	const init = inspect({ type: "system", subtype: "init", session_id: "synthetic-session" }, 1);
	assert.equal(init.outcome, null);
	assert.deepEqual(init.events[0].safePayload, { backend: "grok" });

	const assistant = inspect({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect the requested file." },
				{ type: "tool_use", id: "synthetic-tool", name: "read_file", input: { path: "README.md" } },
			],
		},
	}, 2);
	assert.equal(assistant.assistantText, "I will inspect the requested file.");
	assert.equal(assistant.events.some((event) => event.kind === "tool_started" && event.safePayload.toolCategory === "read"), true);

	const toolResult = inspect({
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "synthetic-tool", content: "file contents" }] },
	}, 3);
	assert.equal(toolResult.outcome, null);
	assert.equal(toolResult.approvalRequested, false);

	const result = inspect({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "The requested file was inspected.",
		usage: { input_tokens: 12, output_tokens: 7 },
	}, 4);
	assert.equal(result.outcome, "success");
	assert.equal(result.transientResult, "The requested file was inspected.");
});

test("Grok preserves documented terminal errors and the separate approval boundary", () => {
	const error = inspect({
		type: "result",
		subtype: "error_during_execution",
		is_error: true,
		result: null,
		errors: [{ type: "execution_error", message: "synthetic failure" }],
	}, 5);
	assert.equal(error.outcome, "failure");
	assert.equal(error.transientResult, null);

	// The pinned headless document says streaming output is read-only and that
	// bidirectional approvals use ACP. This marker is therefore synthetic: it
	// tests the adapter's approval stop boundary without claiming that ACP
	// approval traffic is a streaming-messages-json event.
	const approval = inspect({
		type: "permission_request",
		request_id: "synthetic-approval",
		tool: "run_terminal_command",
	}, 6);
	assert.equal(approval.approvalRequested, true);
	assert.equal(approval.outcome, null);
});
