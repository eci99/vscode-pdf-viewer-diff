// @ts-check
const vscode = acquireVsCodeApi();
const config = JSON.parse(document.getElementById('config').textContent);
const $ = (id) => document.getElementById(id);

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = !text;
}

async function main() {
  // pdf_viewer.mjs expects the core library on globalThis.pdfjsLib.
  const pdfjsLib = await import(config.pdfjs);
  globalThis.pdfjsLib = pdfjsLib;
  const { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } = await import(
    config.viewer
  );

  // Workers cannot be created from the webview resource origin directly,
  // so the worker script is loaded through a blob URL.
  const workerCode = await (await fetch(config.worker)).blob();
  const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: 'module' });

  const container = $('viewerContainer');
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
  const findController = new PDFFindController({ eventBus, linkService });
  const viewer = new PDFViewer({
    container,
    viewer: $('viewer'),
    eventBus,
    linkService,
    findController,
  });
  linkService.setViewer(viewer);

  /** @type {{ page?: number, scale?: string, tool?: string }} */
  let state = vscode.getState() ?? {};
  let pdfDocument = null;
  let loadingTask = null;

  const saveState = () => {
    state = { ...state, page: viewer.currentPageNumber, scale: viewer.currentScaleValue };
    vscode.setState(state);
  };

  async function load(data) {
    const keep = pdfDocument ? { ...state, scrollTop: container.scrollTop } : state;
    const previousTask = loadingTask;
    let task;
    try {
      task = loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(data),
        cMapUrl: config.cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: config.standardFontDataUrl,
        wasmUrl: config.wasmUrl,
        iccUrl: config.iccUrl,
        // Requests from the blob worker are not served by the webview's
        // resource handler, so fonts/cmaps/wasm are fetched on the main thread.
        useWorkerFetch: false,
      });
      const doc = await task.promise;
      if (task !== loadingTask) {
        void task.destroy(); // superseded by a newer load
        return;
      }
      pdfDocument = doc;
      showMessage('');
      eventBus.on(
        'pagesinit',
        () => {
          viewer.currentScaleValue = keep.scale ?? 'auto';
          viewer.currentPageNumber = Math.min(keep.page ?? 1, doc.numPages);
          if (keep.scrollTop !== undefined) {
            container.scrollTop = keep.scrollTop;
          }
        },
        { once: true },
      );
      viewer.setDocument(doc);
      linkService.setDocument(doc);
      $('pageCount').textContent = `/ ${doc.numPages}`;
      $('pageNumber').max = String(doc.numPages);
      void previousTask?.destroy();
    } catch (err) {
      if (task && task !== loadingTask) {
        return; // superseded by a newer load
      }
      showMessage(
        err?.name === 'PasswordException'
          ? 'Dieses PDF ist passwortgeschützt und kann nicht angezeigt werden.'
          : `PDF konnte nicht geladen werden: ${err?.message ?? err}`,
      );
    }
  }

  // --- Page navigation ---
  $('prev').addEventListener('click', () => viewer.previousPage());
  $('next').addEventListener('click', () => viewer.nextPage());
  $('pageNumber').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    if (pdfDocument && Number.isInteger(n) && n >= 1 && n <= pdfDocument.numPages) {
      viewer.currentPageNumber = n;
    } else {
      e.target.value = String(viewer.currentPageNumber);
    }
  });
  eventBus.on('pagechanging', (e) => {
    $('pageNumber').value = String(e.pageNumber);
    saveState();
  });

  // --- Zoom ---
  const setScale = (scale) => {
    viewer.currentScaleValue = String(Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)));
  };
  $('zoomIn').addEventListener('click', () => viewer.increaseScale());
  $('zoomOut').addEventListener('click', () => viewer.decreaseScale());
  $('scale').addEventListener('change', (e) => {
    viewer.currentScaleValue = e.target.value;
  });
  eventBus.on('scalechanging', (e) => {
    const select = $('scale');
    const value = e.presetValue ?? String(e.scale);
    const preset = [...select.options].find((o) => o.value === value && o.id !== 'customScale');
    if (preset) {
      select.value = preset.value;
    } else {
      const custom = $('customScale');
      custom.textContent = `${Math.round(e.scale * 100)} %`;
      select.value = 'custom';
    }
    saveState();
  });
  container.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }
      e.preventDefault();
      setScale(viewer.currentScale * Math.exp(-e.deltaY / 400));
    },
    { passive: false },
  );
  // Keep "fit" presets fitting when the editor is resized.
  new ResizeObserver(() => {
    const value = viewer.currentScaleValue;
    if (pdfDocument && (value === 'auto' || value === 'page-fit' || value === 'page-width')) {
      viewer.currentScaleValue = value;
    }
  }).observe(container);

  // --- Tool: text selection or hand (drag to scroll) ---
  let handTool = false;
  const applyTool = (tool) => {
    handTool = tool === 'hand';
    container.classList.toggle('handTool', handTool);
    $('toolSelect').setAttribute('aria-pressed', String(!handTool));
    $('toolHand').setAttribute('aria-pressed', String(handTool));
    if (handTool) {
      getSelection()?.removeAllRanges();
    }
  };
  const setTool = (tool) => {
    applyTool(tool);
    state = { ...state, tool };
    vscode.setState(state);
  };
  applyTool(state.tool);
  $('toolSelect').addEventListener('click', () => setTool('select'));
  $('toolHand').addEventListener('click', () => setTool('hand'));

  let drag = null;
  container.addEventListener('pointerdown', (e) => {
    if (!handTool || e.button !== 0 || e.target.closest('a, input, select, textarea, button')) {
      return;
    }
    const rect = container.getBoundingClientRect();
    if (
      e.clientX - rect.left >= container.clientWidth ||
      e.clientY - rect.top >= container.clientHeight
    ) {
      return; // click on a scrollbar
    }
    drag = { x: e.clientX, y: e.clientY, left: container.scrollLeft, top: container.scrollTop };
    container.setPointerCapture(e.pointerId);
    container.classList.add('grabbing');
  });
  container.addEventListener('pointermove', (e) => {
    if (drag) {
      container.scrollLeft = drag.left - (e.clientX - drag.x);
      container.scrollTop = drag.top - (e.clientY - drag.y);
    }
  });
  const endDrag = () => {
    drag = null;
    container.classList.remove('grabbing');
  };
  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);

  // --- Find ---
  const find = (type, findPrevious = false) => {
    eventBus.dispatch('find', {
      source: window,
      type,
      query: $('findInput').value,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
    });
  };
  $('findInput').addEventListener('input', () => find(''));
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      find('again', e.shiftKey);
    } else if (e.key === 'Escape') {
      e.target.value = '';
      find('');
      container.focus();
    }
  });
  $('findNext').addEventListener('click', () => find('again'));
  $('findPrev').addEventListener('click', () => find('again', true));
  const updateFindCount = ({ matchesCount }) => {
    $('findCount').textContent =
      $('findInput').value && matchesCount?.total
        ? `${matchesCount.current} / ${matchesCount.total}`
        : '';
  };
  eventBus.on('updatefindmatchescount', updateFindCount);
  eventBus.on('updatefindcontrolstate', (e) => {
    // FindState.NOT_FOUND === 1
    $('findInput').classList.toggle('notFound', e.state === 1 && !!$('findInput').value);
    updateFindCount(e);
  });

  // --- Keyboard ---
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('findInput').focus();
      $('findInput').select();
    } else if (mod && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      viewer.increaseScale();
    } else if (mod && e.key === '-') {
      e.preventDefault();
      viewer.decreaseScale();
    } else if (mod && e.key === '0') {
      e.preventDefault();
      viewer.currentScaleValue = 'auto';
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'load') {
      void load(msg.data);
    } else if (msg.type === 'error') {
      showMessage(`Datei konnte nicht gelesen werden: ${msg.message}`);
    }
  });

  vscode.postMessage({ type: 'ready' });
}

main().catch((err) => showMessage(`Viewer konnte nicht gestartet werden: ${err?.message ?? err}`));
