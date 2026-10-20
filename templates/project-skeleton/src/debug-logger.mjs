/**
 * Naia ADK v0.2.0 — Structured Debug & Telemetry Logger (D47 Principle)
 * - Ring buffer MAX = 200 entries
 * - Default debug mode ON (explicitly toggleable)
 * - Global `error` and `unhandledrejection` automatic capture
 * - Secret / token / PII / raw media payload redaction
 * - Retention period (14 days) & size cap (10 MB) pruning helper
 * - Server collection helper (`POST /api/debug-log`)
 * - Exposes `window.__DEBUG__` API in browser environments
 */

export const MAX = 200;
export const MAX_LOG_ENTRIES = MAX;
export const RETENTION_DAYS = 14;
export const MAX_LOG_BYTES = 10 * 1024 * 1024;

const SECRET_KEY_RE = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential|ssn|phone|email)/i;
const SECRET_VALUE_RE = /\b(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g;
const RAW_MEDIA_RE = /^data:(?:image|audio|video|application\/octet-stream)\/[a-zA-Z0-9.+-]+;base64,/i;

const debugStore = {
  enabled: true,
  activeChannelFilter: 'ALL',
  retentionDays: RETENTION_DAYS,
  maxLogBytes: MAX_LOG_BYTES,
  entries: [],
  counters: {
    ENGINE: 0,
    RENDER: 0,
    NETWORK: 0,
    INPUT: 0,
    ERROR: 0,
    SYSTEM: 0,
  },
  metrics: {
    fps: 60,
    frameTimeMs: 16.6,
    lastErrorAt: null,
  },
  listeners: new Set(),
};

function sanitizeStringValue(str) {
  if (RAW_MEDIA_RE.test(str)) {
    return '[MEDIA_PAYLOAD_EXCLUDED]';
  }
  if (str.length > 8192) {
    return `${str.slice(0, 8192)}...[LARGE_PAYLOAD_TRUNCATED]`;
  }
  return str.replace(SECRET_VALUE_RE, '[REDACTED]');
}

export function sanitizeDetail(detail, depth = 0) {
  if (depth > 6) return '[MAX_DEPTH]';
  if (detail instanceof Error) {
    return {
      name: detail.name,
      message: sanitizeStringValue(String(detail.message || '')),
      stack: sanitizeStringValue(String(detail.stack || detail)),
    };
  }
  if (typeof detail === 'string') {
    return { value: sanitizeStringValue(detail) };
  }
  if (typeof ArrayBuffer !== 'undefined' && (detail instanceof ArrayBuffer || ArrayBuffer.isView(detail))) {
    return { value: '[BINARY_BUFFER_EXCLUDED]' };
  }
  if (Array.isArray(detail)) {
    return detail.map((item) => {
      if (typeof item === 'string') return sanitizeStringValue(item);
      if (typeof item === 'object' && item !== null) return sanitizeDetail(item, depth + 1);
      return item;
    });
  }
  if (typeof detail === 'object' && detail !== null) {
    const out = {};
    for (const [k, v] of Object.entries(detail)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else if (typeof v === 'string') {
        out[k] = sanitizeStringValue(v);
      } else if (typeof ArrayBuffer !== 'undefined' && (v instanceof ArrayBuffer || ArrayBuffer.isView(v))) {
        out[k] = '[BINARY_BUFFER_EXCLUDED]';
      } else if (typeof v === 'object' && v !== null) {
        out[k] = sanitizeDetail(v, depth + 1);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return { value: detail };
}

export function pruneRetentionEntries(
  entries = debugStore.entries,
  { retentionDays = RETENTION_DAYS, maxBytes = MAX_LOG_BYTES, nowMs = Date.now() } = {},
) {
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const kept = entries.filter((e) => (typeof e?.epochMs === 'number' ? e.epochMs >= cutoffMs : true));
  let totalBytes = 0;
  const bounded = [];
  for (let i = kept.length - 1; i >= 0; i--) {
    const serialized = JSON.stringify(kept[i]);
    const byteLen = serialized ? serialized.length : 0;
    if (totalBytes + byteLen > maxBytes && bounded.length > 0) {
      break;
    }
    totalBytes += byteLen;
    bounded.unshift(kept[i]);
  }
  return bounded;
}

export function logDebug(channel = 'ENGINE', event = 'log', detail = {}, level = 'INFO') {
  if (!debugStore.enabled && level !== 'ERROR') {
    return null;
  }
  const ch = String(channel || 'ENGINE').toUpperCase();
  debugStore.counters[ch] = (debugStore.counters[ch] || 0) + 1;

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    epochMs: Date.now(),
    channel: ch,
    level: String(level || 'INFO').toUpperCase(),
    event: String(event),
    detail: sanitizeDetail(detail),
  };

  debugStore.entries.push(entry);
  while (debugStore.entries.length > MAX_LOG_ENTRIES) {
    debugStore.entries.shift();
  }

  if (entry.level === 'ERROR') {
    debugStore.metrics.lastErrorAt = entry.ts;
  }

  for (const listener of debugStore.listeners) {
    try {
      listener(entry, debugStore);
    } catch {
      // Never let observer failure break application flow
    }
  }
  return entry;
}

export async function sendDebugLogToServer(payload = null, endpoint = '/api/debug-log', fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'fetch_unavailable' };
  }
  const body = payload || exportDebugSnapshot();
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sanitizeDetail(body)),
  });
  return { ok: res.ok, status: res.status };
}

