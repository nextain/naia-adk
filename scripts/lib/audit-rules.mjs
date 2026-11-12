const MIN = 60000, HOUR = 60 * MIN;
const defaults = { reviewCap: 6, reviewBurst: 4, priorityIdleHours: 3, busyPerHour: 60, wakeCount: 50, wakeHours: 2, respondMinutes: 60, cycleMinutes: 30, blindInputs: 2 };
const t = value => typeof value === 'number' ? value : Date.parse(value);
const key = (code, target = '') => target ? `${code}:${target}` : code;

// Only independent, target-linked evidence can reset the lifetime review count.
export function validReset(e, target, now, verifyEvidence) {
  if (typeof verifyEvidence !== 'function' || verifyEvidence(e) !== true || e.target !== target || !(t(e.at) <= now)) return false;
  return (e.kind === 'other-role-review' && e.authorRole && e.auditedRole && e.authorRole !== e.auditedRole)
    || (e.kind === 'upstream-pr' && e.verified === true && e.otherRoleReview === true)
    || (e.kind === 'human-approval' && Boolean(e.humanMessageId));
}
export function resolvingEvidence(e, target, since, now) {
  return e.target === target && t(e.at) > since && t(e.at) <= now &&
    ((e.kind === 'status-transition' && e.from === 'blocked' && ['waiting', 'done', '대기', '끝'].includes(e.to)) || e.kind === 'human-approval-request');
}
export function priorityMismatch() { return { value: null, unknown: true, reason: 'S9 requires W3' }; }
export function initialState() { return { episodes: {}, reviewFiles: {}, lastCounts: {}, blindRuns: 0, initialized: false }; }

