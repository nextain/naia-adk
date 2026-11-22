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

// Muse may retry its first model request internally. Only a single model task
// whose provider attempts all ended in a 429 can be offered to another worker.
function museCapacityRefusal(events, session) {
  const start = ["runtime.command.accepted", "session.run.linked", "run.model.configured", "turn.input.user",
    "run.lifecycle.started", "task.stream.linked", "task.lifecycle.proposed", "task.lifecycle.accepted",
    "task.lifecycle.side_effect_intent", "task.lifecycle.started"];
  if (!start.every((type, i) => events[i]?.payload_type === type)) return false;
  const command = events[0].payload.command_id;
  const task = events[5].payload?.task_id;
  const usages = events.filter(e => e?.stream?.kind === "exec.usage");
  if (!command || !task || usages.length !== 1) return false;
  const usage = usages[0];
  const frames = events.filter(e => e !== usage);
  if (usage.payload_type !== "run.usage" || usage.payload?.command_id !== command || usage.payload?.run_stream?.id !== command ||
      usage.payload.completed_calls !== 0 || usage.payload.cancelled_calls !== 0 ||
      !frames.every((e, i) => e?.stream?.kind === "session" && e.stream.id === session && e.sequence === i + 1 &&
        e.payload?.command_id === command && (!e.payload.task_id || e.payload.task_id === task))) return false;
  if (frames[6]?.payload.event?.task_kind !== "model.meta.response" || frames[8]?.payload.event?.operation !== "model.meta.response") return false;
  const statuses = frames.slice(start.length, -2);
  const failed = frames.at(-2), terminal = frames.at(-1);
  if (failed?.payload_type !== "task.lifecycle.failed" || terminal?.payload_type !== "run.terminal.failed" ||
      terminal.payload.terminal !== "failed" || terminal.payload.text || !statuses.length || statuses.length % 2 !== 0 ||
      usage.payload.calls !== statuses.length / 2 || usage.payload.failed_calls !== usage.payload.calls) return false;
  return statuses.every((frame, i) => {
    const info = frame.payload.event?.details;
    const attempt = info?.facets?.find(f => f?.kind === "external_attempt");
    if (frame.payload_type !== "task.lifecycle.status" || frame.payload.task_id !== task ||
        attempt?.operation !== "model.response" || attempt.attempt !== Math.floor(i / 2) + 1) return false;
    if (i % 2 === 0) return info.phase === "opening_stream";
    return info.phase === (i === statuses.length - 1 ? "stream_failed" : "retry_scheduled") &&
      attempt.error_kind === "rate_limited" && attempt.http_status === 429;
  });
}

// Match only a provider's initial refusal. Any intervening assistant, tool or
// unknown event is evidence that work may already have started on this card.
export async function isInitialCapacityRefusal(mode, file) {
  if (!["codex-jsonl", "claude-jsonl", "muse-jsonl"].includes(mode)) return false;
  const input = await open(file, "r");
  let events;
  try {
    const limit = 128 * 1024;
    const size = (await input.stat()).size;
    if (!size || size > limit) return false;
    const buf = Buffer.alloc(size + 1);
    const { bytesRead } = await input.read(buf);
    if (bytesRead !== size) return false;
    events = buf.toString("utf8", 0, size).trim().split(/\r?\n/).map(line => JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  } finally { await input.close(); }
  const [start, second, third, last] = events;
  const session = start && startId(mode, start);
  if (typeof session !== "string" || !session) return false;
  if (mode === "muse-jsonl") return museCapacityRefusal(events, session);
  if (mode === "codex-jsonl") {
    const message = third?.message;
    return events.length === 4 && second?.type === "turn.started" && third?.type === "error" &&
      events.every(e => !e?.thread_id || e.thread_id === session) &&
      typeof message === "string" && /^you['’]ve hit your usage limit\b/i.test(message) &&
      last?.type === "turn.failed" && last.error?.message === message;
  }
  return events.length === 3 && second?.type === "assistant" && second.is_api_error_message === true &&
    second.error === "rate_limit" && second.api_error_status === 429 && second.session_id === session &&
    third?.type === "result" && third.is_error === true && third.api_error_status === 429 &&
    third.session_id === session && third.num_turns === 1 && third.usage?.input_tokens === 0 && third.usage?.output_tokens === 0;
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
