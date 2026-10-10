# PDF Viewer für VS Code

Zeigt PDF-Dateien direkt im Editor an (basierend auf [pdf.js](https://mozilla.github.io/pdf.js/)).

## Funktionen

- Öffnet `*.pdf` automatisch als Custom Editor
- Seitennavigation, Zoom (Buttons, `Strg`+Mausrad, `Strg`+`+`/`-`/`0`), Anpassen an Seitenbreite/ganze Seite
- Umschalten zwischen Textauswahl und Hand-Werkzeug (Seite mit der Maus ziehen)
- Textauswahl und Volltextsuche (`Strg`+`F`, `Enter` / `Umschalt`+`Enter`)
- Klickbare Links und internes Inhaltsverzeichnis-Springen
- Lädt automatisch neu, wenn sich die Datei ändert (z. B. nach einem LaTeX-Build); Seite und Zoom bleiben erhalten
- Funktioniert auch mit Remote- und virtuellen Dateisystemen

## Entwicklung

```sh
npm install
npm run compile
```

Dann in VS Code `F5` drücken, um ein Extension-Development-Fenster zu starten.

## Installieren

```sh
npm run package
code --install-extension vscode-pdfviewer-0.1.0.vsix
```
