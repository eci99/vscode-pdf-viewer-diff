import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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
    vscode.commands.registerCommand('pdfViewer.acceptCurrent', () => compareProvider.acceptMerge('left')),
    vscode.commands.registerCommand('pdfViewer.acceptIncoming', () => compareProvider.acceptMerge('right')),
    ...registerDropZone(),
    ...registerMergeReplacement((side, result) => compareProvider.acceptMerge(side, result)),
  );
}

export function deactivate(): void {}

const isPdf = (uri: vscode.Uri): boolean => uri.path.toLowerCase().endsWith('.pdf');
const baseName = (uri: vscode.Uri): string => uri.path.split('/').pop()!;

// A version from git of a file that is stored in Git LFS is only the small pointer file.
const LFS_POINTER = 'version https://git-lfs.github.com/spec/';

async function resolveLfsPointer(uri: vscode.Uri, bytes: Uint8Array): Promise<Uint8Array> {
  const pointer = Buffer.from(bytes).toString('utf8');
  if (bytes.length > 1024 || !pointer.startsWith(LFS_POINTER)) {
    return bytes;
  }
  const cwd = path.dirname(uri.fsPath);
  const stored = await readLfsObject(cwd, pointer);
  if (stored) {
    return stored;
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['lfs', 'smudge'],
      { cwd, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
      (err, stdout) =>
        err
          ? reject(
              new Error(
                `The file is stored in Git LFS and git lfs smudge failed: ${err.message.trim()} ` +
                  `Is Git LFS installed where VS Code runs its extensions (e.g. in WSL)?`,
              ),
            )
          : resolve(stdout),
    );
    child.stdin?.end(Buffer.from(bytes));
  });
}

// The content of an LFS file is usually in the local LFS store of the repository already,
// e.g. because the file is checked out. Reading it from there does not need Git LFS, which
// may be missing, e.g. in WSL when the repository was cloned with Git for Windows.
async function readLfsObject(cwd: string, pointer: string): Promise<Uint8Array | undefined> {
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(pointer)?.[1];
  if (!oid) {
    return undefined;
  }
  try {
    const gitDir = await new Promise<string>((resolve, reject) =>
      execFile('git', ['rev-parse', '--git-common-dir'], { cwd }, (err, stdout) =>
        err ? reject(err) : resolve(path.resolve(cwd, stdout.trim())),
      ),
    );
    const data = await fs.promises.readFile(
      path.join(gitDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid),
    );
    return crypto.createHash('sha256').update(data).digest('hex') === oid ? data : undefined;
  } catch {
    return undefined;
  }
}

// The file is read through workspace.fs so that remote and virtual
// file systems (SSH, WSL, git: URIs, ...) work as well.
async function readPdf(uri: vscode.Uri): Promise<ArrayBuffer> {
  let bytes = await vscode.workspace.fs.readFile(uri);
  if (uri.scheme === GIT_SCHEME) {
    bytes = await resolveLfsPointer(uri, bytes);
  }
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

// At most this many PDFs of the workspace are offered when picking a file to compare.
const MAX_PICKED_PDFS = 2000;

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
    }, `compare: ${baseName(modified)} (git)`).then(
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
        } else if (msg.type === 'compare') {
          void comparePdfs(document.uri);
        } else if (msg.type === 'comparePrevious' && document.previous) {
          const name = baseName(document.uri);
          void openCompare(
            {
              name: `${name} (before)`,
              description: 'Version before the last reload',
              data: document.previous,
            },
            { name, description: vscode.workspace.asRelativePath(document.uri), uri: document.uri },
            {},
            `compare: ${name} (before)`,
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
    const browse = async (): Promise<vscode.Uri | undefined> => {
      const picked = await vscode.window.showOpenDialog({
        title,
        openLabel: 'Select',
        canSelectMany: false,
        filters: { PDF: ['pdf'] },
        defaultUri: near && vscode.Uri.joinPath(near, '..'),
      });
      return picked?.[0];
    };
    // The PDFs of the workspace are offered in VS Code itself: the system's file dialog may
    // open behind the VS Code window (seen with KDE on Wayland), so that nothing seems to happen.
    const pdfs = vscode.workspace.workspaceFolders
      ? (await vscode.workspace.findFiles('**/*.pdf', undefined, MAX_PICKED_PDFS)).filter(
          (uri) => uri.toString() !== near?.toString(),
        )
      : [];
    if (pdfs.length === 0) {
      return browse();
    }
    const folder = near && vscode.Uri.joinPath(near, '..').toString();
    const inFolder = (uri: vscode.Uri): number => (vscode.Uri.joinPath(uri, '..').toString() === folder ? 0 : 1);
    pdfs.sort(
      (a, b) =>
        inFolder(a) - inFolder(b) ||
        vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)),
    );
    type Item = vscode.QuickPickItem & { uri?: vscode.Uri };
    const items: Item[] = [
      { label: '$(folder-opened) Browse…', description: 'Choose a file with the file dialog' },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...pdfs.map((uri) => {
        const relative = vscode.workspace.asRelativePath(uri);
        const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
        return { label: `$(file-pdf) ${baseName(uri)}`, description: dir, uri };
      }),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Select a PDF of the workspace, or browse for one',
      matchOnDescription: true,
    });
    return picked && (picked.uri ?? (await browse()));
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

