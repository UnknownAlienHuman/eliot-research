# Third-party notices

The Material Symbols SVG paths in `src/web/ui/MaterialSymbol.tsx` are by Google,
licensed under Apache License 2.0. The K0 subset was adapted from
`packages/ui/src/catalog/MaterialSymbol.tsx` at Eliot donor commit
`7c034569b908d3b03a8b821b7c537477a24b10f7`. The licence is included in
[`public/licenses/Apache-2.0.txt`](public/licenses/Apache-2.0.txt).

Self-hosted Google Sans and Google Sans Code retain their SIL Open Font License
notices in `public/fonts/OFL-GoogleSans.txt` and `public/fonts/OFL-GoogleSansCode.txt`.
The remaining moved Eliot theme and shell code is covered by the repository MIT licence.

## PDF.js

`pdfjs-dist@6.4.299` is distributed by the Mozilla PDF.js project under Apache License 2.0.
The npm package `gitHead` and upstream tag `v6.4.299` identify
[`d0991a0d53f3bb3a7307e3b83f279c1d117aafb3`](https://github.com/mozilla/pdf.js/tree/d0991a0d53f3bb3a7307e3b83f279c1d117aafb3).
The installed `build/pdf.mjs` and `build/pdf.worker.min.mjs` carry this attribution:

> Copyright 2024 Mozilla Foundation

Those unmodified package files provide browser page rasterization for explicit owner-requested OCR only;
PDF.js is not used as Eliot's canonical text converter. Retain their upstream licence notices when bundling.
The package licence is `pdfjs-dist/LICENSE`; Apache License 2.0 is included in
[`public/licenses/Apache-2.0.txt`](public/licenses/Apache-2.0.txt).