// State is passed in and returned; no filesystem or delivery side effects.
export function evaluate(signals, state, now, options = {}) {
  const cfg = { ...defaults, ...options }, next = structuredClone(state ?? initialState());
  const events = [], active = new Map(), uncertain = new Set(), unknownPlans = [];
  const add = (code, target, extra = {}) => active.set(key(code, target), { code, target, ...extra });
  const unknown = (...ids) => ids.some(id => signals[id]?.unknown !== false);
  const evidence = options.evidence ?? [];
  const coreMissing = ['S1','S3','S4','S6'].filter(id => signals[id]?.unknown !== false).length;
  const allUnknown = unknown('S1') && unknown('S3','S4','S8') && unknown('S5','S6') && unknown('S7');
  next.blindRuns = coreMissing >= cfg.blindInputs || allUnknown ? next.blindRuns + 1 : 0;
  if (Object.values(signals).some(s => s.unknown)) add('audit-degraded', '');
  if (next.blindRuns >= 2) add('audit-blind', '', { immediate: true });

  if (unknown('S1')) uncertain.add('repeat-review');
  else for (const p of signals.S1.value) {
    const names = p.files.map(f => f.name), prior = next.reviewFiles[p.plan];
    if (prior && prior.some(name => !names.includes(name))) { unknownPlans.push(`S1:${p.plan}`); uncertain.add(key('repeat-review', p.plan)); uncertain.add(key('cap-ignored', p.plan)); continue; }
    next.reviewFiles[p.plan] = names;
    const reset = evidence.filter(e => validReset(e, p.plan, now, options.verifyEvidence)).reduce((max,e) => Math.max(max,t(e.at)), -Infinity);
    const files = p.files.filter(f => t(f.at) > reset), count = files.length;
    const recent = files.filter(f => now - t(f.at) < HOUR).length;
    const epKey = key('repeat-review', p.plan), ep = next.episodes[epKey];
    const increased = count > (next.lastCounts[p.plan] ?? 0);
    if ((count > cfg.reviewCap || recent >= cfg.reviewBurst) && (recent > 0 || ep && increased)) {
      add('repeat-review', p.plan, { count, recent });
      if (ep && count >= ep.startCount + 2) add('cap-ignored', p.plan, { immediate: true, count });
    }
    next.lastCounts[p.plan] = count;
  }
  if (unknownPlans.length) add('audit-degraded', '');
  if (unknown('S3','S4','S8')) uncertain.add('priority-idle');
  else {
    const priority = options.priorityTarget ?? 'priority';
    const waiting = signals.S8.value.rows.some(r => r.target === priority && (r.approvalWaiting === true || r.status === 'human-approval-wait'));
    const s3 = signals.S3.value, busy = signals.S4.value.hours.some(h => t(h.at) >= s3.lastAt && h.total >= cfg.busyPerHour);
    if (!waiting && s3.idleHours >= cfg.priorityIdleHours && busy) add('priority-idle', priority, { deadline: s3.lastAt + 6*HOUR });
  }
  if (unknown('S5','S6')) uncertain.add('self-gate-change');
  else {
    const matches = signals.S5.value.edits.filter(e => now - t(e.at) < HOUR && signals.S6.value.some(f => t(e.at) >= t(f.at) && t(e.at)-t(f.at) <= HOUR));
    if (matches.length) {
      const independentlyReviewed = matches.every(edit => signals.S5.value.commits.some(c => typeof options.verifyEvidence === 'function' && options.verifyEvidence(c) === true && c.verified === true && c.otherRoleReview === true && c.pr && c.files?.includes(edit.file) && t(c.at) >= t(edit.at)));
      add('self-gate-change', '', { immediate: !independentlyReviewed, warningOnly: independentlyReviewed });
    }
  }
  if (unknown('S7')) uncertain.add('wake-backlog');
  else { const w = signals.S7.value; if (w.count >= cfg.wakeCount || w.oldestHours >= cfg.wakeHours) add('wake-backlog', '', { deadline: w.oldestAt + 4*HOUR }); }

  for (const [id, ep] of Object.entries(next.episodes)) {
    if (!active.has(id) && !uncertain.has(id) && !uncertain.has(ep.code)) { delete next.episodes[id]; events.push({ at: now, code: ep.code, target: ep.target, stage: 'recovered' }); }
  }
  for (const [id, found] of active) {
    if (found.code === 'audit-degraded') continue;
    let ep = next.episodes[id];
    if (!ep) {
      ep = next.episodes[id] = { code: found.code, target: found.target, at: now, startCount: found.count, warned: false, reported: false, deferrals: 0, evidenceIds: [], claimIds: [] };
    }
    if (next.initialized && !found.immediate && !ep.warned) { ep.warned = true; events.push({ at: now, code: found.code, target: found.target, stage: 'warn' }); }
    const deadline = found.deadline ?? ep.at + cfg.respondMinutes*MIN;
    const defer = () => { ep.deferUntil = Math.max(ep.deferUntil ?? deadline, now) + cfg.cycleMinutes*MIN; };
    const claims = evidence.filter(e => e.kind === 'method-claim' && e.target === found.target && t(e.at) > ep.at && t(e.at) <= now && !ep.claimIds.includes(e.id));
    for (const e of claims) { ep.claimIds.push(e.id); if (!ep.claimDeferred) { ep.claimDeferred = true; defer(); } ep.note = '방식 바꿈 주장(미검증)'; }
    if (found.code === 'cap-ignored') {
      const repeat = next.episodes[key('repeat-review', found.target)];
      if (repeat?.claimDeferred && !repeat.claimCapDeferred) {
        repeat.claimCapDeferred = true;
        ep.deferUntil = Math.max(ep.deferUntil ?? 0, now + cfg.cycleMinutes*MIN);
        ep.note = '방식 바꿈 주장(미검증)';
      }
    }
    const responses = evidence.filter(e => !ep.evidenceIds.includes(e.id) && resolvingEvidence(e, found.target, ep.at, now));
    for (const e of responses) { ep.evidenceIds.push(e.id); ep.deferrals++; if (ep.deferrals <= 2) defer(); }
    if (next.initialized && !found.warningOnly && !ep.reported && (ep.deferrals > 2 || found.immediate || now >= deadline) && (ep.deferrals > 2 || now >= (ep.deferUntil ?? 0))) {
      ep.reported = true; events.push({ at: now, code: found.code, target: found.target, stage: 'report' });
    }
  }
  next.initialized = true;
  return { state: next, events, active: [...active.values()], unknown: [...Object.entries(signals).filter(([,s]) => s.unknown).map(([id]) => id), ...unknownPlans] };
}
