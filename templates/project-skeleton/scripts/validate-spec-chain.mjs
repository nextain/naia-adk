#!/usr/bin/env node
/**
 * Naia ADK v0.2.0 — Deterministic Specification Chain, Traceability & Link Integrity Validator
 * Validates:
 * 1. Project `adk.json` manifest (`kind: "project"`, `owner`, non-empty `responsible_human`, `keys/` isolation)
 * 2. Complete spec document chain:
 *    `00-USER-REQUESTS-traceability.ko.md` + `PC → SP/UC → RQ → FE → [UT → IT → E2E] → QC`
 *    + `08-AC-architecture-concepts.ko.md` (read right after PC: how the product works)
 * 3. Bidirectional traceability (REQ-LOG <-> PC <-> SP/UC <-> RQ <-> FE <-> UT/IT/E2E <-> QC)
 * 4. Markdown internal link integrity (all linked relative/repo files must exist)
 * 5. Structured Debug Logger (`src/debug-logger.mjs`: MAX=200 ring buffer, global error capture, `window.__DEBUG__`)
 * 6. Interactive Mermaid Viewer module (`scripts/lib/mermaid-viewer-client.mjs`: `wirePanZoom`, `openMermaidModal`)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REQUIRED_SPEC_FILES = [
  'docs/specs/00-USER-REQUESTS-traceability.ko.md',
  'docs/specs/01-PC-product-concept.ko.md',
  'docs/specs/02-SP-screen-plan.ko.md',
  'docs/specs/03-UC-user-scenarios.ko.md',
  'docs/specs/04-RQ-requirements.ko.md',
  'docs/specs/05-FE-feature-spec.ko.md',
  'docs/specs/06-UT-IT-E2E-test-plan.ko.md',
  'docs/specs/07-QC-adversarial-review.ko.md',
  'docs/specs/08-AC-architecture-concepts.ko.md',
];

export const REQUIRED_PROJECT_FILES = [
  'adk.json',
  'package.json',
  'README.md',
  'index.html',
  'src/debug-logger.mjs',
  'scripts/dev-server.mjs',
  'scripts/lib/mermaid-viewer-client.mjs',
  ...REQUIRED_SPEC_FILES,
];

function extractIds(text, prefix) {
  const regex = new RegExp(`\\b${prefix}-[0-9]{2,3}\\b`, 'g');
  return [...new Set(text.match(regex) || [])];
}

function extractMarkdownLinks(markdownText) {
  const links = [];
  const regex = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(markdownText)) !== null) {
    const rawTarget = match[1].trim().split(/\s+/)[0];
    if (
      !rawTarget ||
      rawTarget.startsWith('http://') ||
      rawTarget.startsWith('https://') ||
      rawTarget.startsWith('mailto:') ||
      rawTarget.startsWith('#')
    ) {
      continue;
    }
    links.push(rawTarget);
  }
  return links;
}

export async function validateProjectSpecChain(rootDir = defaultRoot) {
  const errors = [];

  // 1. Check required files
  for (const rel of REQUIRED_PROJECT_FILES) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`Missing required file: ${rel}`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // 2. Check adk.json manifest & keys/ isolation
  const adkManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'adk.json'), 'utf8'));
  if (adkManifest.kind !== 'project') {
    errors.push(`adk.json kind must be "project" (got: ${adkManifest.kind})`);
  }
  if (!adkManifest.owner || typeof adkManifest.owner !== 'string' || !adkManifest.owner.trim()) {
    errors.push('adk.json owner must be a non-empty string');
  }
  if (
    !adkManifest.responsible_human ||
    typeof adkManifest.responsible_human !== 'string' ||
    !adkManifest.responsible_human.trim()
  ) {
    errors.push('adk.json responsible_human must be a non-empty string');
  }
  const keysStat = fs.lstatSync(path.join(rootDir, 'keys'), { throwIfNoEntry: false });
  if (keysStat && keysStat.isSymbolicLink()) {
    errors.push('keys/ directory must NEVER be a symbolic link');
  }

  // 3. Read all spec chain files and verify bidirectional REQ-LOG traceability
  const contents = {};
  for (const rel of [...REQUIRED_SPEC_FILES, 'README.md']) {
    contents[rel] = fs.readFileSync(path.join(rootDir, rel), 'utf8');
  }

  const traceText = contents['docs/specs/00-USER-REQUESTS-traceability.ko.md'];
  const reqLogIds = extractIds(traceText, 'REQ-LOG');
  if (reqLogIds.length === 0) {
    errors.push('00-USER-REQUESTS-traceability.ko.md must declare at least one REQ-LOG-XX entry');
  }

  const stageChecks = [
    { file: 'docs/specs/01-PC-product-concept.ko.md', token: 'PC-01' },
    { file: 'docs/specs/08-AC-architecture-concepts.ko.md', token: 'AC-01' },
    { file: 'docs/specs/02-SP-screen-plan.ko.md', token: 'SP-01' },
    { file: 'docs/specs/03-UC-user-scenarios.ko.md', token: 'UC-01' },
    { file: 'docs/specs/04-RQ-requirements.ko.md', token: 'RQ-01' },
    { file: 'docs/specs/05-FE-feature-spec.ko.md', token: 'FE-01' },
    { file: 'docs/specs/06-UT-IT-E2E-test-plan.ko.md', token: 'UT-01' },
    { file: 'docs/specs/06-UT-IT-E2E-test-plan.ko.md', token: 'IT-01' },
    { file: 'docs/specs/06-UT-IT-E2E-test-plan.ko.md', token: 'E2E-01' },
    { file: 'docs/specs/07-QC-adversarial-review.ko.md', token: 'QC-01' },
  ];

  for (const sc of stageChecks) {
    const docText = contents[sc.file];
    if (!docText.includes(sc.token)) {
      errors.push(`${sc.file} is missing required stage identifier "${sc.token}"`);
    }
    for (const reqId of reqLogIds) {
      if (!docText.includes(reqId)) {
        errors.push(`Bidirectional traceability gap: ${sc.file} does not reference ${reqId}`);
      }
    }
  }

  // 3b. Enforce QC Information Barrier (negative check: QC must only reference REQ-LOG/PC/SP, never link to 03-UC or 05-FE or cite UC-XX/FE-XX item IDs)
  const qcText = contents['docs/specs/07-QC-adversarial-review.ko.md'];
  const qcLinks = extractMarkdownLinks(qcText);
  for (const l of qcLinks) {
    if (l.includes('03-UC-') || l.includes('05-FE-')) {
      errors.push(`QC information barrier violation: 07-QC-adversarial-review.ko.md must not link to UC or FE specs (found link "${l}")`);
    }
  }
  const qcUcIds = extractIds(qcText, 'UC');
  const qcFeIds = extractIds(qcText, 'FE');
  if (qcUcIds.length > 0 || qcFeIds.length > 0) {
    errors.push(
      `QC information barrier violation: 07-QC-adversarial-review.ko.md must not reference internal UC/FE item IDs (found: ${[...qcUcIds, ...qcFeIds].join(', ')})`,
    );
  }

  // 4. Verify Markdown internal link integrity across all docs
  for (const [docRel, text] of Object.entries(contents)) {
    const links = extractMarkdownLinks(text);
    const docDir = path.dirname(path.join(rootDir, docRel));
    for (const rawLink of links) {
      const cleanPath = rawLink.split('#')[0].split('?')[0];
      if (!cleanPath) continue;
      const candidateFromRoot = path.resolve(rootDir, cleanPath.replace(/^\/+/, ''));
      const candidateFromDoc = path.resolve(docDir, cleanPath);
      if (!fs.existsSync(candidateFromRoot) && !fs.existsSync(candidateFromDoc)) {
        errors.push(`Broken markdown link in ${docRel}: "${rawLink}" does not resolve to an existing file`);
      }
    }
  }

  // 5. Verify Debug Logger (D47: MAX=200 ring buffer + global error/unhandledrejection + secret/media redaction + retention pruning + /api/debug-log)
  const loggerUrl = pathToFileURL(path.join(rootDir, 'src/debug-logger.mjs')).href;
  const loggerMod = await import(loggerUrl);
  assert.equal(loggerMod.MAX, 200, 'debug-logger MAX must be 200');
  assert.equal(loggerMod.MAX_LOG_ENTRIES, 200, 'debug-logger MAX_LOG_ENTRIES must be 200');
  assert.equal(loggerMod.RETENTION_DAYS, 14, 'debug-logger RETENTION_DAYS must be 14');
  assert.ok(globalThis.__DEBUG__, 'globalThis.__DEBUG__ must be exposed');

  loggerMod.clearDebugEntries();
  for (let i = 0; i < 250; i++) {
    loggerMod.logDebug('ENGINE', `ring-test-${i}`, { index: i });
  }
  const store = loggerMod.getDebugStore();
  if (store.entries.length !== 200) {
    errors.push(`debug-logger ring buffer expected 200 entries after 250 logs, got ${store.entries.length}`);
  }

  // Verify secret / token / raw media redaction (D47 safety requirement)
  const redactedSample = loggerMod.sanitizeDetail({
    apiKey: 'sk-' + 'secret1234567890abcd', // 시험용 가짜 값(점검 도구 오탐 피함)
    authorization: 'Bearer secret.jwt.token',
    nested: { password: 'my-password', note: 'Token Bearer abcdef123456' },
    mediaData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA',
  });
  if (
    redactedSample.apiKey !== '[REDACTED]' ||
    redactedSample.authorization !== '[REDACTED]' ||
    redactedSample.nested?.password !== '[REDACTED]' ||
    !String(redactedSample.nested?.note).includes('[REDACTED]') ||
    redactedSample.mediaData !== '[MEDIA_PAYLOAD_EXCLUDED]'
  ) {
    errors.push('debug-logger sanitizeDetail failed to redact secrets/tokens/raw-media payloads');
  }

  // Verify retention pruning helper (D47 retention & size cap requirement)
  const nowMs = Date.now();
  const pruned = loggerMod.pruneRetentionEntries(
    [
      { id: 'expired', epochMs: nowMs - 20 * 24 * 60 * 60 * 1000 },
      { id: 'fresh', epochMs: nowMs - 1 * 24 * 60 * 60 * 1000 },
    ],
    { retentionDays: 14, nowMs },
  );
  if (pruned.length !== 1 || pruned[0].id !== 'fresh') {
    errors.push('debug-logger pruneRetentionEntries failed to prune entries older than retentionDays');
  }

  // Verify dev-server exposes /api/debug-log collection endpoint
  const devServerSource = fs.readFileSync(path.join(rootDir, 'scripts/dev-server.mjs'), 'utf8');
  if (!devServerSource.includes('/api/debug-log')) {
    errors.push('scripts/dev-server.mjs must expose /api/debug-log collection endpoint');
  }

  // Verify global error / unhandledrejection capture on a mock target
  const listeners = {};
  const mockTarget = {
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    removeEventListener(type) {
      delete listeners[type];
    },
  };
  const detach = loggerMod.installGlobalErrorHandlers(mockTarget);
  listeners.error?.({ message: 'Simulated global error', error: new Error('Boom') });
  listeners.unhandledrejection?.({ reason: new Error('Unhandled async boom') });
  detach();
  const snap = loggerMod.exportDebugSnapshot({ stage: 'validate' });
  if (!snap.recentLogs.some((e) => e.channel === 'ERROR' && e.event.includes('Simulated global error'))) {
    errors.push('debug-logger failed to capture global error event');
  }
  if (!snap.recentLogs.some((e) => e.channel === 'ERROR' && e.event.includes('Unhandled async boom'))) {
    errors.push('debug-logger failed to capture global unhandledrejection event');
  }

  // 6. Verify Interactive Mermaid Viewer Client Module
  const mermaidClientUrl = pathToFileURL(path.join(rootDir, 'scripts/lib/mermaid-viewer-client.mjs')).href;
  const mermaidMod = await import(mermaidClientUrl);
  const stageStub = { style: { transform: '' } };
  const labelStub = { textContent: '' };
  const vpHandlers = {};
  const vpStub = {
    addEventListener(type, fn) {
      vpHandlers[type] = fn;
    },
  };
  const panZoomCtrl = mermaidMod.wirePanZoom(vpStub, stageStub, labelStub, 1.0);
  panZoomCtrl.zoomIn();
  assert.equal(labelStub.textContent, '125%');
  panZoomCtrl.zoomOut();
  assert.equal(labelStub.textContent, '100%');
  panZoomCtrl.reset(1.0);
  assert.ok(stageStub.style.transform.includes('scale(1)'));

  return {
    ok: errors.length === 0,
    errors,
    reqLogCount: reqLogIds.length,
    specFilesVerified: REQUIRED_SPEC_FILES.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultRoot;
  validateProjectSpecChain(targetDir)
    .then((res) => {
      if (!res.ok) {
        console.error(`✗ Specification chain validation FAILED:\n  - ${res.errors.join('\n  - ')}`);
        process.exit(1);
      }
      console.log(`✓ 1/4 Project ADK manifest & keys/ isolation verified.`);
      console.log(`✓ 2/4 Bidirectional traceability (${res.reqLogCount} REQ-LOG item(s) across ${res.specFilesVerified} spec docs) verified.`);
      console.log(`✓ 3/4 Markdown internal link integrity verified (0 broken links).`);
      console.log(`✓ 4/4 Structured Debug Logger (MAX=200) & Interactive Mermaid Viewer client verified.`);
    })
    .catch((err) => {
      console.error(`✗ Unexpected validator error: ${err.stack || err.message}`);
      process.exit(1);
    });
}
