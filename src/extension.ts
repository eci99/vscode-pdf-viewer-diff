import * as crypto from 'crypto';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const compareProvider = new CompareEditorProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      PdfEditorProvider.viewType,
      new PdfEditorProvider(context.extensionUri),
      {
        supportsMultipleEditorsPerDocument: true,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    vscode.window.registerCustomEditorProvider(CompareEditorProvider.viewType, compareProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerFileSystemProvider(COMPARE_SCHEME, new CompareFileSystem(), {
      isReadonly: true,
    }),
    compareProvider.differences,
    vscode.commands.registerCommand(
      'pdfViewer.compare',
      (uri?: vscode.Uri, selected?: vscode.Uri[]) => comparePdfs(uri, selected),
    ),
    vscode.commands.registerCommand('pdfViewer.nextDifference', () => compareProvider.goToDifference(1)),
    vscode.commands.registerCommand('pdfViewer.previousDifference', () =>
      compareProvider.goToDifference(-1),
    ),
  );
}

export function deactivate(): void {}

const isPdf = (uri: vscode.Uri): boolean => uri.path.toLowerCase().endsWith('.pdf');
const baseName = (uri: vscode.Uri): string => uri.path.split('/').pop()!;

// The file is read through workspace.fs so that remote and virtual
// file systems (SSH, WSL, git: URIs, ...) work as well.
async function readPdf(uri: vscode.Uri): Promise<ArrayBuffer> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  // readFile may return a Node Buffer, which postMessage would serialize
  // as JSON; a plain ArrayBuffer is transferred as binary.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sendPdf(
  webview: vscode.Webview,
  read: () => ArrayBuffer | Promise<ArrayBuffer>,
  extra: object = {},
): Promise<void> {
  try {
    await webview.postMessage({ type: 'load', data: await read(), ...extra });
  } catch (err) {
    await webview.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// How long (ms) after opening a PDF it is checked whether it is part of a diff editor.
const DIFF_EDITOR_DELAY = 100;

// How long (ms) a compared file has to stay deleted before its comparison is closed.
const FILE_GONE_DELAY = 2000;

// Calls onChange (debounced) when the file changes on disk, e.g. after a LaTeX build,
// and onDelete when it is deleted.
function watchFile(uri: vscode.Uri, onChange: () => void, onDelete?: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), baseName(uri)),
  );
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  };
  watcher.onDidChange(schedule);
  watcher.onDidCreate(schedule);
  if (onDelete) {
    watcher.onDidDelete(onDelete);
  }
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    watcher.dispose();
  });
}

class PdfDocument implements vscode.CustomDocument {
  private current?: ArrayBuffer;
  private confirmed?: ArrayBuffer;
  /** The last version that was displayed successfully before the current one. */
  previous?: ArrayBuffer;

  constructor(readonly uri: vscode.Uri) {}

  async read(): Promise<ArrayBuffer> {
    const data = await readPdf(this.uri);
    // Keep the same object if nothing changed (e.g. a second editor reading the same version).
    if (!this.current || Buffer.compare(new Uint8Array(this.current), new Uint8Array(data)) !== 0) {
      this.current = data;
    }
    return this.current;
  }

  // Called once a webview has displayed the current version. Only such versions
  // become "previous", so a half-written file never ends up there.
  confirmCurrent(): void {
    if (this.current && this.confirmed !== this.current) {
      this.previous = this.confirmed ?? this.previous;
      this.confirmed = this.current;
    }
  }

  dispose(): void {}
}

