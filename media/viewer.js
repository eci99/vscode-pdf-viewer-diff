// @ts-check
import { enableDragScroll, initPdfjs, setupFind, trackToolbarHeight, zoomAt } from './common.js';

const vscode = acquireVsCodeApi();
const config = JSON.parse(document.getElementById('config').textContent);
const $ = (id) => document.getElementById(id);

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = !text;
}

async function main() {
  trackToolbarHeight();
  const { viewerLib, openDocument } = await initPdfjs(config);
  const { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } = viewerLib;

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

  /** @type {{ page?: number, scale?: string, rotation?: number, tool?: string }} */
  let state = vscode.getState() ?? {};
  let pdfDocument = null;
  let loadingTask = null;

  const saveState = () => {
    state = { ...state, page: viewer.currentPageNumber, scale: viewer.currentScaleValue };
    vscode.setState(state);
  };

  async function load(data) {
    const keep = pdfDocument ? { ...state, scrollTop: container.scrollTop, scrollLeft: container.scrollLeft } : state;
    const previousTask = loadingTask;
    let task;
    try {
      task = loadingTask = openDocument(data);
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
          viewer.pagesRotation = state.rotation ?? 0;
          viewer.currentScaleValue = keep.scale ?? 'auto';
          viewer.currentPageNumber = Math.min(keep.page ?? 1, doc.numPages);
          if (keep.scrollTop !== undefined) {
            const restoreScroll = () => {
              container.scrollTop = keep.scrollTop;
              container.scrollLeft = keep.scrollLeft;
            };
            restoreScroll();
            // The scrollable width is only final once pages are laid out; before that scrollLeft is clamped.
            eventBus.on('pagerendered', () => requestAnimationFrame(restoreScroll), { once: true });
          }
        },
        { once: true },
      );
      viewer.setDocument(doc);
      linkService.setDocument(doc);
      $('pageCount').textContent = `/ ${doc.numPages}`;
      $('pageNumber').max = String(doc.numPages);
      void previousTask?.destroy();
      vscode.postMessage({ type: 'loaded' });
    } catch (err) {
      if (task && task !== loadingTask) {
        return; // superseded by a newer load
      }
      showMessage(
        err?.name === 'PasswordException'
          ? 'This PDF is password-protected and cannot be displayed.'
          : `The PDF could not be loaded: ${err?.message ?? err}`,
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
  $('zoomIn').addEventListener('click', () => viewer.increaseScale());
  $('zoomOut').addEventListener('click', () => viewer.decreaseScale());

  // --- Back to the start ---
  $('resetView').addEventListener('click', () => {
    if (!pdfDocument) {
      return;
    }
    viewer.currentScaleValue = 'auto';
    viewer.currentPageNumber = 1;
    container.scrollTop = 0;
    container.scrollLeft = 0;
  });

  // --- Rotation ---
  const rotate = (delta) => {
    viewer.pagesRotation = (viewer.pagesRotation + delta + 360) % 360;
    state = { ...state, rotation: viewer.pagesRotation };
    vscode.setState(state);
  };
  $('rotateLeft').addEventListener('click', () => rotate(-90));
  $('rotateRight').addEventListener('click', () => rotate(90));

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
      zoomAt(viewer, e);
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
    handTool = tool !== 'select';
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

  enableDragScroll(container, () => handTool);

  // --- Find ---
  setupFind(eventBus, container);

  // --- Keyboard ---
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === '+' || e.key === '=')) {
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
    } else if (msg.type === 'previous') {
      // The extension keeps the version shown before the last reload.
      $('comparePrevious').disabled = !msg.available;
      $('comparePrevious').title = msg.available
        ? 'Compare with the version before the last reload'
        : 'Compare with the version before the last reload (no earlier version yet)';
    } else if (msg.type === 'error') {
      showMessage(`The file could not be read: ${msg.message}`);
    }
  });
  $('compareWith').addEventListener('click', () => vscode.postMessage({ type: 'compare' }));
  $('comparePrevious').addEventListener('click', () => vscode.postMessage({ type: 'comparePrevious' }));

  vscode.postMessage({ type: 'ready' });
}

main().catch((err) => showMessage(`The viewer could not be started: ${err?.message ?? err}`));
