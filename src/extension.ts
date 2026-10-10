import * as crypto from 'crypto';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      PdfEditorProvider.viewType,
      new PdfEditorProvider(context.extensionUri),
      {
        supportsMultipleEditorsPerDocument: true,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );
}

export function deactivate(): void {}

class PdfDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  static readonly viewType = 'pdfViewer.preview';

  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): PdfDocument {
    return new PdfDocument(uri);
  }

  resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const pdfjsRoot = vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'pdfjs-dist');

    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, pdfjsRoot],
    };

    // The file is read through workspace.fs so that remote and virtual
    // file systems (SSH, WSL, git: URIs, ...) work as well.
    const sendDocument = async (): Promise<void> => {
      try {
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        // readFile may return a Node Buffer, which postMessage would serialize
        // as JSON; a plain ArrayBuffer is transferred as binary.
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        await webview.postMessage({ type: 'load', data });
      } catch (err) {
        await webview.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const disposables: vscode.Disposable[] = [];

    webview.onDidReceiveMessage(
      (msg: { type: string }) => {
        if (msg.type === 'ready') {
          void sendDocument();
        }
      },
      undefined,
      disposables,
    );

    // Reload when the file changes on disk (e.g. after a LaTeX build).
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.joinPath(document.uri, '..'),
        document.uri.path.split('/').pop()!,
      ),
    );
    let reloadTimer: NodeJS.Timeout | undefined;
    const scheduleReload = (): void => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void sendDocument(), 300);
    };
    watcher.onDidChange(scheduleReload, undefined, disposables);
    watcher.onDidCreate(scheduleReload, undefined, disposables);
    disposables.push(watcher);

    panel.onDidDispose(() => {
      clearTimeout(reloadTimer);
      disposables.forEach((d) => d.dispose());
    });

    webview.html = this.getHtml(webview, mediaRoot, pdfjsRoot);
  }

  private getHtml(webview: vscode.Webview, mediaRoot: vscode.Uri, pdfjsRoot: vscode.Uri): string {
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
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${uri(pdfjsRoot, 'legacy', 'web', 'pdf_viewer.css')}">
  <link rel="stylesheet" href="${uri(mediaRoot, 'viewer.css')}">
</head>
<body>
  <div id="toolbar">
    <button id="prev" title="Vorherige Seite">&#x2039;</button>
    <button id="next" title="Nächste Seite">&#x203A;</button>
    <input id="pageNumber" type="number" min="1" value="1" title="Seite">
    <span id="pageCount">/ –</span>
    <span class="spacer"></span>
    <button id="zoomOut" title="Verkleinern">&minus;</button>
    <button id="zoomIn" title="Vergrößern">+</button>
    <select id="scale" title="Zoom">
      <option value="auto">Automatisch</option>
      <option value="page-width">Seitenbreite</option>
      <option value="page-fit">Ganze Seite</option>
      <option value="0.5">50 %</option>
      <option value="0.75">75 %</option>
      <option value="1">100 %</option>
      <option value="1.5">150 %</option>
      <option value="2">200 %</option>
      <option value="4">400 %</option>
      <option id="customScale" value="custom" hidden></option>
    </select>
    <span class="separator"></span>
    <button id="toolSelect" title="Textauswahl" aria-pressed="true">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h3a1 1 0 0 1 1 1a1 1 0 0 1 1-1h3M8 20h3a1 1 0 0 0 1-1a1 1 0 0 0 1 1h3M12 5v14M10 12h4"/></svg>
    </button>
    <button id="toolHand" title="Seite mit der Maus verschieben" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>
    </button>
    <span class="spacer"></span>
    <input id="findInput" type="search" placeholder="Suchen (Strg+F)">
    <button id="findPrev" title="Vorheriger Treffer">&#x2191;</button>
    <button id="findNext" title="Nächster Treffer">&#x2193;</button>
    <span id="findCount"></span>
  </div>
  <div id="viewerContainer" tabindex="0">
    <div id="viewer" class="pdfViewer"></div>
  </div>
  <div id="message" hidden></div>
  <script nonce="${nonce}" type="application/json" id="config">${JSON.stringify(config)}</script>
  <script nonce="${nonce}" type="module" src="${uri(mediaRoot, 'viewer.js')}"></script>
</body>
</html>`;
  }
}
