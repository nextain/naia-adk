import { createReadStream } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const modes = new Set(["codex-jsonl", "muse-jsonl", "claude-jsonl", "agy-jsonl"]);
export const isNativeResult = mode => modes.has(mode);

export function requireFreshInvocation(mode, command) {
  const args = command.slice(1);
  const opts = args.map(arg => arg.split("=", 1)[0]);
  const resumeOptions = ["resume", "fork", "--resume", "--continue", "--conversation", "--session-id",
    "--fork-session", "--from-pr", "--teleport", "--cloud", "--remote-agent"];
  const exec = mode === "codex-jsonl" || mode === "muse-jsonl";
  const format = (flag, value) => args.includes(flag + "=" + value) || args.some((arg, i) => arg === flag && args[i + 1] === value);
  const stream = format("--output-format", "stream-json");
  const print = args.includes("--print") || args.includes("-p");
  const required = exec
    ? args[0] === "exec" && args.includes("--json") && (mode !== "codex-jsonl" || args.includes("--ephemeral"))
    : mode === "agy-jsonl" ? !print && stream && format("--input-format", "stream-json")
    : print && stream && (!opts.includes("--input-format") || format("--input-format", "text"));
  // Claude also accepts attached short options such as -r<session>.
  if (!required || opts.some(arg => resumeOptions.includes(arg)) ||
      (mode === "claude-jsonl" && args.some(arg => /^-[^-]*[cr]/.test(arg)))) {
    throw new Error(mode + " requires a fresh non-interactive native session");
  }
}

// AGY's headless interface reads user events, not a positional print prompt.
// Also accept the single user envelope used by the existing review adapter.
export async function openWorkerPrompt(file, mode, directory) {
  if (mode !== "agy-jsonl") return open(file, "r");
  let text = await readFile(file, "utf8");
  let input;
  try { input = JSON.parse(text); } catch { /* plain task text */ }
  if (input?.event === "user" && (!input.message?.role || input.message.role === "user")) {
    const content = input.message?.content;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content) && content.length && content.every(p => p?.type === "text" && typeof p.text === "string")) {
      text = content.map(p => p.text).join("\n");
    }
  }
  const target = path.join(directory, "stdin");
  await writeFile(target, JSON.stringify({ event: "user", message: { role: "user", content: text } }) + "\n", { flag: "wx", mode: 0o600 });
  return open(target, "r");
}

function startId(mode, e) {
  switch (mode) {
    case "codex-jsonl": return e.type === "thread.started" && e.thread_id;
    case "muse-jsonl": return e.payload_type === "runtime.command.accepted" && e.sequence === 1 &&
      e.stream?.kind === "session" && e.payload?.command_kind === "turn.submit" && e.stream.id;
    case "claude-jsonl": return e.type === "system" && e.subtype === "init" && e.session_id;
    case "agy-jsonl": return e.event === "init" && e.conversation_id;
  }
}

// Parse the private stdout snapshot of the launched process. Only native
// envelopes can open or finish the run. Text inside an assistant message is data.
export async function readNativeResult(mode, file) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let session;
  let commandId;
  let answer;
  let completed = false;
  let codexTurn = false;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (!session) {
        if (mode === "claude-jsonl" && e.type === "system" && ["hook_started", "hook_response"].includes(e.subtype)) continue;
        session = startId(mode, e);
        if (typeof session !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,191}$/.test(session)) {
          throw new Error("Missing native session start");
        }
        commandId = e.payload?.command_id;
        continue;
      }
      if (completed || startId(mode, e)) throw new Error("Unexpected extra native session or turn");
      switch (mode) {
        case "codex-jsonl":
          if (e.thread_id && e.thread_id !== session) throw new Error("Codex thread ID changed");
          if (e.type === "turn.started") {
            if (codexTurn) throw new Error("Multiple native turns");
            codexTurn = true;
          }
          if (e.type === "turn.failed" || e.type === "error") throw new Error("Native Codex turn failed");
          if (codexTurn && e.type === "item.completed" && e.item?.type === "agent_message") answer = e.item.text;
          completed = codexTurn && e.type === "turn.completed";
          break;
        case "muse-jsonl":
          if (e.payload_type === "run.usage" && e.stream?.kind === "exec.usage" &&
              commandId && e.payload?.command_id === commandId && e.payload?.run_stream?.id === commandId) break;
          if (e.stream?.kind !== "session" || e.stream.id !== session || !commandId || e.payload?.command_id !== commandId) {
            throw new Error("Muse event belongs to another session or turn");
          }
          if (e.payload_type === "run.terminal.completed" && e.payload.terminal === "completed") {
            answer = e.payload.text;
            completed = true;
          }
          break;
        case "claude-jsonl":
          if (e.session_id && e.session_id !== session) throw new Error("Claude session ID changed");
          if (e.type === "result") {
            if (e.session_id !== session || e.subtype !== "success" || e.is_error) throw new Error("Claude session did not succeed");
            answer = e.result;
            completed = true;
          }
          break;
        case "agy-jsonl":
          if (e.step_update?.conversation_id && e.step_update.conversation_id !== session) throw new Error("AGY conversation ID changed");
          if (e.event === "result") {
            if (e.result?.conversation_id !== session || e.result.status !== "SUCCESS") throw new Error("AGY session did not succeed");
            answer = e.result.response;
            completed = true;
          }
          break;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!completed || typeof answer !== "string" || !answer.trim()) throw new Error("Missing completed native answer");
  return { session, answer };
}
