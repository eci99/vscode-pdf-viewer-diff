# Changelog

All notable changes to this extension are documented in this file.

## 0.1.1 – 2026-10-12

- Renamed to "PDF View & Compare"; the commands are now listed under that name in the Command Palette.
- The hand tool (drag the page with the mouse) is now the default instead of text selection.
- Reloading a changed PDF keeps the horizontal scroll position too, in the viewer and in the comparison.

## 0.1.0 – 2026-10-10

First version.

### Viewer

- Opens `*.pdf` files in a custom editor, rendered by pdf.js.
- Page navigation, zoom, rotation, text selection and a hand tool.
- Full-text search and clickable links.
- Reloads automatically when the file changes on disk; page, zoom and rotation are kept.
- Works with remote and virtual file systems.

### Comparison

- Visual comparison of two PDFs: differing areas are highlighted, with the first file in red and the second in green.
- Started from the Explorer, from an open PDF, or against the version shown before the last reload.
- Replaces the diff editor of VS Code for PDFs, e.g. for changes in the Source Control view.
- Jumping between differences with the toolbar, `F8` / `Shift`+`F8` or commands; differences are listed in the Problems view.
- Updates when one of the files changes on disk.
