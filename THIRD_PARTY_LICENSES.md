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

## supabase-js

Client library, loaded at runtime from a CDN (not redistributed here).
Upstream: https://github.com/supabase/supabase-js — MIT License.

---

## Transitive Python dependencies

`opencv-python-headless` (Apache-2.0), `numpy` (BSD-3-Clause), `Pillow` (MIT-CMU),
`PyYAML` (MIT), `exifread` (BSD-3-Clause), `natsort` (MIT), `supabase` (MIT).
Full texts are installed alongside each package in the virtualenv.
