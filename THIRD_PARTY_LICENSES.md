# Third-Party Licenses

This project is built on open-source components. Their licenses are reproduced below
as required. Nothing here grants a license to the original code in this repository
(see [LICENSE](LICENSE)).

---

## Pannellum

360° panorama viewer. Vendored in `web/vendor/pannellum/`.
Upstream: https://github.com/mpetroff/pannellum

```
Copyright (c) 2011-2024 Matthew Petroff

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 360-spherical-stitching (Kronbii)

Video-to-equirectangular-panorama pipeline. Included as a pinned git submodule at
`third_party/360-spherical-stitching/`. Our code wraps it via `stitcher/stitch_room.py`
and does not modify the upstream tree.
Upstream: https://github.com/Kronbii/360-spherical-stitching

Licensed under the MIT License. The authoritative copy of the license text ships
inside the submodule at `third_party/360-spherical-stitching/LICENSE`.

---

## supabase-js — no longer used by the browser

The web front end no longer loads supabase-js. `web/js/api.js` is a small
hand-written PostgREST + Storage client, written for this project, because the
library was only ever used for queries, one URL concatenation and one delete —
uploads already went through raw XHR to get progress events. Importing it from a
CDN cost 186 kB across 14 cross-origin modules and made every published listing
link depend on a third party staying up.

The Python worker still uses the `supabase` package (MIT); see below.

---

## Instrument Sans

Display typeface, self-hosted in `web/vendor/fonts/` as two woff2 subsets of the
variable font (41 kB total). No third-party connection at runtime.
Upstream: https://fonts.google.com/specimen/Instrument+Sans

Licensed under the SIL Open Font License 1.1. The OFL permits redistribution and
web embedding of the font files provided they are not sold on their own and the
licence travels with them; the full text is at
https://openfontlicense.org/open-font-license-official-text/

---

## libheif / libde265  — LGPL-3.0, not MIT

HEIC decoder. Vendored unmodified in `web/vendor/libheif/` as the WebAssembly build
published by [libheif-js](https://github.com/catdad-experiments/libheif-js) v1.18.2.
Upstream: https://github.com/strukturag/libheif

This is the one dependency here that is **not** permissively licensed, so it is
called out rather than listed. libheif and the libde265 HEVC decoder inside it are
LGPL-3.0. The full texts are `web/vendor/libheif/COPYING.LESSER` (LGPL-3.0) and
`COPYING` (GPL-3.0, which the LGPL incorporates by reference).

Nothing about that licence reaches the rest of this repository. LGPL-3.0 §4 permits
combining the library with a work under any licence provided the library stays
replaceable, and here it plainly is: it is an unmodified separate file, dynamically
imported at runtime, and swapping in a different build means overwriting one file.
See `web/vendor/libheif/README.md` for the compliance notes and where the
corresponding source lives.

---

## Transitive Python dependencies

`opencv-python-headless` (Apache-2.0), `numpy` (BSD-3-Clause), `Pillow` (MIT-CMU),
`PyYAML` (MIT), `exifread` (BSD-3-Clause), `natsort` (MIT), `supabase` (MIT).
Full texts are installed alongside each package in the virtualenv.