// "PDF Compare" in the Explorer: a PDF dropped on it is compared with the PDF shown. Webviews
// cannot take drops from the Explorer (VS Code opens the file instead), a tree view can.
const DROP_ZONE_VIEW = 'pdfViewer.dropZone';
const URI_LIST = 'text/uri-list';

class DropZone implements vscode.TreeDataProvider<string>, vscode.TreeDragAndDropController<string> {
  readonly dropMimeTypes = [URI_LIST];
  readonly dragMimeTypes = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  /** The PDF last shown in the active editor; dropped files are compared with it. */
  shown?: vscode.Uri;

  /** Follows the active editor; forgets the PDF once it is closed. */
  update(open: vscode.Uri[]): void {
    let shown = activePdfUri() ?? this.shown;
    if (shown && !open.some((uri) => uri.toString() === shown!.toString())) {
      shown = undefined;
    }
    if (shown?.toString() !== this.shown?.toString()) {
      this.shown = shown;
      this.changed.fire();
    }
  }

  getChildren(element?: string): string[] {
    return element ? [] : ['drop'];
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Drop a PDF here');
    item.iconPath = new vscode.ThemeIcon('diff');
    item.description = this.shown ? `to compare it with ${baseName(this.shown)}` : 'to compare it';
    item.tooltip = this.shown
      ? `Drop a PDF from the Explorer here to compare it with ${baseName(this.shown)}. Two dropped PDFs are compared with each other. Click to pick a file instead.`
      : 'Drop two PDFs from the Explorer here to compare them, or one to pick the second. Click to pick the files instead.';
    item.command = { command: 'pdfViewer.compare', title: 'Compare PDF with…', arguments: [this.shown] };
    return item;
  }

  async handleDrop(_target: string | undefined, data: vscode.DataTransfer): Promise<void> {
    const list = (await data.get(URI_LIST)?.asString()) ?? '';
    const pdfs = list
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => vscode.Uri.parse(line))
      .filter(isPdf);
    if (pdfs.length >= 2) {
      await openCompare(fileSource(pdfs[0]), fileSource(pdfs[1]));
    } else if (pdfs.length === 1 && this.shown && this.shown.toString() !== pdfs[0].toString()) {
      await openCompare(fileSource(this.shown), fileSource(pdfs[0]));
    } else if (pdfs.length === 1) {
      await comparePdfs(pdfs[0]);
    } else {
      void vscode.window.showInformationMessage('Only PDF files can be compared.');
    }
  }
}

function registerDropZone(): vscode.Disposable[] {
  const dropZone = new DropZone();
  // The view is shown while a PDF or a comparison is open.
  const update = (): void => {
    const inputs = vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.input));
    const custom = inputs.filter((input) => input instanceof vscode.TabInputCustom);
    dropZone.update(custom.filter((input) => input.viewType === PdfEditorProvider.viewType).map((input) => input.uri));
    const open = custom.some(
      (input) =>
        input.viewType === PdfEditorProvider.viewType || input.viewType === CompareEditorProvider.viewType,
    );
    void vscode.commands.executeCommand('setContext', 'pdfViewer.pdfOpen', open);
  };
  update();
  return [
    vscode.window.createTreeView(DROP_ZONE_VIEW, { treeDataProvider: dropZone, dragAndDropController: dropZone }),
    vscode.window.tabGroups.onDidChangeTabs(update),
    vscode.window.tabGroups.onDidChangeTabGroups(update),
  ];
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
  /** Replaces the default tab title. */
  title?: string;
  /** Set if the comparison replaces a merge editor: the file that gets the chosen version. */
  merge?: vscode.Uri;
}