class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  static readonly viewType = 'pdfViewer.preview';

  /** The open editors, in the order they were opened. */
  private readonly panels = new Map<vscode.WebviewPanel, PdfDocument>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): PdfDocument {
    return new PdfDocument(uri);
  }

  // The diff editor of VS Code (e.g. for a change in Source Control) shows two of these
  // editors side by side in one tab. There is no API that tells so; the pair is recognised
  // by both panels being visible in the same editor group. It is replaced by a comparison.
  private replaceDiffEditor(panel: vscode.WebviewPanel): void {
    if (!this.panels.has(panel)) {
      return;
    }
    const pair = [...this.panels].filter(
      ([other]) => other.visible && other.viewColumn === panel.viewColumn,
    );
    const tab = vscode.window.tabGroups.all.find((g) => g.viewColumn === panel.viewColumn)?.activeTab;
    if (pair.length !== 2 || !tab || tab.input instanceof vscode.TabInputCustom) {
      return;
    }
    // The original is opened first; a version from git is the original in any case.
    let [original, modified] = pair.map(([, document]) => document.uri);
    if (original.scheme !== GIT_SCHEME && modified.scheme === GIT_SCHEME) {
      [original, modified] = [modified, original];
    }
    openCompare(fileSource(original), fileSource(modified), {
      viewColumn: panel.viewColumn,
      preview: tab.isPreview,
    }).then(
      // If the diff was a preview tab, the comparison has replaced it already.
      () => vscode.window.tabGroups.close(tab).then(undefined, () => {}),
      () => {},
    );
  }

  resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    webview.options = webviewOptions(this.extensionUri);
    const send = (): Promise<void> => sendPdf(webview, () => document.read());

    const disposables: vscode.Disposable[] = [
      webview.onDidReceiveMessage((msg: { type: string }) => {
        if (msg.type === 'ready') {
          void send();
        } else if (msg.type === 'loaded') {
          document.confirmCurrent();
          void webview.postMessage({ type: 'previous', available: !!document.previous });
        } else if (msg.type === 'comparePrevious' && document.previous) {
          const name = baseName(document.uri);
          void openCompare(
            {
              name: `${name} (before)`,
              description: 'Version before the last reload',
              data: document.previous,
            },
            { name, description: vscode.workspace.asRelativePath(document.uri), uri: document.uri },
          );
        }
      }),
      watchFile(document.uri, () => void send()),
    ];
    this.panels.set(panel, document);
    panel.onDidDispose(() => {
      this.panels.delete(panel);
      disposables.forEach((d) => d.dispose());
    });

    webview.html = buildHtml(webview, this.extensionUri, 'viewer.js', VIEWER_BODY);
    // Wait until the tab and the visibility of the panels are known.
    const timer = setTimeout(() => this.replaceDiffEditor(panel), DIFF_EDITOR_DELAY);
    disposables.push(new vscode.Disposable(() => clearTimeout(timer)));
  }
}

// One side of a comparison: a file that is watched for changes, or a fixed snapshot.
interface CompareSource {
  name: string;
  description: string;
  uri?: vscode.Uri;
  data?: ArrayBuffer;
}

async function comparePdfs(uri?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
  const pickPdf = async (title: string, near?: vscode.Uri): Promise<vscode.Uri | undefined> => {
    const picked = await vscode.window.showOpenDialog({
      title,
      openLabel: 'Select',
      canSelectMany: false,
      filters: { PDF: ['pdf'] },
      defaultUri: near && vscode.Uri.joinPath(near, '..'),
    });
    return picked?.[0];
  };

  let left: vscode.Uri | undefined;
  let right: vscode.Uri | undefined;
  const pdfs = selected?.filter(isPdf) ?? [];
  if (pdfs.length === 2) {
    // Two files selected in the explorer: compare them directly.
    [left, right] = pdfs;
  } else {
    left = uri ?? activePdfUri() ?? (await pickPdf('Select the first PDF file'));
    if (!left) {
      return;
    }
    right = await pickPdf(`Compare “${baseName(left)}” with…`, left);
  }
  if (!left || !right) {
    return;
  }
  await openCompare(fileSource(left), fileSource(right));
}

const GIT_SCHEME = 'git';

// Short name of the version a URI of the git extension refers to.
function gitVersion(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== GIT_SCHEME) {
    return undefined;
  }
  try {
    const { ref } = JSON.parse(uri.query) as { ref?: string };
    if (ref === '') {
      return 'Index';
    }
    // '~' is the index or, if the file is not staged, HEAD.
    if (!ref || ref === '~') {
      return 'Git';
    }
    return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref;
  } catch {
    return 'Git';
  }
}