export function updateDebugMetrics(patch = {}) {
  Object.assign(debugStore.metrics, patch);
  return debugStore.metrics;
}

export function getDebugStore() {
  return debugStore;
}

export function setDebugEnabled(flag) {
  debugStore.enabled = Boolean(flag);
  logDebug('SYSTEM', `Debug mode ${debugStore.enabled ? 'ENABLED' : 'DISABLED'}`, {
    enabled: debugStore.enabled,
  });
  return debugStore.enabled;
}

export function setDebugChannelFilter(channel = 'ALL') {
  debugStore.activeChannelFilter = String(channel || 'ALL').toUpperCase();
  return debugStore.activeChannelFilter;
}

export function getFilteredDebugEntries(limit = MAX_LOG_ENTRIES) {
  const ch = debugStore.activeChannelFilter;
  const list = ch === 'ALL' ? debugStore.entries : debugStore.entries.filter((e) => e.channel === ch);
  return list.slice(-Math.min(limit, MAX_LOG_ENTRIES));
}

export function clearDebugEntries() {
  debugStore.entries.length = 0;
  return debugStore.entries;
}

export function exportDebugSnapshot(appState = null) {
  return {
    exportedAt: new Date().toISOString(),
    maxEntries: MAX_LOG_ENTRIES,
    retentionDays: RETENTION_DAYS,
    maxLogBytes: MAX_LOG_BYTES,
    enabled: debugStore.enabled,
    metrics: { ...debugStore.metrics },
    counters: { ...debugStore.counters },
    appState: appState ? sanitizeDetail(structuredClone(appState)) : null,
    recentLogs: debugStore.entries.slice(-MAX_LOG_ENTRIES),
  };
}

export function onDebugLog(listener) {
  debugStore.listeners.add(listener);
  return () => debugStore.listeners.delete(listener);
}

export function installGlobalErrorHandlers(target = globalThis) {
  if (!target || typeof target.addEventListener !== 'function') {
    return () => {};
  }

  const onError = (ev) => {
    const errObj = ev?.error || ev;
    logDebug(
      'ERROR',
      ev?.message || errObj?.message || 'Uncaught window error',
      {
        filename: ev?.filename || null,
        lineno: ev?.lineno || null,
        colno: ev?.colno || null,
        stack: errObj?.stack || String(errObj),
      },
      'ERROR',
    );
  };

  const onUnhandledRejection = (ev) => {
    const reason = ev?.reason;
    logDebug(
      'ERROR',
      reason?.message || 'Unhandled promise rejection',
      {
        reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason),
      },
      'ERROR',
    );
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onUnhandledRejection);

  return () => {
    if (typeof target.removeEventListener === 'function') {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onUnhandledRejection);
    }
  };
}

export function createDebugApi() {
  return {
    MAX: MAX_LOG_ENTRIES,
    RETENTION_DAYS,
    MAX_LOG_BYTES,
    store: debugStore,
    log: logDebug,
    info: (ch, ev, detail) => logDebug(ch, ev, detail, 'INFO'),
    warn: (ch, ev, detail) => logDebug(ch, ev, detail, 'WARN'),
    error: (ch, ev, detail) => logDebug(ch, ev, detail, 'ERROR'),
    sanitizeDetail,
    pruneRetentionEntries,
    sendToServer: sendDebugLogToServer,
    updateMetrics: updateDebugMetrics,
    getEntries: getFilteredDebugEntries,
    setEnabled: setDebugEnabled,
    setFilter: setDebugChannelFilter,
    clear: clearDebugEntries,
    exportSnapshot: exportDebugSnapshot,
    onLog: onDebugLog,
    installGlobalErrorHandlers,
  };
}

const debugApi = createDebugApi();
installGlobalErrorHandlers(globalThis);

if (typeof window !== 'undefined') {
  window.__DEBUG__ = debugApi;
}
globalThis.__DEBUG__ = debugApi;
