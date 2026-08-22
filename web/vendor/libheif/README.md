# libheif (vendored)

`libheif-bundle.js` is the unmodified WebAssembly build of
[libheif](https://github.com/strukturag/libheif) published as
[libheif-js](https://github.com/catdad-experiments/libheif-js) v1.18.2, fetched from
npm and committed here verbatim, renamed from `.mjs` to `.js` so that GitHub Pages is certain
to serve it with a JavaScript content type. Its bytes are unchanged.

**Why it is here.** iPhones save photos as HEIC by default, Panorama mode included,
and no browser except Safari can decode that. Without this the most likely file a
seller uploads is the one file the app cannot open. It is loaded by dynamic import
from `web/js/pano.js` only after the browser's own decoder has already failed, so it
costs nothing on Safari or for a JPEG.

**Licence.** libheif and its HEVC decoder libde265 are **LGPL-3.0**, unlike every
other dependency in this project, which is MIT. `COPYING.LESSER` and `COPYING` are
the LGPL-3.0 and GPL-3.0 texts.

We meet LGPL-3.0 §4 by the plainest route available: the library is shipped
unmodified, as its own separate file, loaded at runtime rather than linked into our
code, so anyone may replace it with their own build by overwriting this one file.
Its complete corresponding source is the upstream repository at the version named
above. If you modify this file, say so here.