function fileSource(uri: vscode.Uri): CompareSource {
  const version = gitVersion(uri);
  return {
    name: baseName(uri) + (version ? ` (${version})` : ''),
    description: vscode.workspace.asRelativePath(uri),
    uri,
  };
}

// A comparison is opened as a custom editor on a virtual document. Having a
// URI of its own lets the differences be reported as diagnostics ("Problems").
const COMPARE_SCHEME = 'pdf-compare';

interface Comparison {
  left: CompareSource;
  right: CompareSource;
}

/** Comparisons opened in this session, by id; needed for sources that only exist in memory. */
const comparisons = new Map<string, Comparison>();

function openCompare(
  left: CompareSource,
  right: CompareSource,
  options: vscode.TextDocumentShowOptions = {},
): Thenable<unknown> {
  const id = crypto.randomUUID();
  comparisons.set(id, { left, right });
  const uri = vscode.Uri.from({
    scheme: COMPARE_SCHEME,
    path: `/${left.name} ↔ ${right.name}.pdfdiff`.replace(/(?!^)\//g, '∕'),
    // The file URIs allow restoring the comparison after a restart.
    query: JSON.stringify({ id, left: left.uri?.toString(), right: right.uri?.toString() }),
  });
  return vscode.commands.executeCommand(
    'vscode.openWith',
    uri,
    CompareEditorProvider.viewType,
    options,
  );
}

class CompareDocument implements vscode.CustomDocument {
  readonly id?: string;
  readonly comparison?: Comparison;

  constructor(readonly uri: vscode.Uri) {
    try {
      const query = JSON.parse(uri.query) as { id?: string; left?: string; right?: string };
      this.id = query.id;
      this.comparison =
        comparisons.get(query.id ?? '') ??
        (query.left && query.right
          ? {
              left: fileSource(vscode.Uri.parse(query.left)),
              right: fileSource(vscode.Uri.parse(query.right)),
            }
          : undefined);
    } catch {
      // not a URI created by openCompare
    }
  }

  dispose(): void {
    comparisons.delete(this.id ?? '');
  }
}

interface DifferenceInfo {
  page: number;
  /** Set if the page exists in only one of the documents. */
  only?: 'left' | 'right';
}

class CompareEditorProvider implements vscode.CustomReadonlyEditorProvider<CompareDocument> {
  static readonly viewType = 'pdfViewer.compare';

  readonly differences = vscode.languages.createDiagnosticCollection('pdfViewer.differences');
  private readonly panels = new Set<vscode.WebviewPanel>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): CompareDocument {
    return new CompareDocument(uri);
  }

  resolveCustomEditor(document: CompareDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    webview.options = webviewOptions(this.extensionUri);
    const comparison = document.comparison;
    if (!comparison) {
      // E.g. a tab restored after a restart whose earlier version only existed in memory.
      setTimeout(() => panel.dispose());
      return;
    }

    const send = (side: 'left' | 'right'): Promise<void> => {
      const { data, uri } = comparison[side];
      return sendPdf(webview, () => data ?? readPdf(uri!), { side });
    };
    // The tab closes itself when one of the files is gone.
    const closeIfFileMissing = async (): Promise<void> => {
      for (const { uri } of [comparison.left, comparison.right]) {
        try {
          await (uri && vscode.workspace.fs.stat(uri));
        } catch {
          panel.dispose();
          return;
        }
      }
    };
    let deleteTimer: NodeJS.Timeout | undefined;
    const disposables: vscode.Disposable[] = [
      webview.onDidReceiveMessage((msg: { type: string; items?: DifferenceInfo[] }) => {
        if (msg.type === 'ready') {
          void send('left');
          void send('right');
        } else if (msg.type === 'differences') {
          this.differences.set(document.uri, this.toDiagnostics(comparison, msg.items ?? []));
        }
      }),
      new vscode.Disposable(() => clearTimeout(deleteTimer)),
    ];
    for (const side of ['left', 'right'] as const) {
      const { uri } = comparison[side];
      if (uri) {
        disposables.push(
          watchFile(
            uri,
            () => void send(side),
            // Builds often delete a PDF and write it again; only close if it stays away.
            () => {
              clearTimeout(deleteTimer);
              deleteTimer = setTimeout(() => void closeIfFileMissing(), FILE_GONE_DELAY);
            },
          ),
        );
      }
    }
    this.panels.add(panel);
    panel.onDidDispose(() => {
      this.panels.delete(panel);
      this.differences.delete(document.uri);
      disposables.forEach((d) => d.dispose());
    });

    webview.html = buildHtml(
      webview,
      this.extensionUri,
      'compare.js',
      compareBody(documentToggle('left', comparison.left), documentToggle('right', comparison.right)),
    );
    void closeIfFileMissing();
  }

  // The page number is used as line number, so that the Problems view shows and sorts by it.
  private toDiagnostics(comparison: Comparison, items: DifferenceInfo[]): vscode.Diagnostic[] {
    let indexOnPage = 0;
    return items.map((item, i) => {
      indexOnPage = i > 0 && items[i - 1].page === item.page ? indexOnPage + 1 : 0;
      const position = new vscode.Position(item.page - 1, indexOnPage);
      const message = item.only
        ? `Page ${item.page} exists only in “${comparison[item.only].name}”`
        : `Difference on page ${item.page}`;
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(position, position),
        message,
        vscode.DiagnosticSeverity.Information,
      );
      diagnostic.source = 'PDF comparison';
      return diagnostic;
    });
  }

  /** Jumps to the next (1) or previous (-1) difference in the active comparison. */
  goToDifference(direction: 1 | -1): void {
    const panels = [...this.panels];
    const panel = panels.find((p) => p.active) ?? panels.find((p) => p.visible);
    void panel?.webview.postMessage({ type: 'goToDiff', direction });
  }
}

