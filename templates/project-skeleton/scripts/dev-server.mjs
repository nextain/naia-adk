#!/usr/bin/env node
/**
 * Naia ADK v0.2.0 — Project Studio Dev & Document Server with Live-Reload (SSE)
 * - GET / or /docs : Split Studio View (Left Doc Tree + Center Interactive Mermaid Viewer + Right Play Dock)
 * - GET /play      : Standalone Playable Preview (index.html)
 * - GET /api/docs  : Specification chain catalog
 * - GET /api/events: SSE live-reload stream
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.md': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
};

export function collectDocs(rootDir = defaultRoot) {
  const specsDir = fs.existsSync(path.join(rootDir, 'docs/specs')) ? 'docs/specs' : 'docs/spec';
  return [
    {
      group: '0. 🗣️ 요구사항 원문 기록 & 검증 추적',
      items: [
        { title: '📋 사용자 요구사항 원문 & 추적표 (REQ-LOG)', path: `${specsDir}/00-USER-REQUESTS-traceability.ko.md` },
        { title: '🛡️ [QC] 독립 적대적 타당성 확인 보고서', path: `${specsDir}/07-QC-adversarial-review.ko.md` },
      ],
    },
    {
      group: '1. 표준 명세 사슬 (PC → SP/UC → RQ → FE → UT/IT/E2E)',
      items: [
        { title: '① [PC] 상위기획 (Product Concept)', path: `${specsDir}/01-PC-product-concept.ko.md` },
        { title: '② [SP] 화면기획 (Screen Plan)', path: `${specsDir}/02-SP-screen-plan.ko.md` },
        { title: '③ [UC] 사용자 시나리오 (User Scenarios)', path: `${specsDir}/03-UC-user-scenarios.ko.md` },
        { title: '④ [RQ] 요구사항 및 수용기준 (Requirements)', path: `${specsDir}/04-RQ-requirements.ko.md` },
        { title: '⑤ [FE] 기능명세 (Feature Spec)', path: `${specsDir}/05-FE-feature-spec.ko.md` },
        { title: '⑥ [UT/IT/E2E] 단계별 검증 계획 및 영수증', path: `${specsDir}/06-UT-IT-E2E-test-plan.ko.md` },
      ],
    },
    {
      group: '2. 프로젝트 안내 & 매니페스트',
      items: [
        { title: '🏠 프로젝트 소개 (README.md)', path: 'README.md' },
        { title: '⚙️ ADK 매니페스트 (adk.json)', path: 'adk.json' },
      ],
    },
  ];
}

export function renderDocsHtml(projectName = '{{PROJECT_NAME}}') {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>🕹️ ${projectName} — 기획 & 플레이 통합 스튜디오</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      flowchart: { useMaxWidth: false, htmlLabels: true, padding: 10 },
    });
    window.__mermaid = mermaid;
  </script>
  <style>
    :root {
      --bg: #0b1120; --sidebar: #111827; --card: #1e293b;
      --border: #334155; --accent: #38bdf8; --gold: #facc15;
      --text: #f8fafc; --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif;
      background: var(--bg); color: var(--text); height: 100vh;
      display: flex; flex-direction: column; overflow: hidden;
    }
    header {
      height: 50px; background: var(--sidebar); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between; padding: 0 16px;
    }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 800; }
    .toggle-btn, .mermaid-btn {
      background: var(--card); color: var(--text); border: 1px solid var(--border);
      border-radius: 6px; padding: 4px 10px; font-size: 0.78rem; font-weight: 700;
      cursor: pointer; text-decoration: none;
    }
    .toggle-btn:hover, .mermaid-btn:hover { border-color: var(--accent); color: var(--accent); }
    .layout { display: flex; flex: 1; overflow: hidden; }
    aside.doc-tree {
      width: 260px; background: var(--sidebar); border-right: 1px solid var(--border);
      overflow-y: auto; padding: 12px;
    }
    .group-title { font-size: 0.72rem; font-weight: 700; color: var(--accent); margin: 12px 4px 6px; }
    .doc-item {
      display: block; width: 100%; text-align: left; background: transparent; border: none;
      color: var(--muted); padding: 7px 10px; border-radius: 6px; cursor: pointer; font-size: 0.88rem;
    }
    .doc-item.active, .doc-item:hover { background: rgba(56, 189, 248, 0.16); color: var(--accent); }
    main.doc-pane { flex: 1; overflow-y: auto; padding: 24px 32px 60px; }
    .markdown-body { max-width: 980px; margin: 0 auto; line-height: 1.72; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3 { margin: 16px 0 8px; color: var(--accent); }
    .markdown-body table { width: 100%; border-collapse: collapse; margin: 14px 0; }
    .markdown-body th, .markdown-body td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
    .mermaid-box { background: #0f172a; border: 1px solid var(--border); border-radius: 10px; margin: 14px 0; overflow: hidden; }
    .mermaid-toolbar {
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 12px; background: #162033; border-bottom: 1px solid var(--border); font-size: 0.76rem; color: var(--muted);
    }
    .mermaid-controls { display: flex; align-items: center; gap: 6px; }
    .mermaid-viewport { width: 100%; min-height: 240px; max-height: 680px; overflow: auto; cursor: grab; padding: 20px; text-align: center; }
    .mermaid-stage { transform-origin: center top; display: inline-block; }
    .mermaid-modal { position: fixed; inset: 0; background: rgba(9, 13, 22, 0.94); z-index: 9999; display: none; flex-direction: column; }
    .mermaid-modal.open { display: flex; }
    .mermaid-modal-header { height: 50px; padding: 0 20px; background: #111827; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .mermaid-modal-body { flex: 1; overflow: hidden; cursor: grab; display: flex; justify-content: center; align-items: center; }
    section.game-dock { width: 42vw; min-width: 320px; border-left: 1px solid var(--border); display: flex; flex-direction: column; }
    .game-iframe { width: 100%; flex: 1; border: none; background: #0b1120; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><span>🕹️</span><span>${projectName} 스튜디오</span></div>
    <div style="display:flex;gap:8px;">
      <a href="/docs" class="toggle-btn">📖 문서 뷰어 (/docs)</a>
      <a href="/play" target="_blank" class="toggle-btn">🎮 단독 실행 (/play)</a>
    </div>
  </header>
  <div class="layout">
    <aside id="sidebar-tree" class="doc-tree"></aside>
    <main id="doc-pane" class="doc-pane">
      <div id="current-path" style="color:var(--muted);margin-bottom:12px;font-size:0.85rem;"></div>
      <article id="content" class="markdown-body">문서를 불러오는 중...</article>
    </main>
    <section id="game-dock" class="game-dock">
      <iframe id="game-iframe" class="game-iframe" src="/play?embed=1" title="Live Play Preview"></iframe>
    </section>
  </div>

  <div id="mermaid-modal" class="mermaid-modal">
    <div class="mermaid-modal-header">
      <span style="font-weight:700;color:var(--accent);">🔍 다이어그램 전체화면 (마우스 휠 줌 · 드래그 팬 · ESC 닫기)</span>
      <div class="mermaid-controls">
        <button id="modal-zoom-out" class="mermaid-btn">－</button>
        <span id="modal-zoom-label" style="min-width:48px;text-align:center;">120%</span>
        <button id="modal-zoom-in" class="mermaid-btn">＋</button>
        <button id="modal-zoom-reset" class="mermaid-btn">100%</button>
        <button id="modal-close" class="mermaid-btn" style="background:#f43f5e;color:#fff;">✕ 닫기 (ESC)</button>
      </div>
    </div>
    <div id="mermaid-modal-body" class="mermaid-modal-body">
      <div id="mermaid-modal-stage" class="mermaid-stage"></div>
    </div>
  </div>

  <script type="module">
    import { initMermaidModal, enhanceMermaidBlocks } from '/scripts/lib/mermaid-viewer-client.mjs';

    const sidebarTree = document.getElementById('sidebar-tree');
    const content = document.getElementById('content');
    const currentPathEl = document.getElementById('current-path');
    const modalCtrl = initMermaidModal(document, window);
    let activePath = new URLSearchParams(location.search).get('file') || 'docs/specs/00-USER-REQUESTS-traceability.ko.md';

    async function selectDoc(docPath) {
      activePath = docPath;
      history.replaceState(null, '', '/docs?file=' + encodeURIComponent(docPath));
      currentPathEl.textContent = '📄 ' + docPath;
      document.querySelectorAll('.doc-item').forEach((b) => {
        b.classList.toggle('active', b.dataset.path === docPath);
      });
      const res = await fetch('/' + docPath + '?t=' + Date.now());
      const text = await res.text();
      if (docPath.endsWith('.json') || docPath.endsWith('.yaml') || docPath.endsWith('.yml')) {
        content.innerHTML = '<pre><code>' + text.replace(/</g, '&lt;') + '</code></pre>';
        return;
      }
      content.innerHTML = marked.parse(text);
      content.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (href.startsWith('http://') || href.startsWith('https://')) return;
        const clean = href.split('#')[0].replace(/^\\/+/, '');
        if (clean.endsWith('.md') || clean.endsWith('.json') || clean.endsWith('.yaml')) {
          a.addEventListener('click', (ev) => {
            ev.preventDefault();
            selectDoc(clean);
          });
        }
      });
      await enhanceMermaidBlocks(content, window.__mermaid, modalCtrl);
    }

    async function loadCatalog() {
      const res = await fetch('/api/docs?t=' + Date.now());
      const groups = await res.json();
      sidebarTree.innerHTML = '';
      for (const g of groups) {
        const gt = document.createElement('div');
        gt.className = 'group-title';
        gt.textContent = g.group;
        sidebarTree.appendChild(gt);
        for (const item of g.items) {
          const btn = document.createElement('button');
          btn.className = 'doc-item' + (item.path === activePath ? ' active' : '');
          btn.textContent = item.title;
          btn.dataset.path = item.path;
          btn.onclick = () => selectDoc(item.path);
          sidebarTree.appendChild(btn);
        }
      }
    }

    loadCatalog().then(() => selectDoc(activePath));
  </script>
</body>
</html>`;
}

export function createStudioServer({ root = defaultRoot } = {}) {
  const sseClients = new Set();
  const docsHtml = renderDocsHtml();
  let serverDebugLogs = [];

  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

    if (urlPath === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (urlPath === '/api/docs') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(collectDocs(root)));
      return;
    }

    if (urlPath === '/api/debug-log') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 512 * 1024) req.destroy();
        });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const loggerUrl = new URL('../src/debug-logger.mjs', import.meta.url).href;
            const { sanitizeDetail, pruneRetentionEntries } = await import(loggerUrl);
            const sanitized = sanitizeDetail(parsed);
            serverDebugLogs.push({
              receivedAt: new Date().toISOString(),
              epochMs: Date.now(),
              payload: sanitized,
            });
            serverDebugLogs = pruneRetentionEntries(serverDebugLogs);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, count: serverDebugLogs.length }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, entries: serverDebugLogs }));
      return;
    }

    if (urlPath === '/' || urlPath === '/docs') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(docsHtml);
      return;
    }

    const rel = urlPath === '/play' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.resolve(root, rel);
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT || 4173);
  const srv = createStudioServer({ root: defaultRoot });
  srv.listen(port, '127.0.0.1', () => {
    console.log(`🕹️ Studio Dev Server running at http://localhost:${port}/docs (Play: http://localhost:${port}/play)`);
  });
}
