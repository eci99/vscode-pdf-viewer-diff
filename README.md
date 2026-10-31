# PDF View & Compare

Displays PDF files directly in the editor and compares two PDFs visually. Rendering is done by [pdf.js](https://mozilla.github.io/pdf.js/).

> **Author's note:** You can of course use this extension just to view PDFs, but I designed it
> for developing them: PDFs that are regenerated often, where you keep looking at particular
> places in the document. I also wanted to see what has actually changed, especially before
> committing a PDF. A side-by-side view was not enough for that, because I still had to hunt
> for the differences myself.

![Zooming, paging and searching in a PDF, then comparing it with the committed version from Source Control](images/demo.gif)

## Features

- Opens `*.pdf` files automatically in a custom editor
- Page navigation and zoom: toolbar buttons, `Ctrl`+mouse wheel (zooms around the mouse pointer), `Ctrl`+`+` / `-` / `0`, fit to page width or whole page
- Rotate left / right
- Drag the page with the mouse (hand tool, the default), or switch to text selection; holding `Ctrl` switches to the other tool while it is held
- Back to the start with one button: page 1, automatic zoom, scrolled to the top left
- Full-text search (search button or `Ctrl`+`F`, then `Enter` / `Shift`+`Enter` for the next / previous match, `Escape` to close)
- Clickable links, including jumps within the document
- Reloads automatically when the file changes on disk, e.g. after a LaTeX build; page, zoom and rotation are kept
- Compare the current file with the version shown before the last reload
- Compare any two PDFs (see below)
- Reads files through the VS Code file system API, so remote and virtual file systems work as well

Password-protected PDFs are not supported; an error message is shown instead.

## Comparing PDFs

There are six ways to start a comparison:

- In the Explorer, select two PDF files, right-click and choose **Compare PDF with…**.
- With a PDF open, use the compare button in the viewer toolbar or at the top right of the tab bar, or run the command **PDF View & Compare: Compare PDF with…**, and pick the second file from the PDFs of the workspace (or **Browse…** for any other file).
- Drag a PDF from the Explorer onto **Drop a PDF here** in the **PDF Compare** view of the Explorer (shown while a PDF is open) to compare it with the PDF in the active editor; drop two PDFs to compare them with each other. VS Code does not pass drops on to an editor tab or the viewer itself – it opens the dropped file there instead.
- Open a diff of two PDFs anywhere in VS Code, e.g. by clicking a changed PDF in the **Source Control** view or with **Compare Selected** in the Explorer. The comparison replaces the diff editor, which would only show the two files side by side. PDFs stored in Git LFS work too; the committed version is fetched with `git lfs smudge`, so Git LFS has to be installed.
- Resolve a merge conflict of a PDF in the merge editor, with `git mergetool` (VS Code as merge tool, `code --wait --merge …`) or **Resolve in Merge Editor**. The merge editor only handles text, so it is replaced by a comparison `merge: a.pdf` of the current and the incoming version. **Accept Current** or **Accept Incoming** (in the notification or at the top right of the tab bar) writes that version to the merged file and closes the comparison, which also lets a waiting `git mergetool` continue.
- After an open PDF has been reloaded because it changed on disk, the clock button in the viewer toolbar compares it with the version shown before the reload. That earlier version is kept in memory only.

### What you see

![Comparison of two versions of a PDF](images/compare.png)

The two files are compared page by page (page 1 with page 1, and so on) by rendering both and comparing the pixels. An inserted page therefore makes all following pages show up as different – unless you compare side by side with the scroll lock: then the pages shown next to each other are compared, e.g. page 3 with page 4 after a page was inserted at the start (see below).

Unchanged areas are left exactly as they are. Only where the pages differ are the two versions laid on top of each other:

- content only in the first file is red,
- content only in the second file is green,
- content present in both is black.

Coloured content inside a differing area is tinted too; hide one of the files to see it in its original colours. If the page sizes differ, the pages are aligned at the top left corner, not scaled.

When the comparison opens, it jumps to the first difference. A connected differing area counts as one difference; a page that exists in only one file counts as one difference.

### Toolbar

- **File name buttons** (red / green square): show or hide that file. With only one file visible it is shown in its original colours.
- **Side by side** (split rectangle): show the two files next to each other instead of on top of each other, the first file on the left, the second on the right, both in their original colours. The file name buttons are disabled in this view.
- **Scroll lock** (padlock, side by side only, on by default): the pages shown when the lock is switched on stay next to each other – e.g. page 3 of one file next to page 5 of the other, then page 4 next to page 6 – and both sides always show the same part of their page, also when the pages have different heights. Switching the lock on keeps the page of each side and moves the other side to the part of the page shown on the side you last scrolled or clicked. The horizontal position is the same on both sides. The differences are determined for the locked pages: if page 3 is next to page 5, page 3 is compared with page 5, page 4 with page 6, and so on; pages without a counterpart count as pages that exist in only one file. With the scroll lock both sides also have the same zoom; switching it on gives the other side the zoom of the side you last scrolled or clicked. The button to go back to the start puts page 1 next to page 1 again. Switch the lock off to scroll and zoom the two sides independently; the zoom controls then change the side you last scrolled or clicked.
- **Text** (T): compare the text instead of the appearance. The words of both pages are compared, and only words that were added, removed or changed are marked – changes in layout, fonts, colours or images are ignored, and so is text that only shifted because something before it changed. Pages without text (e.g. scans) show no differences in this mode. Switch it off to compare the rendered pixels again.
- **Highlighter**: show or hide the yellow background behind differing areas. Side by side it switches the differences on and off as a whole – the marks, the frame and the arrows (also `F8`) – and is off by default; the comparison does not jump to the first difference then.
- **Arrows**: frame the previous / next difference and scroll to it if it is not completely visible. The total number of differences is shown next to them. Side by side, they start from what is visible on the side you last scrolled or clicked, and the difference is framed on both sides. With the scroll lock the other side follows; without it, both sides scroll to the difference.
- Without differences these buttons are disabled.
- Page navigation, zoom, rotation, the hand tool, the button to go back to the start and the text search work as in the normal viewer. Side by side, rotation applies to both sides, and zoom too while the scroll lock is on; page navigation and the text search apply to the file with more pages (the second file if both have the same number).

### Problems view and keyboard

The differences are also listed in the **Problems** view of VS Code, with the page number as line number (of the first file, if it has the page). If different pages are compared, both page numbers are named.

While a comparison is the active editor, these keys jump between differences:

| Key | Action |
| --- | --- |
| `F8` or `Alt`+`F8` | Next difference |
| `Shift`+`F8` or `Shift`+`Alt`+`F8` | Previous difference |

The same actions are available as the commands **PDF View & Compare: Go to Next Difference** and **PDF View & Compare: Go to Previous Difference**.

Clicking an entry in the Problems view only brings the comparison to the front; it does not jump to that difference.

### Lifetime of a comparison tab

- The tab is named `compare: a.pdf ↔ b.pdf`, or `compare: a.pdf (git)` for a diff from Source Control and `compare: a.pdf (before)` for the version before the last reload.
- Comparing the same two files again brings the open tab to the front, also if it is in another editor group. Comparing with the version before the last reload again updates the open tab with the newer snapshot.
- If one of the files changes on disk, the comparison is updated; the scroll position is kept.
- The tab closes by itself when one of the files has been deleted (and is still missing two seconds later), or when a comparison with an in-memory earlier version is restored after a restart of VS Code.

## Development

```sh
npm install
npm run compile
```

Then press `F5` in VS Code to start an Extension Development Host.

The extension code is in `src/extension.ts`. The webviews are plain JavaScript modules in `media/`: `viewer.js` for the normal viewer, `compare.js` for the comparison and `common.js` for code shared by both.

## Installing

```sh
npx vsce package
code --install-extension pdf-viewer-diff-0.1.4.vsix
```

## License

[MIT](LICENSE). The bundled pdf.js is licensed under the Apache License 2.0; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
