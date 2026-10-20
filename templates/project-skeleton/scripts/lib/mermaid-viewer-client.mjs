/**
 * Naia ADK v0.2.0 — Interactive Mermaid Viewer Client Module
 * Extracted from ref-naia-arcade studio viewer:
 * - wirePanZoom: mouse wheel zoom (Ctrl+Wheel inline, direct Wheel in modal) & click-drag pan
 * - Toolbar: `+` (zoom in), `-` (zoom out), `100%` (reset), `폭 맞춤` (fit width), `⛶` (fullscreen modal)
 * - openMermaidModal: fullscreen diagram inspector with `Escape` key close
 */

export function wirePanZoom(viewport, stage, labelEl, initialScale = 1, options = {}) {
  const {
    minScale = 0.3,
    maxScale = 8,
    step = 0.25,
    wheelStep = 0.2,
    requireCtrlForWheel = true,
    eventTarget = typeof window !== 'undefined' ? window : null,
  } = options;

  let scale = Number(initialScale) || 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let startX = 0;
  let startY = 0;

  function clampScale(next) {
    return Math.max(minScale, Math.min(maxScale, Number(next.toFixed(2))));
  }

  function update() {
    if (stage && stage.style) {
      stage.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }
    if (labelEl) {
      labelEl.textContent = `${Math.round(scale * 100)}%`;
    }
  }

  if (viewport && typeof viewport.addEventListener === 'function') {
    viewport.addEventListener(
      'wheel',
      (e) => {
        if (requireCtrlForWheel && !e.ctrlKey) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        const delta = e.deltaY < 0 ? wheelStep : -wheelStep;
        scale = clampScale(scale + delta);
        update();
      },
      { passive: false },
    );

    viewport.addEventListener('mousedown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      startX = (e.clientX || 0) - panX;
      startY = (e.clientY || 0) - panY;
    });
  }

  if (eventTarget && typeof eventTarget.addEventListener === 'function') {
    eventTarget.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panX = (e.clientX || 0) - startX;
      panY = (e.clientY || 0) - startY;
      update();
    });

    eventTarget.addEventListener('mouseup', () => {
      dragging = false;
    });
  }

  update();

  return {
    zoomIn() {
      scale = clampScale(scale + step);
      update();
      return scale;
    },
    zoomOut() {
      scale = clampScale(scale - step);
      update();
      return scale;
    },
    reset(newScale = initialScale) {
      scale = clampScale(Number(newScale) || initialScale);
      panX = 0;
      panY = 0;
      update();
      return scale;
    },
    panBy(dx, dy) {
      panX += Number(dx) || 0;
      panY += Number(dy) || 0;
      update();
      return { panX, panY, scale };
    },
    getState() {
      return { scale, panX, panY, dragging };
    },
  };
}

export function createMermaidBoxMarkup() {
  return `
    <div class="mermaid-toolbar">
      <span>📊 다이어그램 (드래그 이동 · Ctrl+휠 줌 · 더블클릭 전체화면)</span>
      <div class="mermaid-controls">
        <button class="mermaid-btn" data-act="out" title="축소 (-)">－</button>
        <span class="zoom-pct" style="min-width: 46px; text-align: center;">100%</span>
        <button class="mermaid-btn" data-act="in" title="확대 (+)">＋</button>
        <button class="mermaid-btn" data-act="fit" title="화면 폭 맞춤">폭 맞춤</button>
        <button class="mermaid-btn" data-act="reset" title="100% 원본 배율">100%</button>
        <button class="mermaid-btn" data-act="full" title="전체화면 모달 열기" style="color: var(--gold); border-color: rgba(250,204,21,0.4);">⛶</button>
      </div>
    </div>
    <div class="mermaid-viewport">
      <div class="mermaid-stage">
        <div class="mermaid"></div>
      </div>
    </div>
  `;
}

export function openMermaidModal(svgHtml, modalCtx) {
  if (!modalCtx || !modalCtx.modalEl || !modalCtx.stageEl) return false;
  modalCtx.stageEl.innerHTML = svgHtml;
  modalCtx.modalEl.classList.add('open');
  if (modalCtx.ctrl && typeof modalCtx.ctrl.reset === 'function') {
    modalCtx.ctrl.reset(1.2);
  }
  return true;
}

