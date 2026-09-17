# OpenPi Desktop — Third-Party Notices

OpenPi Desktop is licensed under `AGPL-3.0-only`. Third-party components keep their own licenses; this notice is an inventory aid, not a substitute for their license texts and not legal advice.

## Restricted bundled skills

The following bundled skill packages include their own `LICENSE.txt` granting **personal, educational, and non-commercial use only**. Commercial use requires separate permission from Z.ai:

- `resources/skills/docx/`
- `resources/skills/pdf/`
- `resources/skills/xlsx/`

OpenPi Desktop copies these resources into the user's Pi skill directory. Their license files must remain intact. The OpenPi AGPL license does not override those restrictions.

## Apache-2.0 skill resources

The following carry Apache License 2.0 texts in their directories:

- `canvas-design`
- `mcp-builder`
- `theme-factory`
- `web-artifacts-builder`
- `webapp-testing`

Font files under `resources/skills/canvas-design/canvas-fonts/` carry adjacent SIL Open Font License texts. Other skills without a root license file must be reviewed before redistributing modified copies.

## JavaScript dependencies

The application bundles dependencies installed from `package-lock.json`, including Electron, the Pi coding agent SDK, MCP SDK, DOMPurify, ECharts, Highlight.js, Lucide, Mammoth, Marked, TypeScript, SheetJS, `better-sqlite3`, and `chrome-remote-interface`. Their package metadata and license files are retained in the packaged dependency tree where supplied. Run:

```bash
npm run licenses:audit
```

before each public release and review any `UNKNOWN`, `UNLICENSED`, `GPL`, `AGPL`, `SSPL`, or custom-license result.

## Embedded Python runtime

The Windows package embeds CPython 3.12 and Python packages. License metadata is retained in their `.dist-info` directories. Notable reciprocal-license components include:

- `pikepdf` — MPL-2.0
- `py7zr`, `inflate64`, `multivolumefile`, `pybcj`, `pyppmd` — LGPL-2.1-or-later variants
- `PyMuPDF` — AGPL-3.0 or commercial license

PyMuPDF is compatible with OpenPi Desktop's AGPL distribution only while the corresponding source and notices are made available under the AGPL. If distributing OpenPi under different terms, remove PyMuPDF or obtain a commercial license. A release must not omit applicable Python package license/source-offer obligations.

## Source availability

The corresponding OpenPi Desktop source is published at:

<https://github.com/liujinan153-cpu/openpi-desktop>

For bundled third-party source or license questions, use the upstream links in package metadata or open an issue in the repository.