// Backs the virtual documents of comparisons; they have no content of their own.
class CompareFileSystem implements vscode.FileSystemProvider {
  readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;

  stat(): vscode.FileStat {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
  }
  readFile(): Uint8Array {
    return new Uint8Array();
  }
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
}

// Toolbar button that shows/hides one of the two documents; doubles as colour legend.
function documentToggle(side: 'left' | 'right', source: CompareSource): string {
  const id = side === 'left' ? 'showLeft' : 'showRight';
  const title = `Show / hide the ${side === 'left' ? 'first' : 'second'} file: ${source.description}`;
  return /* html */ `
    <button id="${id}" class="documentToggle" title="${escapeHtml(title)}" aria-pressed="true">
      <span class="swatch ${side}"></span><span class="documentName">${escapeHtml(source.name)}</span>
    </button>`;
}

function activePdfUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (
    (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) &&
    isPdf(input.uri)
  ) {
    return input.uri;
  }
  return undefined;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'media'),
      vscode.Uri.joinPath(extensionUri, 'node_modules', 'pdfjs-dist'),
    ],
  };
}

function buildHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  script: string,
  body: string,
): string {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
  const pdfjsRoot = vscode.Uri.joinPath(extensionUri, 'node_modules', 'pdfjs-dist');
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (root: vscode.Uri, ...segments: string[]): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(root, ...segments)).toString();

  const config = {
    pdfjs: uri(pdfjsRoot, 'legacy', 'build', 'pdf.mjs'),
    worker: uri(pdfjsRoot, 'legacy', 'build', 'pdf.worker.mjs'),
    viewer: uri(pdfjsRoot, 'legacy', 'web', 'pdf_viewer.mjs'),
    cMapUrl: uri(pdfjsRoot, 'cmaps') + '/',
    standardFontDataUrl: uri(pdfjsRoot, 'standard_fonts') + '/',
    wasmUrl: uri(pdfjsRoot, 'wasm') + '/',
    iccUrl: uri(pdfjsRoot, 'iccs') + '/',
  };

  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource} blob: 'wasm-unsafe-eval'`,
    `worker-src blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource} data: blob:`,
    `connect-src ${webview.cspSource} blob:`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${uri(pdfjsRoot, 'legacy', 'web', 'pdf_viewer.css')}">
  <link rel="stylesheet" href="${uri(mediaRoot, 'viewer.css')}">
</head>
<body>
${body}
  <div id="message" hidden></div>
  <script nonce="${nonce}" type="application/json" id="config">${JSON.stringify(config)}</script>
  <script nonce="${nonce}" type="module" src="${uri(mediaRoot, script)}"></script>
</body>
</html>`;
}

