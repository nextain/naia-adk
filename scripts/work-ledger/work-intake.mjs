import { createHash, randomUUID } from "node:crypto";
import { changeLedger, matchesSource, readLedger, safeName, taskForSource } from "./ledger.mjs";

// The provider may return replies before their parent. A reply can also point to
// an agent's answer, whose own reply reference leads back to the original task.
export function relatedSources(post, channel, parentChannel, messages, threadStarter) {
  const related = [];
  let current = post;
  let currentChannel = channel;
  const seen = new Set([post]);
  while (current?.reply_to_id) {
    currentChannel = current.reply_to_channel || currentChannel;
    related.push([currentChannel, current.reply_to_id]);
    current = messages.get(JSON.stringify([currentChannel, current.reply_to_id]));
    if (seen.has(current)) break;
    seen.add(current);
  }
  if (threadStarter && parentChannel !== channel) related.push([parentChannel, threadStarter]);
  return related;
}

// Adapters can return a newest-first page, even for events from the same
// millisecond. Process available parents before a reply can acquire its own ID.
export function orderForIntake(messages, parentChannel, threads) {
  const key = (channel, id) => JSON.stringify([channel, id]);
  const bySource = new Map(messages.map(m => [key(m.channel, m.id), m]));
  const starters = new Map([...threads].map(id => [id, id]));
  for (const m of messages) {
    if (m.channel === parentChannel && m.thread_id) starters.set(m.thread_id, m.id);
  }
  const seen = new Set();
  const ordered = [];
  function visit(m) {
    if (!m || seen.has(m)) return;
    seen.add(m);
    if (m.reply_to_id) visit(bySource.get(key(m.reply_to_channel || m.channel, m.reply_to_id)));
    if (starters.has(m.channel)) visit(bySource.get(key(parentChannel, starters.get(m.channel))));
    ordered.push(m);
  }
  for (const m of messages) visit(m);
  return { bySource, starters, ordered };
}

export function relatedTask(items, sources) {
  for (const [channel, id] of sources) {
    const item = taskForSource(items, channel, id);
    if (item) return item;
  }
}

export async function receiveWork({ root, roleConfig, ledger, source, related, revision, edited, now, minutes, title }) {
  function alreadyRecorded(item) {
    const event = item?.intake_messages?.find(e => matchesSource(e, source.channel, source.msg_id));
    if (event) return Date.parse(event.at) >= revision;
    // A role may already have handled the original using the ordinary add command.
    if (!item || !matchesSource(item.from, source.channel, source.msg_id)) return false;
    return !edited || Date.parse(item.checked_at || item.created_at) >= revision;
  }
  if (alreadyRecorded(taskForSource(ledger.items, source.channel, source.msg_id))) return ledger;
  if (!Number.isSafeInteger(minutes) || minutes < 1) throw new Error("intake.defaultDueMinutes must be a positive integer");
  return changeLedger(root, roleConfig.role, current => {
    let item = taskForSource(current.items, source.channel, source.msg_id);
    if (alreadyRecorded(item)) return;
    item ??= relatedTask(current.items, related);
    if (!item) {
      item = {
        id: randomUUID(), title, from: source, created_at: new Date(now).toISOString(),
        due: new Date(now + minutes * 60000).toISOString(), due_assumed: true,
        status: "open", worker: null, checked_at: null, note: "",
        ...(roleConfig.handoff ? { group: safeName(roleConfig.handoff.group) } : {}),
      };
      current.items.push(item);
    }
    item.intake_messages ??= [];
    let event = item.intake_messages.find(e => matchesSource(e, source.channel, source.msg_id));
    if (!event) {
      event = { channel: source.channel, msg_id: source.msg_id };
      item.intake_messages.push(event);
    }
    event.at = new Date(revision).toISOString();
    event.pending = { title, due: item.due };
  });
}

// The card and its pending notification are durable before any wake can be
// consumed. A retry publishes the same filename used by the delivery ledger.
export async function deliverIntake(root, role, publish) {
  const ledger = await readLedger(root, role);
  if (!ledger.items.some(item => item.intake_messages?.some(e => e.pending))) return [];
  return changeLedger(root, role, async current => {
    const wakes = [];
    for (const item of current.items) {
      for (const event of item.intake_messages ?? []) {
        if (!event.pending) continue;
        const key = createHash("sha256").update(JSON.stringify([event.channel, event.msg_id, event.at])).digest("hex");
        const reason = "접수한 작업";
        const wrote = await publish({
          stamp: event.at.replace(/\D/g, ""), role, id: "intake-" + key, reason,
          title: event.pending.title, details: `작업카드: ${item.id}\n출처: ${event.channel}/${event.msg_id}\n기한: ${event.pending.due}`,
          once: true,
        });
        delete event.pending;
        if (wrote) wakes.push({ role, id: item.id, reason });
      }
    }
    return wakes;
  });
}
