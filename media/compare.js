// @ts-check
// Compare view: both documents are drawn on top of each other. The document
// with more pages is shown by a regular pdf.js viewer ("main"), the pages of
// the other one are rendered into an extra layer inside each page ("other").
// Tinting one document red and the other green and multiplying the layers
// makes identical content black, while differences keep their colour. This
// is only done where the pages differ; everywhere else the page stays as it is.
// Side by side, the other document gets a viewer of its own ("second") instead
// of the layer, and both show their original colours with the marks.
// Differences are found in the rendered pixels or, if chosen, in the words of the text.
import { initPdfjs, setupFind, setupTool, trackToolbarHeight, zoomAt } from './common.js';

const vscode = acquireVsCodeApi();
const config = JSON.parse(document.getElementById('config').textContent);
const $ = (id) => document.getElementById(id);

// Pages are rendered at this width (px) for the pixel comparison and the
// result is stored as a grid of CELL x CELL px cells.
const DIFF_WIDTH = 800;
const CELL = 4;
// The marked area extends this many cells beyond the differing pixels.
const MARK_PADDING = 1;
// Differing areas closer than this many cells count as one difference.
const GROUP_DISTANCE = 3;
// Summed RGB difference above which two pixels count as different.
const PIXEL_THRESHOLD = 48;
// Above this many word comparisons per page, the changed part of the text is marked as a whole.
const MAX_TEXT_DIFF = 4000000;
const MARK_COLOR = '#ffe070';
// Complementary tints: multiplied they give black.
const TINT = { left: '#e00000', right: '#009a00' };
const MAX_CANVAS_AREA = 16777216;
// Distance (px) kept above a difference when scrolling to it.
const FOCUS_MARGIN = 60;

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = !text;
}

