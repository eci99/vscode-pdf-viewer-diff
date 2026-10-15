// @ts-check
// Compare view: both documents are drawn on top of each other. The document
// with more pages is shown by a regular pdf.js viewer ("main"), the pages of
// the other one are rendered into an extra layer inside each page ("other").
// Tinting one document red and the other green and multiplying the layers
// makes identical content black, while differences keep their colour. This
// is only done where the pages differ; everywhere else the page stays as it is.
import { MAX_SCALE, MIN_SCALE, enableDragScroll, initPdfjs, setupFind, trackToolbarHeight } from './common.js';

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

  /** @type {{ page?: number, scale?: string, rotation?: number, tool?: string, showLeft?: boolean, showRight?: boolean, showMarks?: boolean }} */
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
      $('customScale').textContent = `${Math.round(e.scale * 100)} %`;
      select.value = 'custom';
    }
    updateState({ scale: viewer.currentScaleValue });
  });
  container.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setScale(viewer.currentScale * Math.exp(-e.deltaY / 400));
      }
    },
    { passive: false },
  );
  // Keep "fit" presets fitting when the editor is resized.
  new ResizeObserver(() => {
    const value = viewer.currentScaleValue;
    if (viewerDoc && (value === 'auto' || value === 'page-fit' || value === 'page-width')) {
      viewer.currentScaleValue = value;
    }
  }).observe(container);

  // --- Back to the start ---
  $('resetView').addEventListener('click', () => {
    if (!viewerDoc) {
      return;
    }
    viewer.currentScaleValue = 'auto';
    viewer.currentPageNumber = 1;
    container.scrollTop = 0;
    container.scrollLeft = 0;
  });

  // --- Rotation ---
  /** Rotation to render a page with: its own one plus the one chosen in the toolbar. */
  const rotationOf = (page) => (page.rotate + viewer.pagesRotation) % 360;
  const rotate = (delta) => {
    if (!viewerDoc) {
      return;
    }
    viewer.pagesRotation = (viewer.pagesRotation + delta + 360) % 360;
    updateState({ rotation: viewer.pagesRotation });
    // Marks and differences are positions on the rotated page: compare again.
    void runDiff();
  };
  $('rotateLeft').addEventListener('click', () => rotate(-90));
  $('rotateRight').addEventListener('click', () => rotate(90));

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
  applyTool(state.tool);
  enableDragScroll(container, () => handTool);
  $('toolSelect').addEventListener('click', () => (applyTool('select'), updateState({ tool: 'select' })));
  $('toolHand').addEventListener('click', () => (applyTool('hand'), updateState({ tool: 'hand' })));

  // --- Showing / hiding the two documents and the difference marks ---
  const show = { left: state.showLeft !== false, right: state.showRight !== false };
  const applyVisibility = () => {
    document.body.classList.toggle('hideMain', !show[mainSide]);
    document.body.classList.toggle('hideOther', !show[otherSide()]);
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

  const setShowMarks = (on) => {
    document.body.classList.toggle('hideMarks', !on);
    $('diffToggle').setAttribute('aria-pressed', String(on));
  };
  setShowMarks(state.showMarks !== false);
  $('diffToggle').addEventListener('click', () => {
    const on = $('diffToggle').getAttribute('aria-pressed') !== 'true';
    setShowMarks(on);
    updateState({ showMarks: on });
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
    if (!doc || n > doc.numPages) {
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
  /**
   * Per page: the differing areas (position and size as fractions of the page
   * shown), or null while the page has not been compared yet.
   * @type {({ x: number, y: number, w: number, h: number }[] | null)[]}
   */
  let diffResults = [];
  /** @type {{ page: number, region: object, scrollTop: number } | null} difference last jumped to */
  let focus = null;
  const focusBox = document.createElement('div');
  focusBox.className = 'diffFocus';
  /** @type {Map<number, HTMLCanvasElement>} page index -> marks */
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
    return {
      canvas,
      mask: `url("${mask.toDataURL('image/png')}")`,
      maskSize: `${size[0]}% ${size[1]}%`,
      otherMaskSize: `${otherSize[0]}% ${otherSize[1]}%`,
    };
  };

  const attachMarks = (index) => {
    const entry = marks.get(index);
    const div = viewer.getPageView(index)?.div;
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

  /** Compares page n (1-based) of both documents; returns the differing areas and their marks. */
  const diffPage = async (n) => {
    const sides = ['left', 'right'];
    if (sides.some((side) => n > docs[side].numPages)) {
      // The page exists in only one document: mark it completely.
      return {
        marks: makeMarks([1], 1, 1, [100, 100], [100, 100]),
        regions: [{ x: 0, y: 0, w: 1, h: 1 }],
      };
    }
    const pages = [await docs.left.getPage(n), await docs.right.getPage(n)];
    const sizes = pages.map((p) => p.getViewport({ scale: 1, rotation: rotationOf(p) }));
    const scale = DIFF_WIDTH / Math.max(sizes[0].width, sizes[1].width);
    const width = Math.ceil(Math.max(sizes[0].width, sizes[1].width) * scale);
    const height = Math.ceil(Math.max(sizes[0].height, sizes[1].height) * scale);
    const pixelsA = await renderPixels(pages[0], scale, width, height);
    const pixelsB = await renderPixels(pages[1], scale, width, height);

    const cols = Math.ceil(width / CELL);
    const rows = Math.ceil(height / CELL);
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
    if (!differs) {
      return { regions: [] };
    }
    const cells = grow(hits, cols, rows, MARK_PADDING);
    const groups = grow(hits, cols, rows, GROUP_DISTANCE);
    // The grid covers the larger of the two pages; scale it relative to each page.
    const percent = (size) => [
      ((cols * CELL) / (size.width * scale)) * 100,
      ((rows * CELL) / (size.height * scale)) * 100,
    ];
    const shown = sizes[sides.indexOf(mainSide)];
    const other = sizes[sides.indexOf(otherSide())];
    return {
      marks: makeMarks(cells, cols, rows, percent(shown), percent(other)),
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
    const items = diffs.map(({ page }) => ({
      page: page + 1,
      only:
        page >= docs.left.numPages ? 'right' : page >= docs.right.numPages ? 'left' : undefined,
    }));
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
    } else if (focused >= 0) {
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
    marks.forEach((entry) => entry.canvas.remove());
    marks.clear();
    for (let i = 0; i < viewer.pagesCount; i++) {
      viewer.getPageView(i)?.div.classList.remove('diffPage');
    }
    focus = null;
    focusBox.remove();
    diffResults = new Array(Math.max(docs.left.numPages, docs.right.numPages)).fill(null);
    updateDiffStatus();
    for (let remaining = diffResults.length; remaining > 0; remaining--) {
      // Compare the pages closest to what the user is looking at first.
      const around = viewer.currentPageNumber - 1;
      let index = -1;
      for (let i = 0; i < diffResults.length; i++) {
        if (diffResults[i] === null && (index < 0 || Math.abs(i - around) < Math.abs(index - around))) {
          index = i;
        }
      }
      let result;
      try {
        result = await diffPage(index + 1);
      } catch (err) {
        if (run === diffRun) {
          console.error(`Page ${index + 1} could not be compared`, err);
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
    attachMarks(e.pageNumber - 1);
  });

  const diffTop = ({ page, region }) => {
    const div = viewer.getPageView(page).div;
    return div.offsetTop + div.clientTop + region.y * div.clientHeight;
  };
  // Frames a difference and scrolls to it if necessary.
  const focusDiff = (target) => {
    const { region } = target;
    const div = viewer.getPageView(target.page).div;
    Object.assign(focusBox.style, {
      left: `${region.x * 100}%`,
      top: `${region.y * 100}%`,
      width: `${region.w * 100}%`,
      height: `${region.h * 100}%`,
    });
    div.append(focusBox);
    // Only scroll if the difference is not completely visible already.
    const top = diffTop(target);
    const bottom = top + region.h * div.clientHeight;
    if (top < container.scrollTop || bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = Math.max(0, top - FOCUS_MARGIN);
    }
    const left = div.offsetLeft + div.clientLeft + region.x * div.clientWidth;
    const right = left + region.w * div.clientWidth;
    if (left < container.scrollLeft || right > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = Math.max(0, left - FOCUS_MARGIN);
    }
    focus = { ...target, scrollTop: container.scrollTop };
    updateDiffStatus();
  };
  const goToDiff = (direction) => {
    const diffs = allDiffs();
    const current = focus ? diffs.findIndex((d) => d.region === focus.region) : -1;
    let index;
    if (current >= 0 && Math.abs(container.scrollTop - focus.scrollTop) <= 2) {
      index = current + direction;
    } else {
      // No difference selected, or the user has scrolled since: continue from what is visible.
      const top = container.scrollTop;
      index =
        direction > 0
          ? diffs.findIndex((d, i) => i !== current && diffTop(d) >= top)
          : diffs.findLastIndex((d, i) => i !== current && diffTop(d) < top + FOCUS_MARGIN - 1);
    }
    if (diffs[index]) {
      focusDiff(diffs[index]);
    }
  };
  $('diffPrev').addEventListener('click', () => goToDiff(-1));
  $('diffNext').addEventListener('click', () => goToDiff(1));

  // --- Loading ---
  // The scroll position to come back to after a reload. It is kept until the new pages are
  // rendered, because both documents often reload one after the other.
  let savedScroll = null;
  const restoreScroll = () => {
    if (savedScroll) {
      container.scrollTop = savedScroll.top;
      container.scrollLeft = savedScroll.left;
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
      viewer.increaseScale();
    } else if (mod && e.key === '-') {
      e.preventDefault();
      viewer.decreaseScale();
    } else if (mod && e.key === '0') {
      e.preventDefault();
      viewer.currentScaleValue = 'page-width';
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

  applyVisibility();
  vscode.postMessage({ type: 'ready' });
}

main().catch((err) => showMessage(`The viewer could not be started: ${err?.message ?? err}`));
