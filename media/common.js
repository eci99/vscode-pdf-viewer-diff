// @ts-check
// Shared between the single viewer (viewer.js) and the compare view (compare.js).

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;

/**
 * Zooms a viewer for a Ctrl+wheel event, keeping the point under the mouse where it is.
 * @param {any} viewer the PDFViewer to zoom
 * @param {WheelEvent} e the event, on the container of the viewer or a pane of the same size
 */
export function zoomAt(viewer, e) {
  const previous = viewer.currentScale;
  viewer.currentScaleValue = String(Math.min(MAX_SCALE, Math.max(MIN_SCALE, previous * Math.exp(-e.deltaY / 400))));
  // pdf.js keeps the top left corner in place; move the content so that the mouse position stays.
  const factor = viewer.currentScale / previous - 1;
  const rect = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
  viewer.container.scrollLeft += (e.clientX - rect.left) * factor;
  viewer.container.scrollTop += (e.clientY - rect.top) * factor;
}

/**
 * Loads pdf.js and its viewer components and starts the worker.
 * @param {Record<string, string>} config URLs provided by the extension
 */
export async function initPdfjs(config) {
  // pdf_viewer.mjs expects the core library on globalThis.pdfjsLib.
  const pdfjsLib = await import(config.pdfjs);
  globalThis.pdfjsLib = pdfjsLib;
  const viewerLib = await import(config.viewer);

  // Workers cannot be created from the webview resource origin directly,
  // so the worker script is loaded through a blob URL.
  const workerCode = await (await fetch(config.worker)).blob();
  const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: 'module' });

  /** @param {ArrayBuffer} data */
  const openDocument = (data) =>
    pdfjsLib.getDocument({
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

  return { pdfjsLib, viewerLib, openDocument };
}

/**
 * Wires up the find controls of the toolbar: the input, the buttons, the match count, and Ctrl+F.
 * The row with them is shown with the button in the toolbar or with Ctrl+F, and hiding it ends the search.
 * @param {any} eventBus
 * @param {HTMLElement} container scroll container, gets the focus after Escape
 */
export function setupFind(eventBus, container) {
  const $ = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
  const find = (/** @type {string} */ type, findPrevious = false) => {
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
  const setFindVisible = (/** @type {boolean} */ visible) => {
    $('findRow').hidden = !visible;
    $('findToggle').setAttribute('aria-pressed', String(visible));
    if (visible) {
      $('findInput').focus();
      $('findInput').select();
    } else {
      $('findInput').value = '';
      find('');
    }
  };
  $('findToggle').addEventListener('click', () => setFindVisible($('findRow').hidden));
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      find('again', e.shiftKey);
    } else if (e.key === 'Escape') {
      setFindVisible(false);
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
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      setFindVisible(true);
    }
  });
}

/**
 * Keeps the content below the toolbar, which becomes two rows when it is too narrow.
 * The height is available to the stylesheet as --toolbar-height.
 */
export function trackToolbarHeight() {
  const toolbar = /** @type {HTMLElement} */ (document.getElementById('toolbar'));
  const groups = /** @type {HTMLElement[]} */ ([...toolbar.children]).filter((child) => child.classList.contains('group'));
  const findRow = document.getElementById('findRow');
  new ResizeObserver(() => {
    document.body.style.setProperty('--toolbar-height', `${toolbar.offsetHeight}px`);
    // The find controls get a row of their own unless the other controls already fill two rows.
    const centers = groups.map((group) => group.offsetTop + group.offsetHeight / 2);
    const wrapped = Math.max(...centers) - Math.min(...centers) > 8;
    findRow?.classList.toggle('ownRow', !wrapped);
  }).observe(toolbar);
}

/**
 * Hand tool: lets the user drag the page with the mouse while isActive() is true.
 * @param {HTMLElement} container scroll container
 * @param {() => boolean} isActive
 */
export function enableDragScroll(container, isActive) {
  let drag = null;
  container.addEventListener('pointerdown', (e) => {
    if (!isActive() || e.button !== 0 || e.target.closest('a, input, select, textarea, button')) {
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
}
