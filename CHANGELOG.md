# Changelog

All notable changes to this extension are documented in this file.

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