/** Comparisons opened in this session, by id; needed for sources that only exist in memory. */
const comparisons = new Map<string, Comparison>();
/** Reloads the documents of an open comparison, by id. */
const refreshers = new Map<string, () => void>();

function openCompare(
  left: CompareSource,
  right: CompareSource,
  options: vscode.TextDocumentShowOptions = {},
  title?: string,
  merge?: vscode.Uri,
): Thenable<unknown> {
  // The same two files give the same URI, so an open comparison of them is shown again.
  // The same goes for a file and its previous version, which then gets the newer snapshot.
  const id =
    left.uri && right.uri && !left.data && !right.data
      ? `${left.uri}|${right.uri}|${title ?? ''}`
      : left.data && right.uri && !right.data
        ? `${right.uri}|previous`
        : crypto.randomUUID();
  const existing = comparisons.get(id);
  if (existing) {
    Object.assign(existing, { left, right, title, merge });
    refreshers.get(id)?.();
  } else {
    comparisons.set(id, { left, right, title, merge });
  }
  const label = title ?? `compare: ${left.name} \u2194 ${right.name}`;
  const uri = vscode.Uri.from({
    scheme: COMPARE_SCHEME,
    // A custom editor tab is named after the last segment of the path.
    path: `/${label}`.replace(/(?!^)\//g, '\u2215'),
    // The file URIs allow restoring the comparison after a restart.
    query: JSON.stringify({
      id,
      left: left.uri?.toString(),
      right: right.uri?.toString(),
      title,
      merge: merge?.toString(),
    }),
  });
  // An open comparison is shown where it is, also if it is in another editor group.
  const open = vscode.window.tabGroups.all.find((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === CompareEditorProvider.viewType &&
        tab.input.uri.toString() === uri.toString(),
    ),
  );
  return vscode.commands.executeCommand(
    'vscode.openWith',
    uri,
    CompareEditorProvider.viewType,
    open ? { ...options, viewColumn: open.viewColumn } : options,
  );
}

class CompareDocument implements vscode.CustomDocument {
  readonly id?: string;
  readonly comparison?: Comparison;

  constructor(readonly uri: vscode.Uri) {
    try {
      const query = JSON.parse(uri.query) as {
        id?: string;
        left?: string;
        right?: string;
        title?: string;
        merge?: string;
      };
      this.id = query.id;
      this.comparison =
        comparisons.get(query.id ?? '') ??
        (query.left && query.right
          ? {
              left: fileSource(vscode.Uri.parse(query.left)),
              right: fileSource(vscode.Uri.parse(query.right)),
              title: query.title,
              merge: query.merge ? vscode.Uri.parse(query.merge) : undefined,
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
  /** Page in the first document, or in the second if the first does not have it. */
  page: number;
  /** Page in the second document if it is not the same; side by side, pages can be compared with an offset. */
  otherPage?: number;
  /** Set if the page exists in only one of the documents. */
  only?: 'left' | 'right';
}

class CompareEditorProvider implements vscode.CustomReadonlyEditorProvider<CompareDocument> {
  static readonly viewType = 'pdfViewer.compare';

  readonly differences = vscode.languages.createDiagnosticCollection('pdfViewer.differences');
  private readonly panels = new Map<vscode.WebviewPanel, Comparison>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): CompareDocument {
    return new CompareDocument(uri);
  }

  resolveCustomEditor(document: CompareDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    webview.options = webviewOptions(this.extensionUri);
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'images', 'icon.svg');
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
    this.panels.set(panel, comparison);
    // The buttons to accept a version are shown while a comparison that replaces a merge editor is active.
    const updateContext = (): void => {
      if (panel.active) {
        void vscode.commands.executeCommand('setContext', MERGE_CONTEXT, !!comparison.merge);
      }
    };
    updateContext();
    disposables.push(panel.onDidChangeViewState(updateContext));
    if (document.id) {
      refreshers.set(document.id, () => {
        void send('left');
        void send('right');
      });
    }
    panel.onDidDispose(() => {
      this.panels.delete(panel);
      if (![...this.panels.keys()].some((p) => p.active)) {
        void vscode.commands.executeCommand('setContext', MERGE_CONTEXT, false);
      }
      if (document.id) {
        refreshers.delete(document.id);
      }
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
        : item.otherPage
          ? `Difference on page ${item.page} of “${comparison.left.name}” and page ${item.otherPage} of “${comparison.right.name}”`
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

  private activePanel(): vscode.WebviewPanel | undefined {
    const panels = [...this.panels.keys()];
    return panels.find((p) => p.active) ?? panels.find((p) => p.visible);
  }

  /** Jumps to the next (1) or previous (-1) difference in the active comparison. */
  goToDifference(direction: 1 | -1): void {
    void this.activePanel()?.webview.postMessage({ type: 'goToDiff', direction });
  }

  /**
   * Writes one side of a merge comparison to the merged file and closes the comparison.
   * Without the merged file, the active comparison is meant.
   */
  async acceptMerge(side: 'left' | 'right', mergedFile?: vscode.Uri): Promise<void> {
    const panel = mergedFile
      ? [...this.panels].find(([, c]) => c.merge?.toString() === mergedFile.toString())?.[0]
      : this.activePanel();
    const comparison = panel && this.panels.get(panel);
    const result = comparison?.merge;
    if (!panel || !comparison || !result) {
      return;
    }
    const { data, uri, name } = comparison[side];
    try {
      await vscode.workspace.fs.writeFile(result, new Uint8Array(data ?? (await readPdf(uri!))));
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not write ${baseName(result)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    panel.dispose();
    // Closing the merged file as well ends a waiting `git mergetool`.
    const tabs = vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter(
        (tab) =>
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.viewType === PdfEditorProvider.viewType &&
          tab.input.uri.toString() === result.toString(),
      ),
    );
    await vscode.window.tabGroups.close(tabs).then(undefined, () => {});
    const fromGit = comparison.left.uri?.scheme === GIT_SCHEME || comparison.right.uri?.scheme === GIT_SCHEME;
    void vscode.window.showInformationMessage(
      `${baseName(result)}: “${name}” was kept.` +
        (fromGit ? ' Stage the file to mark the conflict as resolved.' : ''),
    );
  }
}

const MERGE_CONTEXT = 'pdfViewer.mergeActive';
const ACCEPT_CURRENT = 'Accept Current';
const ACCEPT_INCOMING = 'Accept Incoming';

// The input of a merge editor tab. The API does not declare it (it is "unknown"),
// but the object has these URIs.
interface MergeInput {
  input1: vscode.Uri;
  input2: vscode.Uri;
  result: vscode.Uri;
}

function pdfMergeInput(input: unknown): MergeInput | undefined {
  const merge = input as Partial<MergeInput> | undefined;
  return merge &&
    merge.input1 instanceof vscode.Uri &&
    merge.input2 instanceof vscode.Uri &&
    merge.result instanceof vscode.Uri &&
    isPdf(merge.result)
    ? (merge as MergeInput)
    : undefined;
}

// The merge editor of VS Code (`git mergetool` with `code --merge`, "Resolve in Merge Editor")
// only handles text and shows nothing useful for a PDF. It is replaced by a comparison of
// the two versions, in which one of them can be accepted.
function registerMergeReplacement(
  acceptMerge: (side: 'left' | 'right', result: vscode.Uri) => Promise<void>,
): vscode.Disposable[] {
  const replacing = new Set<string>();
  const replace = async (tab: vscode.Tab, merge: MergeInput): Promise<void> => {
    const key = merge.result.toString();
    if (replacing.has(key)) {
      return;
    }
    replacing.add(key);
    try {
      const viewColumn = tab.group.viewColumn;
      const name = baseName(merge.result);
      const source = (uri: vscode.Uri, version: string): CompareSource => ({
        name: `${name} (${version})`,
        description: vscode.workspace.asRelativePath(uri),
        uri,
      });
      // `code --wait` returns once no editor shows the merged file any more, so it is opened
      // before the merge editor is closed; it also shows the current content of the file.
      await vscode.commands.executeCommand('vscode.openWith', merge.result, PdfEditorProvider.viewType, {
        viewColumn,
        preview: false,
        preserveFocus: true,
      });
      await openCompare(
        source(merge.input1, 'current'),
        source(merge.input2, 'incoming'),
        { viewColumn, preview: false },
        `merge: ${name}`,
        merge.result,
      );
      await vscode.window.tabGroups.close(tab).then(undefined, () => {});
    } finally {
      replacing.delete(key);
    }
    const choice = await vscode.window.showInformationMessage(
      `Merge of ${baseName(merge.result)}: choose the version to keep.`,
      ACCEPT_CURRENT,
      ACCEPT_INCOMING,
    );
    if (choice) {
      await acceptMerge(choice === ACCEPT_CURRENT ? 'left' : 'right', merge.result);
    }
  };
  const check = (tabs: readonly vscode.Tab[]): void => {
    for (const tab of tabs) {
      const merge = pdfMergeInput(tab.input);
      if (merge) {
        void replace(tab, merge);
      }
    }
  };
  // The extension may only be activated after the merge editor was opened.
  check(vscode.window.tabGroups.all.flatMap((group) => group.tabs));
  return [vscode.window.tabGroups.onDidChangeTabs((e) => check([...e.opened, ...e.changed]))];
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
const RESET_VIEW_BUTTON = /* html */ `
    <button id="resetView" title="Back to the start with automatic zoom">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/></svg>
    </button>`;

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
    <button id="toolSelect" title="Text selection (hold Ctrl to drag instead)" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h3a1 1 0 0 1 1 1a1 1 0 0 1 1-1h3M8 20h3a1 1 0 0 0 1-1a1 1 0 0 0 1 1h3M12 5v14M10 12h4"/></svg>
    </button>
    <button id="toolHand" title="Drag the page with the mouse (hold Ctrl to select text instead)" aria-pressed="true">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>
    </button>`;

const FIND_CONTROLS = /* html */ `
    <input id="findInput" type="search" placeholder="Find (Ctrl+F)">
    <button id="findPrev" title="Previous match">&#x2191;</button>
    <button id="findNext" title="Next match">&#x2193;</button>
    <span id="findCount"></span>`;

// The button shows the row with the find controls, which is the last row of the toolbar.
const FIND_TOGGLE = /* html */ `
    <button id="findToggle" title="Find (Ctrl+F)" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    </button>`;
const FIND_ROW = /* html */ `
    <div id="findRow" class="findRow" hidden>${FIND_CONTROLS}</div>`;

const VIEWER_BODY = /* html */ `
  <div id="toolbar">
    <div class="group">${RESET_VIEW_BUTTON}${NAVIGATION_CONTROLS}</div>
    <span class="spacer"></span>
    <div class="group">${ZOOM_CONTROLS}
    <span class="separator"></span>${TOOL_CONTROLS}</div>
    <div class="group">
    <button id="compareWith" title="Compare with…">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/><path d="M10 9h4"/><path d="M10 15h4"/></svg>
    </button>
    <button id="comparePrevious" title="Compare with the version before the last reload (no earlier version yet)" disabled>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9a9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
    </button></div>${FIND_TOGGLE}${FIND_ROW}
  </div>
  <div id="viewerContainer" tabindex="0">
    <div id="viewer" class="pdfViewer"></div>
  </div>`;

const compareBody = (leftToggle: string, rightToggle: string): string => /* html */ `
  <div id="toolbar">
    <div class="group">${RESET_VIEW_BUTTON}${NAVIGATION_CONTROLS}</div>
    <span class="spacer"></span>
    <div class="group">${ZOOM_CONTROLS}
    <span class="separator"></span>${TOOL_CONTROLS}</div>
    <span class="spacer"></span>
    <div class="group">${leftToggle}${rightToggle}
    <span class="separator"></span>
    <button id="sideBySide" title="Side by side" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/></svg>
    </button>
    <button id="scrollLock" title="Scroll both sides together" aria-pressed="true" disabled>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
    </button>
    <span class="separator"></span>
    <button id="textDiff" title="Compare the text instead of the appearance" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
    </button>
    <button id="diffToggle" title="Highlight differences" aria-pressed="true">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 11-6 6v3h9l3-3" stroke="#f5c400" fill="#f5c400"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
    </button>
    <button id="diffPrev" title="Previous difference (Shift+F8)">&#x2191;</button>
    <button id="diffNext" title="Next difference (F8)">&#x2193;</button>
    <span id="diffStatus"></span></div>${FIND_TOGGLE}${FIND_ROW}
  </div>
  <div id="viewerContainer" tabindex="0">
    <div id="viewer" class="pdfViewer"></div>
  </div>
  <div id="secondContainer" tabindex="0">
    <div id="secondViewer" class="pdfViewer"></div>
  </div>`;
