#!/usr/bin/env node
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readWorkLedger } from './lib/ledger.mjs';

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

// The ledger remains the sole source; ordering is its own order, not inferred priority.
export function currentWork(rows) {
  return rows.filter(row => row.status === '진행 중').map(({ id, role, task, status, due_at, updated_at }) => ({ id, role, task, status, due_at, updated_at }));
}
export function renderBoard(rows, at) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.role)) groups.set(row.role, []);
    groups.get(row.role).push(row);
  }
  const sections = [...groups].map(([role, items]) => `<section><h2>${escapeHtml(role)}</h2><ul>${items.map(row => `<li><strong>${escapeHtml(row.task)}</strong><br><span>${escapeHtml(row.status)} · 기한: ${escapeHtml(row.due_at ?? '미정')} · 갱신: ${escapeHtml(row.updated_at)} · ID: ${escapeHtml(row.id)}</span></li>`).join('')}</ul></section>`).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>지금 하는 일</title><style>body{font:16px system-ui;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#222}li{margin:1rem 0}span,small{color:#555}</style></head><body><h1>지금 하는 일</h1><small>조회 시각: ${escapeHtml(at)} · 새로고침하면 장부를 다시 읽습니다.</small>${sections || '<p>열린 일이 없습니다.</p>'}</body></html>`;
}

export async function startWorkNowBoard({ ledgerPath, password = randomBytes(32).toString('base64url') }) {
  if (typeof ledgerPath !== 'string' || !ledgerPath.trim()) throw Error('ledger path required');
  if (typeof password !== 'string' || password.length < 32 || /[^A-Za-z0-9_-]/.test(password)) throw Error('invalid password');
  const ledger = resolve(ledgerPath);
  await readWorkLedger(ledger); // Fail before listening if the selected ledger cannot be read.
  const expected = Buffer.from(`Basic ${Buffer.from(`board:${password}`).toString('base64')}`);
  let port;
  const server = http.createServer(async (req, res) => {
    const send = (status, type, body, extra = {}) => { res.writeHead(status, { ...headers, 'Content-Type': type, ...extra }); res.end(body); };
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.forwarded || req.headers['x-forwarded-for'] || (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site']))) return send(403, 'text/plain; charset=utf-8', 'Forbidden');
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(401, 'text/plain; charset=utf-8', 'Authentication required', { 'WWW-Authenticate': 'Basic realm="Work board", charset="UTF-8"' });
    if (req.method !== 'GET' || !['/', '/api/work'].includes(req.url)) return send(404, 'text/plain; charset=utf-8', 'Not found');
    try {
      const rows = currentWork(await readWorkLedger(ledger));
      const at = new Date().toISOString();
      return req.url === '/api/work' ? send(200, 'application/json; charset=utf-8', JSON.stringify({ at, work: rows })) : send(200, 'text/html; charset=utf-8', renderBoard(rows, at));
    } catch {
      return send(503, 'text/plain; charset=utf-8', 'Work ledger unavailable');
    }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  port = server.address().port;
  return { server, port, password };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--ledger' || !args[1]) {
    console.error('Usage: node scripts/work-now-board.mjs --ledger <private-work-ledger.yaml>');
    process.exitCode = 2;
  } else {
    try {
      const { port, password } = await startWorkNowBoard({ ledgerPath: args[1] });
      console.log(`http://127.0.0.1:${port}/\nUsername: board\nPassword: ${password}`);
    } catch {
      console.error('Unable to start work board; check the selected ledger.');
      process.exitCode = 1;
    }
  }
}
