# Progress & Plan

**Last updated:** 2026-08-22
**Live site:** <https://sushantsriv.github.io/3d-home-view/> · [demo tour](https://sushantsriv.github.io/3d-home-view/tour.html?demo=1)
**Repo:** <https://github.com/SushantSriv/3d-home-view> (public)
**Supabase:** project `ikuovilpewamyareelqm` — schema applied and verified

This file is the single source of truth for where the project stands. It is updated in the same
commit as the work it describes.

---

## 1. Milestone board

| # | Milestone | Status | Notes |
|---|---|---|---|
| 0 | Repo, README, licenses, progress tracking | ✅ Done | git repo initialised, first commit made |
| 1 | Room capture → panorama | ✅ Done (photo) · ⚠️ poor (video) | Panorama-photo import works and is instant. Video stitching works on synthetic footage but not yet on real handheld clips — [section 6](#6-stitching-tuning-notes). |
| 2 | Basic 360° viewer (Pannellum) | ✅ Done | Proven by the demo tour, no backend involved |
| 3 | Upload flow | ✅ Done | Both paths proven live: photo (browser-only, seconds) and video (queue → worker) |
| 4 | Floor plan + click-to-place pins | 🟡 Built | Data path proven; the click-and-drag UI itself still wants a human test |
| 5 | Connected viewer (floor plan ↔ 360° rooms) | ✅ Done | Demo tour walks four linked rooms |
| 6 | Shareable public link + error handling | ✅ Done | Random 7-char slugs, publish toggle, `/tour/<slug>` pretty URLs |
| 7 | Deploy (Pages + cloud stitching worker) | ✅ Done | Site live; a real job stitched start to finish on GitHub's runners |
| 8 | *Added:* studio authentication | ⬜ Deferred | See [risk R1](#5-risks--open-questions) |

Legend: ✅ done · 🟡 in progress · ⬜ not started · 🔴 blocked on someone else

**Try it right now, with nothing set up:**

```powershell
npx --yes serve web -l 4173
# http://localhost:4173/tour.html?demo=1
```

The demo tour paints its own equirectangular panoramas on a canvas at load time — real ray-cast
geometry, not stock images — so the viewer, floor plan, pins, room tags and doorway hotspots can all
be exercised offline.

---

## 2. Execution steps

- [x] **Step 1 — Repo skeleton.** git, `.gitignore`, `.gitattributes`, README, licenses, this file.
- [x] **Step 2 — GitHub.** Public repo created, pushed, Pages enabled (source: Actions), both
      Actions secrets set. Site live.
- [x] **Step 3 — Static site + demo mode.** Whole `web/` app built and deployed. *(Milestones 2, 5, 6)*
- [x] **Step 4a — Supabase code.** Schema, buckets, RLS, job-queue functions, studio UI.
- [x] **Step 4b — Schema applied.** Verified live: 3 tables readable by anon, 3 buckets with the
      right visibility, `claim_next_job()` denied to anon (401) and working for the service key.
- [x] **Step 5 — Stitcher proven.** Runs end to end on a synthetic pan with known ground truth.
      *(Milestone 1 — see [section 6](#6-stitching-tuning-notes))*
- [x] **Step 6a — Worker code.** `worker.py` + `run_local.ps1`, atomic claim/complete/fail.
- [x] **Step 6b — Loop proven.** Ran the whole chain against the live project with the synthetic
      clip: upload → queue → worker claims → stitches → uploads → `complete_job` → published tour
      readable with no key. Still worth repeating with real footage.
- [x] **Step 7 — Share links + polish.** Slugs, publish toggle, `404.html` rewrite, failure copy.
- [x] **Step 8a — Cloud worker workflow + secrets.** Armed and connected.
- [x] **Step 8b — Cloud worker confirmed.** A queued job was stitched end to end on a GitHub runner
      (Python 3.12, `opencv-python-headless`) with this machine uninvolved: 367.8° recovered,
      panorama uploaded, source video deleted, job marked done. Whole run took 3 minutes.

---

## 3. What only you can do

| # | Action | Why it needs you | Done? |
|---|---|---|---|
| 1 | **Shoot a room in Panorama mode** — stand in the middle, phone upright, sweep a full circle following the on-screen guide — and upload it under *Panorama photo*. | This is the path worth judging the product on. It needs a real room. | ⬜ |
| 2 | **Place the pins and publish**, then open the share link on a phone. | The click-and-drag pin UI has still never been used by a human. | ⬜ |
| 3 | *Optional:* a domain, if `sushantsriv.github.io/3d-home-view` is not good enough for a listing. | — | ⬜ |

**Done and verified:** GitHub auth, public repo, Pages, Actions secrets, Supabase
schema (including the panorama geometry columns), storage buckets and policies,
Python environment, `.env`, the local worker, and the cloud worker.

### The anon key vs. the service key

The **anon key** is designed to be public — it ships in every browser and is already committed in
`web/js/config.js`. That is normal. The **service key** bypasses all security rules; it belongs in
`.env` and in Actions secrets, nowhere else. The Pages workflow fails the deploy if it ever finds a
`service_role` string inside `web/`.

---

## 4. Decisions made

| Decision | Choice | Why |
|---|---|---|
| Hosting | Public GitHub repo → GitHub Pages | Pages on a free account requires a public repo. Also unlocks unlimited Actions minutes, which become the free stitching worker. |
| Stitching compute | Local first, identical script on Actions later | Fastest route to a first real panorama; promoting to cloud is adding a secret, not rewriting code. |
| Frontend | Plain HTML/CSS/ES modules, no build step | Matches the brief, keeps the Pages deploy trivial, nothing to break. |
| Backend API | **None** | The browser talks to Supabase directly, so there is no server to host or pay for. |
| Studio auth | None, for now | Your call — pet-project speed. See risk R1. |
| Upstream stitcher | Pinned git submodule, unmodified | Keeps the MIT boundary clean and allows `git submodule update --remote`. Our tuning lives in `stitcher/config.template.yaml`. |
| Pin coordinates | Normalised 0–1, not pixels | Floor plan stays correct at any screen size. |
| Job claiming | Postgres `FOR UPDATE SKIP LOCKED` | Your laptop and a CI run can poll the same queue without ever taking the same video. |
| Demo panoramas | Ray-cast and painted in the browser | Gives a working demo with zero setup and zero licensing questions about stock imagery. |

---

## 5. Risks & open questions

**R1 — No auth on a public studio page.** The site is public, the Supabase anon key is public, and
there is no login, so anyone who finds `studio.html` can create or delete tours. Accepted
deliberately. Two mitigations are in place: `DEPLOY_STUDIO: 'false'` in
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) drops the studio from the public site
with a one-line change (you'd then run it locally via `npx serve web`), and Milestone 8 swaps the
anon write policies in `schema.sql` for owner-scoped ones behind Supabase magic-link auth.

**R2 — Free-tier ceilings.**
- Supabase **pauses a project after 7 days with no activity** — one click to resume, data kept. The
  app reports this specifically rather than showing a generic network error.
- Supabase free: 500 MB database, **1 GB storage**, 5 GB egress/month. Raw videos would exhaust
  storage first, so the worker deletes each source video after a successful stitch.
- GitHub Pages: 1 GB site, 100 GB/month bandwidth (soft).
- GitHub Actions: unlimited on public repos, but **scheduled workflows are disabled after 60 days
  of repository inactivity**, and cron runs can be delayed several minutes under load.

**R3 — Stitch quality on *real* footage is still unproven.** The pipeline is validated against a
synthetic pan (section 6), which settles the geometry and the configuration but says nothing about
rolling shutter, motion blur, dim light, or the blank walls of an empty Nordic flat. Expect
`min_inliers` and `hfov_deg` to need attention on the first real clip. A second, known limitation:
a single-height pan only covers a horizontal band, and the uncovered parts are currently filled with
stretched edge pixels — cropping to the covered band and declaring Pannellum's `vaov` would look far
better.

**R4 — Actions runners are CPU-only.** Fine at 4096 px, but if stitching turns out slow the fallback
is a free Hugging Face Space running the same `worker.py`.

**Open question — how does a seller get pin positions right?** Right now they click the plan and
drag to adjust, and `heading_offset` rotates the doorway arrows by hand. If that proves fiddly with
a real listing, the next idea is to derive heading from the panorama itself.

---

## 6. Capture pipeline: what we learned

### Two capture paths, and which to use

| | Panorama photo | Room video |
|---|---|---|
| Who stitches | your phone, live, with the gyroscope | us, offline, from features alone |
| Time to ready | **seconds**, in the browser | ~55 s stitch + up to 5 min queue |
| Vertical coverage | **~86°** | ~36 % of the sphere |
| Failure modes | none — it is a projection conversion | many, see below |
| Needs the worker | no | yes |

**Use the photo path.** The video path is kept, demoted, and still useful if a
phone has no panorama mode.

### Why the video path struggles on real footage

It works on synthetic footage and fails on a real living room, and the gap is
instructive.

- **Uneven panning.** A real 36-frame extraction gave steps of 5.3°–21.7° where
  10° was expected. Nobody turns at a constant rate.
- **Wobble.** Mean per-step angle was 13.4° against a 10° yaw step, so pitch and
  roll jitter is comparable to the actual turn.
- **More frames does not help.** 72 frames fixed every metric — suspicious pairs
  21 → 2, zero failed matches, step range 1.5°–12.0° — and produced a *worse*
  image, because wobble then dominates and the horizon snakes. Tested across
  36/48/72 frames × smoothing 3/5/9; none was acceptable.

### Two wrong turns, recorded so nobody repeats them

**Back-solving the focal length from the sweep.** The pipeline reported 470° of
yaw for one turn, so: closure proves it was one revolution, scale the focal
length until the sweep reads 360. Measuring first killed it. On a synthetic pan
of known geometry (true horizontal FOV 38.7°), telling the pipeline
30/34/38.7/44/50 gave sweeps of 394/377/365/361/363 — the curve bottoms out near
44 and turns back up, and the true FOV is nowhere near the 360 crossing. It
would have converged confidently on the wrong lens.

**Reading `det_raw` as a parallax signature.** Values of 1.5–1.7 looked like
proof the camera was translating rather than rotating. The synthetic pan — camera
provably at the origin in every frame — shows 1.50–1.56 as well. It tracks the
step *angle*. Claim withdrawn.

The lesson both times: measure against footage of known geometry before believing
a diagnosis. `stitcher/make_test_video.py` exists for exactly that.

### Settings that are actually justified

| Setting | Ours | Upstream | Why |
|---|---|---|---|
| `rotation_smoothing_window` | 3 | 17 (example) | Upstream averages rotation *matrices*, valid only for small angles. At our 10°/frame spacing, 17 spans ±60° and collapses the sweep: 21.6 % coverage and heavy ghosting, versus a clean stitch at 3. |
| `num_frames` / `pano_width` | 36 / 3072 | 40 / 4096 | 77 s → 51 s measured, visually indistinguishable. |
| `hfov_deg` | derived per video | fixed 42 | Horizontal FOV depends on how the phone was held: 64° landscape, 39° portrait. Using the landscape figure on a portrait clip reported 393° for one turn. `horizontal_fov()` derives it from frame shape. |
| `match_full_res` | false @ 1280 | true | Video frames are softer than stills; much faster, nearly as accurate. |
| `blending.method` | multiband | none | Auto-exposure always shifts panning past a window. |

### Panorama photo conversion

A phone panorama is *cylindrical*: vertical position goes as `tan(pitch)`, not
`pitch`. `web/js/pano.js` remaps it to equirectangular in the browser, one output
row at a time. Photo Sphere files are already equirectangular and carry GPano XMP
metadata, so those are used as-is.

Verified by round-tripping a known panorama through the exact algorithm: recovers
`vaov` 86.01° against 86.00° true, 2.1 % mean absolute error.

The viewer honours `haov`/`vaov`/`v_offset`, so a band renders as a band with
clean empty space above and below rather than being stretched over a full sphere.

### HEIC, which is the default and could not be opened

iPhones write HEIC, Panorama mode included, and no browser except Safari decodes
it. So the single most likely file a Norwegian seller uploads was the one file the
app rejected — and it rejected it with a guess, because the old code blamed HEIC
for *every* decode failure whether or not the file was one.

Both halves are fixed:

- **Sniffing.** `sniff()` reads the first 64 bytes and identifies the container from
  the magic bytes. Neither the extension nor the browser's MIME type is trustworthy;
  a HEIC out of a synced iCloud folder often arrives with `type: ""`. It reads the
  ISO base-media *compatible brands* list, not just the major brand — the sample
  iPhone-style file is major brand `mif1`, with `heic` further down the list, so
  checking the major brand alone would have missed it. Unit-tested against real
  HEIC, JPEG, PNG, MP4 and AVIF bytes: 5/5.
- **Decoding.** `web/vendor/libheif/` holds libheif built to WebAssembly. It is
  imported dynamically, and only after the browser's own decoder has already failed,
  so Safari never downloads it and neither does a JPEG upload. `decode()` picks the
  largest image in the file, because a HEIC also carries a thumbnail and sometimes a
  depth map.

Verified end to end in headless Edge — a browser that genuinely cannot decode HEIC —
against a real HEIC: native decode failed, the sniffer routed to libheif, the wasm
bundle was fetched, and the result was a 364 KB JPEG with real image content, in
1.29 s including the 1.2 MB download. Geometry came out as predicted for a 1280×854
source at 68° vfov: `haov` 115.8° against 115.9° computed by hand.

**Licence note:** libheif is LGPL-3.0, the only non-MIT dependency in the project.
It is shipped unmodified as a separate runtime-loaded file, which is what keeps the
obligation contained. See `THIRD_PARTY_LICENSES.md` and `web/vendor/libheif/README.md`.

Also added: a panorama that arrives taller than it is wide is now rejected outright.
It is either not a panorama or it came through rotated, and every angle derived from
its aspect ratio downstream would otherwise be quietly wrong.

### Memory, and a bug that hid behind a WebIDL error message

The first HEIC upload of a real photo failed with `Failed to execute 'drawImage':
The provided value is not of type '(CSSImageValue or HTMLCanvasElement or ...)'`.
That message names every type Chromium accepts and so says nothing about which
decoder gave up. Testing each candidate value directly established that only
`undefined`, `null`, a plain object or an `ImageData` produce it — a zero-sized
canvas and a closed `ImageBitmap` both give a different, named `InvalidStateError`.

The underlying cause is memory. The real file is 10786 × 3706 — forty megapixels,
160 MB as RGBA — and the code held three copies at once: the `ImageData` from
libheif, a full-size canvas painted from it, and the downscaled canvas. Reproduced
with GPU acceleration on (the earlier tests had run `--disable-gpu`, which is why
they passed): the renderer died partway through encoding and never came back.

Fixed by never creating the full-size canvas. `createImageBitmap(imageData,
{ resizeWidth })` goes straight from libheif's pixels to a bitmap the browser has
already shrunk. `MAX_DECODE_WIDTH` also dropped from 8192 to 4096, which is the
widest image this app ever outputs, so decoding above it only ever cost memory.
The native path stopped decoding the file twice as well — it now resizes the
bitmap it already has, which was a large part of the wait on a 40 MP photo.

`decode()` now asserts that what it returns is actually drawable, so any future
failure of this kind names itself instead of surfacing as a wall of type names.

### Joining two sweeps, finally tested on real pixels

The merge had shipped without ever running on real files. Tested by cutting the
real panorama into two overlapping sweeps — 0–60 % and 40–100 %, so 135° each with
45° of overlap — and feeding them back in: recovered **224.9°**, the exact width of
the original, correlation score 1.025.

That test also exposed a genuine bug. Compositing happens on a full-circle canvas,
because that is the only frame in which two sweeps can be positioned relative to
one another, but the result was handed to the viewer still full-circle wide while
declaring `haov` as the covered arc — so the viewer would spread 360° of image
across 225°. `cropToCoverage()` now trims to the covered arc, finding the longest
run with wrap-around because the gap is often behind the photographer. Verified by
checking the image's aspect ratio against the declared angles: 3.306 vs 3.307.

Merged output is also capped at 4096 wide. Two sweeps composited at their own
resolution came out 6826 px, and older phone GPUs cap a texture at 4096 — the
viewer is the one part of this project that has to work on a stranger's handset.

**What the join cannot do:** with a real gap between the sweeps it still reports a
confident-looking answer. Two halves with a 22° gap scored 0.667 against 1.025 for
a true overlap, and were pulled together into 194°, losing the gap. A single
correlation score cannot separate a true match from a plausible one, so the studio
now says when the evidence was thin rather than deciding silently.

### Zoom limits cannot be constants

Reported as "infinite zoom in or out ... the scale does not look good". The viewer
had a fixed `hfov: 100` opening view with `minHfov: 50` / `maxHfov: 120`, and those
numbers only work for one viewport shape:

| viewport | vertical view at hfov 100 | at hfov 50 (max zoom in) | image is 68° |
|---|---|---|---|
| desktop 16:9 | 67.7° | 29.4° | fits |
| laptop 1440×780 | 65.7° | 28.4° | fits |
| **phone portrait** | **137.6°** | **90.5°** | **never fits** |

On a phone held upright the panorama cannot fill the frame at *any* allowed zoom —
the closest reachable is 90.5° against a 68° image. Zooming therefore never
resolves, which is exactly what "zooming forever and it never sits right" is. And
whenever the view is taller than the image, Pannellum pins pitch to the centre
(`maxPitch - minPitch < a → f = n = (f+n)/2`), so dragging up and down stops
responding too. Desktop 16:9 sat at 67.7 against 68 — passing by a third of a
degree, which is why it looked fine and hid the problem.

The fix derives the zoom-out limit from the panorama and the viewport instead:
`fitHfov(vaov, aspect) = 2·atan(tan(vaov/2)·aspect)`, which is the hfov at which the
band exactly fills the height. That becomes `maxHfov` and the opening `hfov`, with
`minHfov` at half of it so there is always a factor of two of zoom in hand — a
fixed floor of 50 would have pinned zoom entirely on a tall screen, where the whole
usable range sits below it. `avoidShowingBackground: true` makes Pannellum
re-derive the same bound every frame from the live canvas, so a resized window or a
rotated phone stays right.

Measured by screenshotting the real published tour before and after, and counting
backdrop-coloured pixels:

| viewport | before | after |
|---|---|---|
| 1600×900 | 0.1 % | 0.1 % |
| 900×1000 | *rendered pure black* | 0.1 % |
| **390×844** | **24.5 %** | **0.0 %** |

An earlier attempt at this measurement read the WebGL canvas with `drawImage` and
reported 0 % for every case including the broken ones. Pannellum does not set
`preserveDrawingBuffer`, so the buffer is empty by the time it can be read; the
numbers above come from real screenshots instead.

### The floor plan was covering the tour on a phone

Found while checking the above, not reported. The dock measured 358 × 543 inside a
390 × 844 screen — 64 % of the tour covered by a map of it, on the device the share
link is most likely to be opened on. It now folds shut on a small screen on the way
in (once only, so it does not undo the visitor's own choice) and has a height
ceiling when open.

### Reproducing

```powershell
.venv\Scripts\python.exe stitcher\make_test_video.py --out out\testroom --portrait --width 1080 --hfov 38.7
.venv\Scripts\python.exe stitcher\stitch_room.py    --video out\testroom\pan.mp4 --out out\testroom\stitched
```

---

## 7. Changelog

- **2026-08-22 (viewer)** — Fixed zoom that never resolved on a tall viewport: the limits
  were constants that only suited 16:9, and on a phone in portrait the image could not fill
  the frame at any allowed zoom. They now come from the panorama's own `vaov` and the live
  viewport shape. Also folded the floor-plan dock away on small screens, where it had been
  covering two thirds of the tour.
- **2026-08-22 (HEIC, part two)** — The first real HEIC upload failed on an opaque
  WebIDL type error. Cause was memory: three copies of a 40 MP image live at once, which
  kills the renderer rather than throwing. Now goes straight from libheif's pixels to a
  bounded `ImageBitmap`, decode ceiling halved to 4096, and the native path no longer
  decodes the file twice. Sweep joining tested on real pixels for the first time, which
  found a projection bug — the merged canvas was full-circle wide while declaring a
  partial `haov` — now cropped to its real coverage and capped for old phone GPUs.
- **2026-08-22 (HEIC)** — Panorama upload failed on iPhone files: no browser but Safari
  decodes HEIC, and the error message blamed HEIC for every decode failure regardless of
  cause. Vendored libheif as WebAssembly, loaded only when a container sniff confirms HEIC
  and only after the native decoder has already failed. Verified end to end in headless
  Edge against a real HEIC. Adds the project's only non-MIT dependency (LGPL-3.0);
  compliance notes in `THIRD_PARTY_LICENSES.md`.
- **2026-08-22 (capture rework)** — Real footage exposed that the video path does not
  hold up: uneven panning and hand wobble, and raising the frame count fixes every metric
  while making the image worse. Two plausible diagnoses were measured and discarded (see
  section 6). Added panorama-photo import on the user's suggestion — the phone stitches it
  live with the gyroscope, leaving only a projection conversion that runs in the browser in
  seconds and cannot fail. Viewer now honours partial-panorama geometry.
- **2026-08-22 (end of session)** — Proved the whole chain against the live project, twice: once
  with the local worker, once entirely on a GitHub runner with this machine uninvolved. Upload →
  queue → claim → stitch → upload → publish → fetched with no key. That run exposed the orientation
  bug (393° for one turn) now fixed by deriving FOV from frame shape. Also confirmed the write-only
  video bucket really is write-only: anon LIST returns `[]` and READ returns 400, while the service
  key sees the object.
- **2026-08-22 (later)** — Repo pushed public, Pages live, Actions secrets set. Supabase schema
  applied and independently verified (tables, buckets, and that `claim_next_job` is denied to anon).
  Python 3.14 + OpenCV 5 environment built; confirmed all 46 cv2 symbols upstream uses still exist.
  **Milestone 1 validated** against a synthetic pan with known ground truth, which caught three
  configuration bugs — see section 6. Fixed a real defect found by the first studio upload: videos
  were sent with `upsert`, which the write-only `raw-videos` policy correctly refuses.
- **2026-08-22** — Project bootstrapped from `home-tour-app-claude-code-brief.md`. Researched the
  hosting constraints (Pages is static-only and needs a public repo on the free plan) and settled on
  browser → Supabase → offline-worker. Built the full static site including an offline demo tour,
  the Supabase schema with an atomic job queue, the stitcher wrapper over a pinned upstream
  submodule, the worker, and both GitHub Actions workflows. Supabase project created and its anon
  key wired in. First commit made; repo not yet pushed.