async function main() {
  trackToolbarHeight();
  const { viewerLib, openDocument } = await initPdfjs(config);
  const { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } = viewerLib;

  /** @type {{ page?: number, scale?: string, rotation?: number, tool?: string, showLeft?: boolean, showRight?: boolean, showMarks?: boolean, sideBySide?: boolean, scrollLock?: boolean, showMarksSideBySide?: boolean, textDiff?: boolean }} */
  let state = vscode.getState() ?? {};
  const updateState = (patch) => {
    state = { ...state, ...patch };
    vscode.setState(state);
  };

  document.body.classList.add('compare');
  const container = $('viewerContainer');
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
  // The text that is searched is that of the document the viewer shows.
  const findController = new PDFFindController({ eventBus, linkService });
  const viewer = new PDFViewer({ container, viewer: $('viewer'), eventBus, linkService, findController });
  linkService.setViewer(viewer);
  setupFind(eventBus, container);

  // The viewer of the other document in the side-by-side view. It follows the zoom and
  // rotation of the main viewer and has no document while the view is not side by side.
  const secondContainer = $('secondContainer');
  const secondBus = new EventBus();
  const secondLinks = new PDFLinkService({ eventBus: secondBus, externalLinkTarget: LinkTarget.BLANK });
  const secondViewer = new PDFViewer({
    container: secondContainer,
    viewer: $('secondViewer'),
    eventBus: secondBus,
    linkService: secondLinks,
  });
  secondLinks.setViewer(secondViewer);
  let secondDoc = null;
  // The second viewer takes the zoom once its pages are set up; pdf.js reports an error before that.
  let secondReady = false;
  const containers = [container, secondContainer];
  // The side the user last scrolled, clicked or focused: the scroll lock and the jumps
  // between differences start from there.
  let activeContainer = container;
  for (const c of containers) {
    for (const type of ['pointerdown', 'wheel', 'keydown', 'focusin']) {
      c.addEventListener(
        type,
        () => {
          if (activeContainer !== c) {
            activeContainer = c;
            showScale(zoomViewer());
          }
        },
        { passive: true },
      );
    }
  }

  const docs = { left: null, right: null };
  const tasks = { left: null, right: null };
  /** Which side the viewer shows; the other side is drawn as a layer on top. */
  let mainSide = 'right';
  const otherSide = () => (mainSide === 'left' ? 'right' : 'left');
  let viewerDoc = null;

  // --- Page navigation ---
  const goToPage = (n) => {
    if (!viewerDoc || !Number.isInteger(n) || n < 1 || n > viewerDoc.numPages) {
      return false;
    }
    viewer.currentPageNumber = n;
    return true;
  };
  $('prev').addEventListener('click', () => viewer.previousPage());
  $('next').addEventListener('click', () => viewer.nextPage());
  $('pageNumber').addEventListener('change', (e) => {
    if (!goToPage(Number(e.target.value))) {
      e.target.value = String(viewer.currentPageNumber);
    }
  });
  eventBus.on('pagechanging', (e) => {
    $('pageNumber').value = String(e.pageNumber);
    updateState({ page: e.pageNumber });
  });

  // --- Zoom ---
  // With the scroll lock, the second viewer takes the zoom of the main one. Without it, each
  // side has its own zoom, and the controls change that of the active side.
  const zoomLinked = () => !sideBySide || scrollLock;
  const zoomViewer = () => (secondReady && !zoomLinked() && activeContainer === secondContainer ? secondViewer : viewer);
  $('zoomIn').addEventListener('click', () => zoomViewer().increaseScale());
  $('zoomOut').addEventListener('click', () => zoomViewer().decreaseScale());
  $('scale').addEventListener('change', (e) => {
    zoomViewer().currentScaleValue = e.target.value;
  });
  /** Shows the zoom of a viewer in the toolbar. */
  const showScale = (v) => {
    if (!v.pdfDocument) {
      return;
    }
    const select = $('scale');
    const value = v.currentScaleValue;
    const preset = [...select.options].find((o) => o.value === value && o.id !== 'customScale');
    if (preset) {
      select.value = preset.value;
    } else {
      $('customScale').textContent = `${Math.round(v.currentScale * 100)} %`;
      select.value = 'custom';
    }
  };
  eventBus.on('scalechanging', (e) => {
    if (zoomViewer() === viewer) {
      showScale(viewer);
    }
    updateState({ scale: viewer.currentScaleValue });
    // The same zoom factor, also for "fit" presets: pages of the same size stay the same size.
    if (secondReady && zoomLinked()) {
      secondViewer.currentScale = e.scale;
    }
  });
  secondBus.on('scalechanging', () => {
    if (zoomViewer() === secondViewer) {
      showScale(secondViewer);
    }
  });
  for (const c of containers) {
    c.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const v = zoomLinked() || c === container ? viewer : secondViewer;
          zoomAt(v, e);
        }
      },
      { passive: false },
    );
  }
  // Keep "fit" presets fitting when the editor is resized.
  const refit = (v) => {
    const value = v.currentScaleValue;
    if (v.pdfDocument && (value === 'auto' || value === 'page-fit' || value === 'page-width')) {
      v.currentScaleValue = value;
    }
  };
  new ResizeObserver(() => refit(viewer)).observe(container);
  // Linked, the second viewer gets the zoom factor of the main one instead.
  new ResizeObserver(() => secondReady && !zoomLinked() && refit(secondViewer)).observe(secondContainer);

  // --- Back to the start ---
  $('resetView').addEventListener('click', () => {
    if (!viewerDoc) {
      return;
    }
    // Both sides start at page 1 again, also with the scroll lock.
    lockOffset = 0;
    viewer.currentScaleValue = 'auto';
    viewer.currentPageNumber = 1;
    container.scrollTop = 0;
    container.scrollLeft = 0;
    if (secondReady && !zoomLinked()) {
      secondViewer.currentScaleValue = 'auto';
      secondContainer.scrollTop = 0;
      secondContainer.scrollLeft = 0;
    }
    syncScroll(container);
    refreshPairs();
  });

  // --- Rotation ---
  /** Rotation to render a page with: its own one plus the one chosen in the toolbar. */
  const rotationOf = (page) => (page.rotate + viewer.pagesRotation) % 360;
  const rotate = (delta) => {
    if (!viewerDoc) {
      return;
    }
    viewer.pagesRotation = (viewer.pagesRotation + delta + 360) % 360;
    if (secondReady) {
      secondViewer.pagesRotation = viewer.pagesRotation;
    }
    updateState({ rotation: viewer.pagesRotation });
    // Marks and differences are positions on the rotated page: compare again.
    void runDiff();
  };
  $('rotateLeft').addEventListener('click', () => rotate(-90));
  $('rotateRight').addEventListener('click', () => rotate(90));

  // --- Tool: text selection or hand (drag to scroll) ---
  setupTool(containers, state.tool, (tool) => updateState({ tool }));

  // --- Showing / hiding the two documents and the difference marks ---
  const show = { left: state.showLeft !== false, right: state.showRight !== false };
  // Side by side, both documents are always shown.
  let sideBySide = state.sideBySide === true;
  const applyVisibility = () => {
    document.body.classList.toggle('hideMain', !sideBySide && !show[mainSide]);
    document.body.classList.toggle('hideOther', !sideBySide && !show[otherSide()]);
    document.body.classList.toggle('sideBySide', sideBySide);
    // Each document is on its own side: the main viewer is the left pane if it shows the first file.
    document.body.classList.toggle('mainLeft', mainSide === 'left');
    document.body.style.setProperty('--main-tint', TINT[mainSide]);
    document.body.style.setProperty('--other-tint', TINT[otherSide()]);
    $('showLeft').setAttribute('aria-pressed', String(show.left));
    $('showRight').setAttribute('aria-pressed', String(show.right));
  };
  const toggleDocument = (side) => {
    show[side] = !show[side];
    if (!show.left && !show.right) {
      // Never hide both: switching the last one off switches to the other document.
      show[side === 'left' ? 'right' : 'left'] = true;
    }
    applyVisibility();
    updateState({ showLeft: show.left, showRight: show.right });
  };
  $('showLeft').addEventListener('click', () => toggleDocument('left'));
  $('showRight').addEventListener('click', () => toggleDocument('right'));

  // Side by side, the button switches the differences on and off as a whole: the marks, the
  // frame and the jumps between them. It has a setting of its own there and is off by default.
  const setShowMarks = (on) => {
    document.body.classList.toggle('hideMarks', !on);
    document.body.classList.toggle('hideDiffs', sideBySide && !on);
    $('diffToggle').setAttribute('aria-pressed', String(on));
    $('diffToggle').title = sideBySide ? 'Show differences' : 'Highlight differences';
  };
  const marksShown = () => (sideBySide ? state.showMarksSideBySide === true : state.showMarks !== false);
  const diffsOff = () => sideBySide && !marksShown();
  setShowMarks(marksShown());
  $('diffToggle').addEventListener('click', () => {
    const on = $('diffToggle').getAttribute('aria-pressed') !== 'true';
    updateState(sideBySide ? { showMarksSideBySide: on } : { showMarks: on });
    setShowMarks(on);
    updateDiffStatus();
  });

  // --- Visual or textual comparison ---
  let textDiff = state.textDiff === true;
  const applyTextDiff = () => {
    $('textDiff').setAttribute('aria-pressed', String(textDiff));
  };
  applyTextDiff();
  $('textDiff').addEventListener('click', () => {
    textDiff = !textDiff;
    updateState({ textDiff });
    applyTextDiff();
    void runDiff();
  });

  // --- Layer with the pages of the other document ---
  /** @type {Map<number, { task: any }>} page number -> latest render of that page */
  const otherRenders = new Map();
  const renderOtherLayer = async (pageView) => {
    const n = pageView.id;
    otherRenders.get(n)?.task?.cancel();
    const token = { task: null };
    otherRenders.set(n, token);
    pageView.div.querySelector(':scope > .otherLayer')?.remove();
    const doc = docs[otherSide()];
    if (!doc || n > doc.numPages || sideBySide) {
      return;
    }
    try {
      const page = await doc.getPage(n);
      if (otherRenders.get(n) !== token) {
        return;
      }
      const viewport = page.getViewport({
        scale: pageView.viewport.scale,
        rotation: rotationOf(page),
      });
      let ratio = window.devicePixelRatio || 1;
      if (viewport.width * viewport.height * ratio * ratio > MAX_CANVAS_AREA) {
        ratio = Math.sqrt(MAX_CANVAS_AREA / (viewport.width * viewport.height));
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width * ratio);
      canvas.height = Math.round(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      token.task = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      await token.task.promise;
      if (otherRenders.get(n) !== token) {
        return;
      }
      const layer = document.createElement('div');
      layer.className = 'otherLayer';
      const tint = document.createElement('div');
      tint.className = 'tint';
      layer.append(canvas, tint);
      pageView.div.append(layer);
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && otherRenders.get(n) === token) {
        console.error(`Page ${n} could not be overlaid`, err);
      }
    }
  };
  const renderAllOtherLayers = () => {
    for (let i = 0; i < viewer.pagesCount; i++) {
      const pageView = viewer.getPageView(i);
      if (pageView?.div.querySelector('.canvasWrapper canvas')) {
        void renderOtherLayer(pageView);
      }
    }
  };

  // --- Difference marks ---
  // Page k of the main viewer is compared with page k + diffOffset of the other document. Side
  // by side with the scroll lock, the offset is that of the lock, so that the pages shown next
  // to each other are compared; otherwise it is 0. A pair can lack one of the pages.
  let diffOffset = 0;
  /** k of the first pair; negative if the other document has pages before the first page of the main one. */
  let firstPair = 0;
  const pairOffset = () => (sideBySide && scrollLock ? lockOffset : 0);
  /** The page indexes of a pair in the main viewer and in the other document, or null where there is no such page. */
  const pairOf = (p) => {
    const k = p + firstPair;
    const inRange = (i, doc) => (i >= 0 && i < doc.numPages ? i : null);
    return { k, main: inRange(k, docs[mainSide]), other: inRange(k + diffOffset, docs[otherSide()]) };
  };
  /**
   * Per pair: the differing areas (position and size as fractions of the page in the main
   * viewer, or of the other page if there is none), or null while it has not been compared yet.
   * @type {({ x: number, y: number, w: number, h: number }[] | null)[]}
   */
  let diffResults = [];
  /** @type {{ page: number, region: object, scrollTop: number } | null} difference last jumped to */
  let focus = null;
  const focusBox = document.createElement('div');
  focusBox.className = 'diffFocus';
  // The same frame on the page of the second viewer, side by side.
  const secondFocusBox = document.createElement('div');
  secondFocusBox.className = 'diffFocus';
  /** @type {Map<number, { canvas: HTMLCanvasElement, otherCanvas: HTMLCanvasElement, ratio: number[] }>} pair -> marks */
  const marks = new Map();
  let diffRun = 0;
  const scratch = document.createElement('canvas');
  const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });

  const renderPixels = async (page, scale, width, height) => {
    scratch.width = width;
    scratch.height = height;
    scratchCtx.fillStyle = '#fff';
    scratchCtx.fillRect(0, 0, width, height);
    const viewport = page.getViewport({ scale, rotation: rotationOf(page) });
    await page.render({ canvasContext: scratchCtx, viewport }).promise;
    return new Uint32Array(scratchCtx.getImageData(0, 0, width, height).data.buffer);
  };

  // Marks are a tiny canvas with one pixel per cell, stretched over the page.
  // The same cells, as an image, mask the overlay so that it only shows where
  // the pages differ. `size` / `otherSize` are the extent of the grid in
  // percent of the page shown and of the other document's page.
  const makeMarks = (cells, cols, rows, size, otherSize) => {
    const otherCanvas = document.createElement('canvas');
    const canvas = document.createElement('canvas');
    canvas.className = 'diffMarks';
    canvas.width = cols;
    canvas.height = rows;
    canvas.style.width = `${size[0]}%`;
    canvas.style.height = `${size[1]}%`;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = MARK_COLOR;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i]) {
        ctx.fillRect(i % cols, Math.floor(i / cols), 1, 1);
      }
    }
    // Enlarged without smoothing, so that the mask keeps fairly sharp edges when stretched.
    const mask = document.createElement('canvas');
    mask.width = cols * 2;
    mask.height = rows * 2;
    const maskCtx = mask.getContext('2d');
    maskCtx.imageSmoothingEnabled = false;
    maskCtx.drawImage(canvas, 0, 0, mask.width, mask.height);
    // A copy for the other document's page in the second viewer.
    otherCanvas.className = 'diffMarks';
    otherCanvas.width = cols;
    otherCanvas.height = rows;
    otherCanvas.style.width = `${otherSize[0]}%`;
    otherCanvas.style.height = `${otherSize[1]}%`;
    otherCanvas.getContext('2d').drawImage(canvas, 0, 0);
    return {
      canvas,
      otherCanvas,
      // Converts positions on the page shown into positions on the other document's page.
      ratio: [otherSize[0] / size[0], otherSize[1] / size[1]],
      mask: `url("${mask.toDataURL('image/png')}")`,
      maskSize: `${size[0]}% ${size[1]}%`,
      otherMaskSize: `${otherSize[0]}% ${otherSize[1]}%`,
    };
  };

  const attachMarks = (index) => {
    const entry = marks.get(index);
    const { main } = pairOf(index);
    const div = main === null ? null : viewer.getPageView(main)?.div;
    if (entry && div) {
      if (entry.canvas.parentNode !== div) {
        div.append(entry.canvas);
      }
      div.classList.add('diffPage');
      div.style.setProperty('--diff-mask', entry.mask);
      div.style.setProperty('--diff-mask-size', entry.maskSize);
      div.style.setProperty('--diff-mask-size-other', entry.otherMaskSize);
    }
    if (focus?.page === index && div && focusBox.parentNode !== div) {
      div.append(focusBox);
    }
    attachSecondMarks(index);
  };
  const attachSecondMarks = (index) => {
    const entry = marks.get(index);
    const { other } = pairOf(index);
    const div = secondDoc && other !== null ? secondViewer.getPageView(other)?.div : null;
    if (!div) {
      return;
    }
    if (entry && entry.otherCanvas.parentNode !== div) {
      div.append(entry.otherCanvas);
    }
    if (focus?.page === index && secondFocusBox.parentNode !== div) {
      div.append(secondFocusBox);
    }
  };

  /** Returns a copy of the cell grid in which every set cell is grown by `radius` cells. */
  const grow = (cells, cols, rows, radius) => {
    const grown = new Uint8Array(cells.length);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!cells[y * cols + x]) {
          continue;
        }
        for (let yy = Math.max(0, y - radius); yy <= Math.min(rows - 1, y + radius); yy++) {
          grown.fill(1, yy * cols + Math.max(0, x - radius), yy * cols + Math.min(cols - 1, x + radius) + 1);
        }
      }
    }
    return grown;
  };

  /**
   * Splits the marked cells into differences: cells that are connected in
   * `groups` (the marks grown a bit further) belong to the same difference.
   * Returns the bounding box of the marked cells of each one.
   */
  const findRegions = (cells, groups, cols, rows, unitX, unitY) => {
    const seen = new Uint8Array(groups.length);
    const regions = [];
    for (let start = 0; start < groups.length; start++) {
      if (!groups[start] || seen[start]) {
        continue;
      }
      let [minX, maxX, minY, maxY] = [cols, 0, rows, 0];
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        const x = i % cols;
        const y = (i - x) / cols;
        if (cells[i]) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
        for (let yy = Math.max(0, y - 1); yy <= Math.min(rows - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(cols - 1, x + 1); xx++) {
            const j = yy * cols + xx;
            if (groups[j] && !seen[j]) {
              seen[j] = 1;
              stack.push(j);
            }
          }
        }
      }
      regions.push({
        x: minX * unitX,
        y: minY * unitY,
        w: (maxX - minX + 1) * unitX,
        h: (maxY - minY + 1) * unitY,
      });
    }
    return regions.sort((a, b) => a.y - b.y || a.x - b.x);
  };

  /** The cells in which the two pages differ in their pixels, or null if they look the same. */
  const pixelHits = async (pages, scale, width, height, cols, rows) => {
    const pixelsA = await renderPixels(pages[0], scale, width, height);
    const pixelsB = await renderPixels(pages[1], scale, width, height);
    const hits = new Uint8Array(cols * rows);
    let differs = false;
    for (let i = 0; i < pixelsA.length; i++) {
      const pa = pixelsA[i];
      const pb = pixelsB[i];
      if (pa === pb) {
        continue;
      }
      const delta =
        Math.abs((pa & 0xff) - (pb & 0xff)) +
        Math.abs(((pa >> 8) & 0xff) - ((pb >> 8) & 0xff)) +
        Math.abs(((pa >> 16) & 0xff) - ((pb >> 16) & 0xff));
      if (delta > PIXEL_THRESHOLD) {
        hits[Math.floor(Math.floor(i / width) / CELL) * cols + Math.floor((i % width) / CELL)] = 1;
        differs = true;
      }
    }
    return differs ? hits : null;
  };

  /** The words of a page with their boxes in px at the given scale. */
  const pageWords = async (page, scale) => {
    const viewport = page.getViewport({ scale, rotation: rotationOf(page) });
    const content = await page.getTextContent();
    const words = [];
    for (const item of content.items) {
      if (!item.str?.trim()) {
        continue;
      }
      const [, , c, d, x, y] = item.transform;
      const height = item.height || Math.hypot(c, d);
      // The box of the item, from a bit below the baseline (descenders) to the top of the font.
      const [x0, y0] = viewport.convertToViewportPoint(x, y - height * 0.25);
      const [x1, y1] = viewport.convertToViewportPoint(x + item.width, y + height);
      const [left, right, top, bottom] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
      // Words get a share of the box by their number of characters.
      const horizontal = right - left >= bottom - top;
      for (const m of item.str.matchAll(/\S+/g)) {
        const from = m.index / item.str.length;
        const to = (m.index + m[0].length) / item.str.length;
        words.push({
          text: m[0],
          box: horizontal
            ? [left + from * (right - left), top, left + to * (right - left), bottom]
            : [left, top + from * (bottom - top), right, top + to * (bottom - top)],
        });
      }
    }
    return words;
  };

  /** Marks the words of a and b that are not in their longest common subsequence. */
  const changedWords = (a, b) => {
    const changedA = new Uint8Array(a.length);
    const changedB = new Uint8Array(b.length);
    let start = 0;
    while (start < a.length && start < b.length && a[start].text === b[start].text) {
      start++;
    }
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1].text === b[endB - 1].text) {
      endA--;
      endB--;
    }
    const n = endA - start;
    const m = endB - start;
    if (n * m > MAX_TEXT_DIFF) {
      changedA.fill(1, start, endA);
      changedB.fill(1, start, endB);
      return [changedA, changedB];
    }
    // lengths[i * (m + 1) + j]: length of the common subsequence of a[start + i ..] and b[start + j ..]
    const lengths = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lengths[i * (m + 1) + j] =
          a[start + i].text === b[start + j].text
            ? lengths[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(lengths[(i + 1) * (m + 1) + j], lengths[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i].text === b[start + j].text) {
        i++;
        j++;
      } else if (j >= m || (i < n && lengths[(i + 1) * (m + 1) + j] >= lengths[i * (m + 1) + j + 1])) {
        changedA[start + i++] = 1;
      } else {
        changedB[start + j++] = 1;
      }
    }
    return [changedA, changedB];
  };

  /**
   * The cells covered by words that were added, removed or changed, or null if the text is
   * the same. The words of both pages are marked; the pages are aligned at the top left.
   */
  const textHits = async (pages, scale, cols, rows) => {
    const [a, b] = await Promise.all(pages.map((p) => pageWords(p, scale)));
    const changed = changedWords(a, b);
    const hits = new Uint8Array(cols * rows);
    let differs = false;
    [a, b].forEach((words, side) =>
      words.forEach(({ box }, i) => {
        if (!changed[side][i]) {
          return;
        }
        differs = true;
        const clamp = (v, max) => Math.max(0, Math.min(max - 1, Math.floor(v / CELL)));
        for (let y = clamp(box[1], rows); y <= clamp(box[3], rows); y++) {
          hits.fill(1, y * cols + clamp(box[0], cols), y * cols + clamp(box[2], cols) + 1);
        }
      }),
    );
    return differs ? hits : null;
  };

  /** Compares the pages of a pair; returns the differing areas and their marks. */
  const diffPair = async (index) => {
    const { main, other } = pairOf(index);
    if (main === null || other === null) {
      // The page exists in only one document: mark it completely.
      return {
        marks: makeMarks([1], 1, 1, [100, 100], [100, 100]),
        regions: [{ x: 0, y: 0, w: 1, h: 1 }],
      };
    }
    const pages = [await docs[mainSide].getPage(main + 1), await docs[otherSide()].getPage(other + 1)];
    const sizes = pages.map((p) => p.getViewport({ scale: 1, rotation: rotationOf(p) }));
    const scale = DIFF_WIDTH / Math.max(sizes[0].width, sizes[1].width);
    const width = Math.ceil(Math.max(sizes[0].width, sizes[1].width) * scale);
    const height = Math.ceil(Math.max(sizes[0].height, sizes[1].height) * scale);
    const cols = Math.ceil(width / CELL);
    const rows = Math.ceil(height / CELL);
    const hits = textDiff
      ? await textHits(pages, scale, cols, rows)
      : await pixelHits(pages, scale, width, height, cols, rows);
    if (!hits) {
      return { regions: [] };
    }
    const cells = grow(hits, cols, rows, MARK_PADDING);
    const groups = grow(hits, cols, rows, GROUP_DISTANCE);
    // The grid covers the larger of the two pages; scale it relative to each page.
    const percent = (size) => [
      ((cols * CELL) / (size.width * scale)) * 100,
      ((rows * CELL) / (size.height * scale)) * 100,
    ];
    const [shown, otherSize] = sizes;
    return {
      marks: makeMarks(cells, cols, rows, percent(shown), percent(otherSize)),
      regions: findRegions(
        cells,
        groups,
        cols,
        rows,
        CELL / (shown.width * scale),
        CELL / (shown.height * scale),
      ),
    };
  };

  /** All differences found so far, in reading order. */
  const allDiffs = () =>
    diffResults.flatMap((regions, page) => (regions ?? []).map((region) => ({ page, region })));

  // The extension lists the differences in the Problems view of VS Code.
  let reported = '[]';
  const reportDifferences = (diffs) => {
    const items = diffs.map(({ page }) => {
      const { main, other } = pairOf(page);
      const [left, right] = mainSide === 'left' ? [main, other] : [other, main];
      return {
        page: (left ?? right) + 1,
        otherPage: left !== null && right !== null && left !== right ? right + 1 : undefined,
        only: left === null ? 'right' : right === null ? 'left' : undefined,
      };
    });
    const serialized = JSON.stringify(items);
    if (serialized !== reported) {
      reported = serialized;
      vscode.postMessage({ type: 'differences', items });
    }
  };

  const updateDiffStatus = () => {
    const done = diffResults.filter((r) => r !== null).length;
    const diffs = allDiffs();
    const pages = diffResults.filter((r) => r?.length).length;
    const focused = focus ? diffs.findIndex((d) => d.region === focus.region) : -1;
    let text = '';
    if (!diffResults.length) {
      text = '';
    } else if (done < diffResults.length) {
      text = `Vergleiche … ${done} / ${diffResults.length}`;
    } else if (!diffs.length) {
      text = 'No differences';
    } else if (focused >= 0 && !diffsOff()) {
      text = `Difference ${focused + 1} of ${diffs.length}`;
    } else {
      text =
        `${diffs.length} ${diffs.length === 1 ? 'difference' : 'differences'} ` +
        `on ${pages} ${pages === 1 ? 'page' : 'pages'}`;
    }
    $('diffStatus').textContent = text;
    // Without differences there is nothing to show, hide, or jump to.
    for (const id of ['diffToggle', 'diffPrev', 'diffNext', 'showLeft', 'showRight']) {
      $(id).disabled = !diffs.length;
    }
    // Side by side, both documents are always shown.
    $('showLeft').disabled ||= sideBySide;
    $('showRight').disabled ||= sideBySide;
    $('diffPrev').disabled ||= diffsOff();
    $('diffNext').disabled ||= diffsOff();
    if (diffResults.length && done === diffResults.length && !diffs.length && (!show.left || !show.right)) {
      // A hidden document could not be shown again with the buttons disabled.
      show.left = show.right = true;
      applyVisibility();
    }
    reportDifferences(diffs);
  };

  // After opening, the view jumps to the first difference - unless the user
  // has started to navigate on their own before it was found.
  let jumpToFirst = true;
  for (const type of ['wheel', 'pointerdown', 'keydown']) {
    window.addEventListener(type, () => (jumpToFirst = false), { capture: true, passive: true });
  }
  const tryJumpToFirst = () => {
    if (diffsOff()) {
      jumpToFirst = false;
      return;
    }
    // The first difference is known once all pages before it have been compared.
    const page = diffResults.findIndex((regions) => regions === null || regions.length);
    if (page < 0) {
      jumpToFirst = false; // no differences at all
    } else if (diffResults[page]) {
      jumpToFirst = false;
      focusDiff({ page, region: diffResults[page][0] });
    }
  };

  let diffFinished = Promise.resolve();
  const runDiff = () => {
    const run = ++diffRun;
    // An earlier run stops after the page it is working on; wait for that,
    // as the comparison uses a single scratch canvas.
    diffFinished = diffFinished.then(() => (run === diffRun ? compareAllPages(run) : undefined));
    return diffFinished;
  };
  const compareAllPages = async (run) => {
    marks.forEach((entry) => (entry.canvas.remove(), entry.otherCanvas.remove()));
    marks.clear();
    for (let i = 0; i < viewer.pagesCount; i++) {
      viewer.getPageView(i)?.div.classList.remove('diffPage');
    }
    focus = null;
    focusBox.remove();
    secondFocusBox.remove();
    diffOffset = pairOffset();
    firstPair = Math.min(0, -diffOffset);
    const pairs = Math.max(docs[mainSide].numPages, docs[otherSide()].numPages - diffOffset) - firstPair;
    diffResults = new Array(pairs).fill(null);
    updateDiffStatus();
    for (let remaining = diffResults.length; remaining > 0; remaining--) {
      // Compare the pages closest to what the user is looking at first.
      const around = viewer.currentPageNumber - 1 - firstPair;
      let index = -1;
      for (let i = 0; i < diffResults.length; i++) {
        if (diffResults[i] === null && (index < 0 || Math.abs(i - around) < Math.abs(index - around))) {
          index = i;
        }
      }
      let result;
      try {
        result = await diffPair(index);
      } catch (err) {
        if (run === diffRun) {
          console.error(`Page ${index + firstPair + 1} could not be compared`, err);
        }
        result = { regions: [] };
      }
      if (run !== diffRun) {
        return; // a document was reloaded or the pages were rotated in the meantime
      }
      diffResults[index] = result.regions;
      if (result.marks) {
        marks.set(index, result.marks);
      }
      attachMarks(index);
      updateDiffStatus();
      if (jumpToFirst) {
        tryJumpToFirst();
      }
      await new Promise((resolve) => setTimeout(resolve)); // keep the UI responsive
    }
  };

  // pdf.js removes foreign nodes from a page whenever it re-renders it.
  eventBus.on('pagerendered', (e) => {
    // The sharper detail of the visible part, rendered at high zoom, leaves them alone.
    if (!e.isDetailView) {
      void renderOtherLayer(e.source);
    }
    attachMarks(e.pageNumber - 1 - firstPair);
  });

  /** The pane the jumps between differences start from. */
  const activePane = () => (sideBySide && secondDoc ? activeContainer : container);
  // Top of a difference in one of the panes. A page that the second viewer does not have
  // counts as being after its end.
  const diffTop = ({ page, region }, c = container) => {
    const { k, main, other } = pairOf(page);
    const index = c === container ? main : other;
    const div = index === null ? null : (c === container ? viewer : secondViewer).getPageView(index)?.div;
    if (!div) {
      // Before the first page or after the last one.
      return (c === container ? k : k + diffOffset) < 0 ? 0 : c.scrollHeight;
    }
    const ry = c === container ? 1 : (marks.get(page)?.ratio[1] ?? 1);
    return div.offsetTop + div.clientTop + region.y * ry * div.clientHeight;
  };
  // Scrolls an area of a page (fractions of the page) into view if it is not completely visible.
  const reveal = (c, div, region) => {
    const top = div.offsetTop + div.clientTop + region.y * div.clientHeight;
    const bottom = top + region.h * div.clientHeight;
    if (top < c.scrollTop || bottom > c.scrollTop + c.clientHeight) {
      c.scrollTop = Math.max(0, top - FOCUS_MARGIN);
    }
    const left = div.offsetLeft + div.clientLeft + region.x * div.clientWidth;
    const right = left + region.w * div.clientWidth;
    if (left < c.scrollLeft || right > c.scrollLeft + c.clientWidth) {
      c.scrollLeft = Math.max(0, left - FOCUS_MARGIN);
    }
  };
  const frame = (box, region) =>
    Object.assign(box.style, {
      left: `${region.x * 100}%`,
      top: `${region.y * 100}%`,
      width: `${region.w * 100}%`,
      height: `${region.h * 100}%`,
    });
  // Frames a difference and scrolls to it if necessary.
  const focusDiff = (target) => {
    const { region } = target;
    const { main, other } = pairOf(target.page);
    const div = main === null ? null : viewer.getPageView(main)?.div;
    const secondDiv = secondDoc && other !== null ? secondViewer.getPageView(other)?.div : null;
    if (!div && !secondDiv) {
      return;
    }
    frame(focusBox, region);
    focusBox.remove();
    div?.append(focusBox);
    // On the other document's page the same area can be at another position if the page sizes differ.
    const [rx, ry] = marks.get(target.page)?.ratio ?? [1, 1];
    const secondRegion = { x: region.x * rx, y: region.y * ry, w: region.w * rx, h: region.h * ry };
    frame(secondFocusBox, secondRegion);
    secondFocusBox.remove();
    focus = { ...target, scrollTop: container.scrollTop };
    attachSecondMarks(target.page);
    // The difference is shown in the active pane; with the scroll lock the other one follows,
    // without it both scroll to it.
    const pane = (activePane() === secondContainer || !div) && secondDiv ? secondContainer : container;
    if (div && (pane === container || !scrollLock)) {
      reveal(container, div, region);
    }
    if (secondDiv && (pane === secondContainer || !scrollLock)) {
      reveal(secondContainer, secondDiv, secondRegion);
    }
    focus = { ...target, pane, scrollTop: pane.scrollTop };
    updateDiffStatus();
  };
  const goToDiff = (direction) => {
    if (diffsOff()) {
      return;
    }
    const diffs = allDiffs();
    const current = focus ? diffs.findIndex((d) => d.region === focus.region) : -1;
    const c = activePane();
    let index;
    if (current >= 0 && focus.pane === c && Math.abs(c.scrollTop - focus.scrollTop) <= 2) {
      index = current + direction;
    } else {
      // No difference selected, or the user has scrolled since: continue from what is visible
      // in the active pane.
      const top = c.scrollTop;
      index =
        direction > 0
          ? diffs.findIndex((d, i) => i !== current && diffTop(d, c) >= top)
          : diffs.findLastIndex((d, i) => i !== current && diffTop(d, c) < top + FOCUS_MARGIN - 1);
    }
    if (diffs[index]) {
      focusDiff(diffs[index]);
    }
  };
  $('diffPrev').addEventListener('click', () => goToDiff(-1));
  $('diffNext').addEventListener('click', () => goToDiff(1));

  // --- Side by side and scroll lock ---
  // Scroll positions in pages: the index of the page at the top plus how far (0..1) it is
  // scrolled out of view. Unlike pixels, they do not depend on the zoom or the page heights.
  const pagePosition = (v, c, top = c.scrollTop) => {
    for (let i = 0; i < v.pagesCount; i++) {
      const div = v.getPageView(i)?.div;
      if (div && div.offsetTop + div.offsetHeight > top) {
        return i + Math.max(0, (top - div.offsetTop) / div.offsetHeight);
      }
    }
    return v.pagesCount;
  };
  const scrollTopAt = (v, position) => {
    const index = Math.max(0, Math.min(Math.floor(position), v.pagesCount - 1));
    const div = v.getPageView(index)?.div;
    if (!div) {
      return 0;
    }
    return div.offsetTop + Math.max(0, Math.min(1, position - index)) * div.offsetHeight;
  };
  let scrollLock = state.scrollLock !== false;
  // How many pages the second viewer is ahead of the main one. The lock keeps the pages that
  // were shown when it was switched on side by side, e.g. page 3 next to page 5, and shows the
  // same part of both pages.
  let lockOffset = 0;
  const measureLockOffset = () => {
    // The page in the middle of each pane is the one that is shown.
    const shownPage = (v, c) => Math.min(Math.floor(pagePosition(v, c, c.scrollTop + c.clientHeight / 2)), v.pagesCount - 1);
    lockOffset = shownPage(secondViewer, secondContainer) - shownPage(viewer, container);
  };
  /** Positions set by the lock; their scroll events are not passed on again. */
  const syncedTo = new Map();
  /** Sets a position that the lock is not to pass on. */
  const scrollUnsynced = (c, top, left) => {
    c.scrollTop = top;
    c.scrollLeft = left;
    syncedTo.set(c, { top: c.scrollTop, left: c.scrollLeft });
  };
  // Number of viewers being reloaded. Meanwhile the lock does nothing, as a viewer jumps to the
  // top when it gets the new document; afterwards both get back their own positions.
  let reloading = 0;
  // Scrolls the other pane by as many pages as this one, and to the same horizontal position.
  // Pages of different heights therefore stay side by side.
  const syncScroll = (from) => {
    if (!sideBySide || !scrollLock || !secondReady || !viewerDoc || reloading) {
      return;
    }
    const [fromViewer, to, toViewer, offset] =
      from === container
        ? [viewer, secondContainer, secondViewer, lockOffset]
        : [secondViewer, container, viewer, -lockOffset];
    to.scrollTop = scrollTopAt(toViewer, pagePosition(fromViewer, from) + offset);
    to.scrollLeft = from.scrollLeft;
    syncedTo.set(to, { top: to.scrollTop, left: to.scrollLeft });
  };
  for (const c of containers) {
    c.addEventListener('scroll', () => {
      const synced = syncedTo.get(c);
      syncedTo.delete(c);
      if (!synced || synced.top !== c.scrollTop || synced.left !== c.scrollLeft) {
        syncScroll(c);
      }
    });
  }

  /** Puts the other document into the second viewer, or none while the view is not side by side. */
  const updateSecondViewer = () => {
    const doc = sideBySide && viewerDoc ? docs[otherSide()] : null;
    if (doc === secondDoc) {
      return;
    }
    const keep = secondReady
      ? { top: secondContainer.scrollTop, left: secondContainer.scrollLeft, scale: secondViewer.currentScaleValue }
      : null;
    secondDoc = doc;
    secondReady = false;
    if (!keep) {
      lockOffset = 0; // newly side by side: page 1 next to page 1
    }
    if (doc) {
      if (keep) {
        reloading++;
      }
      secondBus.on(
        'pagesinit',
        () => {
          if (secondDoc !== doc) {
            reloading -= keep ? 1 : 0;
            return; // replaced in the meantime
          }
          secondReady = true;
          secondViewer.pagesRotation = viewer.pagesRotation;
          // Its own zoom is kept over a reload; when it is linked or new, it takes that of the main viewer.
          if (keep && !zoomLinked()) {
            secondViewer.currentScaleValue = keep.scale;
          } else {
            secondViewer.currentScale = viewer.currentScale;
          }
          // Once the pages are laid out: where it was before a reload, or, when it is new, in line
          // with the main viewer.
          secondBus.on(
            'pagerendered',
            () =>
              requestAnimationFrame(() => {
                if (keep) {
                  scrollUnsynced(secondContainer, keep.top, keep.left);
                  reloading--;
                } else {
                  syncScroll(container);
                }
              }),
            { once: true },
          );
        },
        { once: true },
      );
    }
    secondViewer.setDocument(doc);
    secondLinks.setDocument(doc);
  };
  secondBus.on('pagerendered', (e) => attachSecondMarks(e.pageNumber - 1 - diffOffset - firstPair));
  /** Compares again if other pages are now next to each other. */
  const refreshPairs = () => {
    if (pairOffset() !== diffOffset) {
      void runDiff();
    }
  };

  const applySideBySide = () => {
    $('sideBySide').setAttribute('aria-pressed', String(sideBySide));
    $('scrollLock').disabled = !sideBySide;
    $('scrollLock').setAttribute('aria-pressed', String(scrollLock));
    setShowMarks(marksShown());
    applyVisibility();
    updateSecondViewer();
    updateDiffStatus();
  };
  $('sideBySide').addEventListener('click', () => {
    sideBySide = !sideBySide;
    updateState({ sideBySide });
    applySideBySide();
    if (!sideBySide) {
      renderAllOtherLayers();
    }
    refreshPairs();
  });
  $('scrollLock').addEventListener('click', () => {
    scrollLock = !scrollLock;
    updateState({ scrollLock });
    applySideBySide();
    // The pages shown stay; the other pane takes the zoom and the part of the page of the one the user is looking at.
    if (scrollLock && secondReady) {
      measureLockOffset();
      if (activePane() === secondContainer) {
        viewer.currentScale = secondViewer.currentScale;
      } else {
        secondViewer.currentScale = viewer.currentScale;
      }
    }
    showScale(zoomViewer());
    syncScroll(activePane());
    refreshPairs();
  });

  // --- Loading ---
  // The scroll position to come back to after a reload. It is kept until the new pages are
  // rendered, because both documents often reload one after the other.
  let savedScroll = null;
  const restoreScroll = () => {
    if (savedScroll) {
      scrollUnsynced(container, savedScroll.top, savedScroll.left);
    }
  };
  // Called whenever a document was (re)loaded; nothing is shown before both are there.
  const rebuild = () => {
    if (!docs.left || !docs.right) {
      return;
    }
    mainSide = docs.left.numPages > docs.right.numPages ? 'left' : 'right';
    applyVisibility();
    const mainDoc = docs[mainSide];
    if (viewerDoc !== mainDoc) {
      const first = !viewerDoc;
      if (!first && !savedScroll) {
        savedScroll = { top: container.scrollTop, left: container.scrollLeft };
      }
      viewerDoc = mainDoc;
      otherRenders.clear();
      if (!first) {
        reloading++;
      }
      eventBus.on(
        'pagesinit',
        () => {
          viewer.pagesRotation = state.rotation ?? 0;
          viewer.currentScaleValue = state.scale ?? 'page-width';
          if (first) {
            viewer.currentPageNumber = Math.min(state.page ?? 1, mainDoc.numPages);
          } else {
            restoreScroll();
            // The scrollable size is only final once the pages are laid out; before that the position is clamped.
            eventBus.on(
              'pagerendered',
              () =>
                requestAnimationFrame(() => {
                  restoreScroll();
                  savedScroll = null;
                  reloading--;
                }),
              { once: true },
            );
          }
        },
        { once: true },
      );
      viewer.setDocument(mainDoc);
      linkService.setDocument(mainDoc);
      $('pageCount').textContent = `/ ${mainDoc.numPages}`;
      $('pageNumber').max = String(mainDoc.numPages);
    } else {
      renderAllOtherLayers();
    }
    updateSecondViewer();
    void runDiff();
  };

  async function load(side, data) {
    const previousTask = tasks[side];
    let task;
    try {
      task = tasks[side] = openDocument(data);
      const doc = await task.promise;
      if (task !== tasks[side]) {
        void task.destroy(); // superseded by a newer load
        return;
      }
      docs[side] = doc;
      showMessage('');
      rebuild();
      void previousTask?.destroy();
    } catch (err) {
      if (task && task !== tasks[side]) {
        return; // superseded by a newer load
      }
      const name = $(side === 'left' ? 'showLeft' : 'showRight').textContent.trim();
      showMessage(
        err?.name === 'PasswordException'
          ? `${name} is password-protected and cannot be displayed.`
          : `${name} could not be loaded: ${err?.message ?? err}`,
      );
    }
  }

  // --- Keyboard ---
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      zoomViewer().increaseScale();
    } else if (mod && e.key === '-') {
      e.preventDefault();
      zoomViewer().decreaseScale();
    } else if (mod && e.key === '0') {
      e.preventDefault();
      zoomViewer().currentScaleValue = 'page-width';
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'load') {
      void load(msg.side, msg.data);
    } else if (msg.type === 'goToDiff') {
      goToDiff(msg.direction);

    } else if (msg.type === 'error') {
      showMessage(`The file could not be read: ${msg.message}`);
    }
  });

  applySideBySide();
  vscode.postMessage({ type: 'ready' });
}

main().catch((err) => showMessage(`The viewer could not be started: ${err?.message ?? err}`));
