# Changelog

All notable changes to this extension are documented in this file.

## 0.1.4 – 2026-10-21

- Compare button in the toolbar of the viewer: compares the PDF shown with another file.
- **PDF Compare** view in the Explorer, shown while a PDF is open: a PDF dropped on it is compared with the PDF in the active editor, two dropped PDFs with each other.
- Side-by-side view in the comparison: the two files next to each other in their original colours. The differences (marks, frame and jumping between them) are switched on and off with the highlighter and are off by default in this view.
- Scroll lock for the side-by-side view: both sides scroll and zoom together, page by page, also when the pages have different sizes. It keeps the pages shown when it is switched on next to each other, e.g. page 3 next to page 5, and shows the same part of both pages. Switched off, each side has its own position and zoom. When a file changes on disk, both sides keep their position, with or without the lock.
- Side by side, the scroll lock and the jumps between differences start from the side last scrolled or clicked.
- New toolbar button to compare the text instead of the appearance: only added, removed or changed words are marked.
- Side by side with the scroll lock, the differences are determined for the locked pages, e.g. page 3 with page 5 after two pages were inserted; the Problems view names both page numbers.

## 0.1.3 – 2026-10-16

- Fixed: comparison tabs showed no icon in the installed extension because the icon was left out of the package.
- README: demo GIF of the viewer and a comparison from Source Control, and an author's note.

## 0.1.2 – 2026-10-16

- New toolbar button to go back to the start: page 1, automatic zoom, scrolled to the top left.
- The find controls are now behind a search button (or `Ctrl`+`F`) and get a row of their own; `Escape` closes them and clears the search.
- Text search in the comparison too.
- The toolbar wraps in groups when the editor is narrow.
- Comparison tabs are named `compare: a.pdf ↔ b.pdf` (`… (git)` for a Source Control diff, `… (before)` for the version before the last reload) and show the extension icon.
- Comparing the same files again brings the open comparison to the front, also if it is in another editor group, instead of opening a second one. Comparing with the version before the last reload updates an open comparison of that file.
- The comparison keeps its scroll position when the files change on disk.
- PDFs stored in Git LFS can be compared in the Source Control view: the LFS pointer of the committed version is resolved with `git lfs smudge`.
- Without differences, the buttons for hiding a file, highlighting and jumping between differences are disabled.
- Fixed: after a reload the horizontal scroll position was sometimes lost because it was restored before the pages were laid out.

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