// Toolbar controls shared by the single viewer and the compare view.
const NAVIGATION_CONTROLS = /* html */ `
    <button id="prev" title="Previous page">&#x2039;</button>
    <button id="next" title="Next page">&#x203A;</button>
    <input id="pageNumber" type="number" min="1" value="1" title="Page">
    <span id="pageCount">/ –</span>`;

const ZOOM_CONTROLS = /* html */ `
    <button id="zoomOut" title="Zoom out">&minus;</button>
    <button id="zoomIn" title="Zoom in">+</button>
    <select id="scale" title="Zoom">
      <option value="auto">Automatic</option>
      <option value="page-width">Page width</option>
      <option value="page-fit">Whole page</option>
      <option value="0.5">50 %</option>
      <option value="0.75">75 %</option>
      <option value="1">100 %</option>
      <option value="1.5">150 %</option>
      <option value="2">200 %</option>
      <option value="4">400 %</option>
      <option id="customScale" value="custom" hidden></option>
    </select>
    <button id="rotateLeft" title="Rotate left">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9a9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
    </button>
    <button id="rotateRight" title="Rotate right">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
    </button>`;

const TOOL_CONTROLS = /* html */ `
    <button id="toolSelect" title="Text selection" aria-pressed="true">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h3a1 1 0 0 1 1 1a1 1 0 0 1 1-1h3M8 20h3a1 1 0 0 0 1-1a1 1 0 0 0 1 1h3M12 5v14M10 12h4"/></svg>
    </button>
    <button id="toolHand" title="Drag the page with the mouse" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>
    </button>`;

const VIEWER_BODY = /* html */ `
  <div id="toolbar">${NAVIGATION_CONTROLS}
    <span class="spacer"></span>${ZOOM_CONTROLS}
    <span class="separator"></span>${TOOL_CONTROLS}
    <span class="separator"></span>
    <button id="comparePrevious" title="Compare with the version before the last reload (no earlier version yet)" disabled>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9a9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
    </button>
    <span class="spacer"></span>
    <input id="findInput" type="search" placeholder="Find (Ctrl+F)">
    <button id="findPrev" title="Previous match">&#x2191;</button>
    <button id="findNext" title="Next match">&#x2193;</button>
    <span id="findCount"></span>
  </div>
  <div id="viewerContainer" tabindex="0">
    <div id="viewer" class="pdfViewer"></div>
  </div>`;

const compareBody = (leftToggle: string, rightToggle: string): string => /* html */ `
  <div id="toolbar">${NAVIGATION_CONTROLS}
    <span class="spacer"></span>${ZOOM_CONTROLS}
    <span class="separator"></span>${TOOL_CONTROLS}
    <span class="spacer"></span>${leftToggle}${rightToggle}
    <span class="separator"></span>
    <button id="diffToggle" title="Highlight differences" aria-pressed="true">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
    </button>
    <button id="diffPrev" title="Previous difference (Shift+F8)">&#x2191;</button>
    <button id="diffNext" title="Next difference (F8)">&#x2193;</button>
    <span id="diffStatus"></span>
  </div>
  <div id="viewerContainer" tabindex="0">
    <div id="viewer" class="pdfViewer"></div>
  </div>`;