export function closeMermaidModal(modalCtx) {
  if (!modalCtx || !modalCtx.modalEl) return false;
  modalCtx.modalEl.classList.remove('open');
  return true;
}

export function initMermaidModal(doc = typeof document !== 'undefined' ? document : null, win = typeof window !== 'undefined' ? window : null) {
  if (!doc) return null;
  const modalEl = doc.getElementById('mermaid-modal');
  const bodyEl = doc.getElementById('mermaid-modal-body');
  const stageEl = doc.getElementById('mermaid-modal-stage');
  const labelEl = doc.getElementById('modal-zoom-label');
  if (!modalEl || !bodyEl || !stageEl) return null;

  const ctrl = wirePanZoom(bodyEl, stageEl, labelEl, 1.2, {
    requireCtrlForWheel: false,
    eventTarget: win,
  });

  const modalCtx = { modalEl, bodyEl, stageEl, labelEl, ctrl };

  const btnIn = doc.getElementById('modal-zoom-in');
  const btnOut = doc.getElementById('modal-zoom-out');
  const btnReset = doc.getElementById('modal-zoom-reset');
  const btnClose = doc.getElementById('modal-close');

  if (btnIn) btnIn.onclick = () => ctrl.zoomIn();
  if (btnOut) btnOut.onclick = () => ctrl.zoomOut();
  if (btnReset) btnReset.onclick = () => ctrl.reset(1.2);
  if (btnClose) btnClose.onclick = () => closeMermaidModal(modalCtx);

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalEl.classList.contains('open')) {
        closeMermaidModal(modalCtx);
      }
    });
  }

  return {
    ...modalCtx,
    open: (svgHtml) => openMermaidModal(svgHtml, modalCtx),
    close: () => closeMermaidModal(modalCtx),
  };
}

export async function enhanceMermaidBlocks(contentEl, mermaidInstance, modalController = null) {
  if (!contentEl) return [];
  const mermaidBlocks = contentEl.querySelectorAll('code.language-mermaid');
  const wrappers = [];

  for (const block of mermaidBlocks) {
    const pre = block.parentElement;
    const doc = contentEl.ownerDocument || document;
    const box = doc.createElement('div');
    box.className = 'mermaid-box';
    box.innerHTML = createMermaidBoxMarkup();
    box.querySelector('.mermaid').textContent = block.textContent;
    pre.replaceWith(box);
    wrappers.push(box);
  }

  if (mermaidInstance && wrappers.length > 0) {
    await mermaidInstance.run({ querySelector: '.mermaid' });
    for (const box of wrappers) {
      const vp = box.querySelector('.mermaid-viewport');
      const st = box.querySelector('.mermaid-stage');
      const pct = box.querySelector('.zoom-pct');
      const svg = st.querySelector('svg');
      let vbWidth = 680;
      if (svg) {
        const vb = svg.getAttribute('viewBox');
        if (vb) {
          const parts = vb.trim().replaceAll(',', ' ').split(' ').filter(Boolean).map(Number);
          if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
            vbWidth = Math.round(parts[2]);
            const vbHeight = Math.round(parts[3]);
            svg.removeAttribute('width');
            svg.removeAttribute('height');
            svg.style.width = `${vbWidth}px`;
            svg.style.height = `${vbHeight}px`;
            svg.style.maxWidth = 'none';
          }
        }
      }
      const availW = Math.max(420, (vp.clientWidth || 720) - 40);
      const initScale = Number(Math.min(1.0, Math.max(0.75, availW / vbWidth)).toFixed(2));
      const ctrl = wirePanZoom(vp, st, pct, initScale);

      box.querySelector('[data-act="in"]').onclick = () => ctrl.zoomIn();
      box.querySelector('[data-act="out"]').onclick = () => ctrl.zoomOut();
      box.querySelector('[data-act="reset"]').onclick = () => ctrl.reset(1.0);
      box.querySelector('[data-act="fit"]').onclick = () => {
        const curAvailW = Math.max(320, (vp.clientWidth || 720) - 40);
        ctrl.reset(Number(Math.min(1.2, curAvailW / vbWidth)).toFixed(2));
      };
      const openFull = () => {
        if (modalController && typeof modalController.open === 'function') {
          modalController.open(st.innerHTML);
        }
      };
      box.querySelector('[data-act="full"]').onclick = openFull;
      vp.addEventListener('dblclick', openFull);
    }
  }

  return wrappers;
}
