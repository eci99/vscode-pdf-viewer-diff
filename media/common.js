// @ts-check
// Shared between the single viewer (viewer.js) and the compare view (compare.js).

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 10;

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
