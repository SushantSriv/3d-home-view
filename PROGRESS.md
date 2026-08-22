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
| 1 | Stitching pipeline proof of concept | ✅ Done | Validated on a synthetic pan with known ground truth. See [section 6](#6-stitching-tuning-notes). |
| 2 | Basic 360° viewer (Pannellum) | ✅ Done | Proven by the demo tour, no backend involved |
| 3 | Upload flow (video → stitch → panorama URL) | ✅ Done | Full loop proven against the live project — see [section 6](#6-stitching-tuning-notes) |
| 4 | Floor plan + click-to-place pins | 🟡 Built | Schema live; awaiting your first real tour to confirm |
| 5 | Connected viewer (floor plan ↔ 360° rooms) | ✅ Done | Demo tour walks four linked rooms |
| 6 | Shareable public link + error handling | ✅ Done | Random 7-char slugs, publish toggle, `/tour/<slug>` pretty URLs |
| 7 | Deploy (Pages + cloud stitching worker) | 🟡 Site live | Local worker proven; the Actions cron is armed but has not yet run a real job |
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
- [x] **Step 8a — Cloud worker workflow + secrets.** Armed; has not yet processed a real job.
- [ ] **Step 8b — Confirm the cloud worker.** Stop the local worker, upload, run the workflow.

---

## 3. What only you can do

Everything I could do without you is done. What is left:

| # | Action | Blocks | Cost | Done? |
|---|---|---|---|---|
| 1 | **Record a real room video** — phone held **upright** (this matters, see section 6), one slow full turn, 20–30 s, standing in one spot, framing furniture and edges rather than bare wall. | Step 6b | free | ⬜ |
| 2 | **Walk one tour through the studio** — <https://sushantsriv.github.io/3d-home-view/studio.html>. Create a property, upload a floor plan, drop pins, upload that video, then run `./worker/run_local.ps1` and watch the room go `queued → processing → done`. | Step 6b | free | ⬜ |
| 3 | **Confirm the cloud worker** once the local loop works: stop the local worker, upload another clip, then `gh workflow run stitch-worker.yml`. | Step 8b | free | ⬜ |
| 4 | *Optional:* buy a domain if `sushantsriv.github.io/3d-home-view` is not good enough for a listing. | polish | ~$12/yr | ⬜ |

**Already done:** GitHub auth, public repo + Pages, Supabase project, schema applied, storage
buckets, Python 3.14 + virtualenv + dependencies, `.env` with the service key, and both Actions
secrets.

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

## 6. Stitching tuning notes

**Milestone 1 is validated.** Not on a phone clip yet — on a synthetic one. `stitcher/make_test_video.py`
builds a textured virtual room, renders the equirectangular panorama a perfect camera would see,
then re-renders that as a handheld pan with pitch/roll wobble and auto-exposure drift. Because the
ground truth is kept, the reconstruction can be judged rather than admired.

### What was measured

| Run | Recovered rotation | Coverage | Result |
|---|---|---|---|
| Landscape, `rotation_smoothing_window: 17` | — | 21.6 % | Heavy ghosting; every object doubled |
| Landscape, window `3` | **362.0°** | 22.2 % | Sharp, correctly ordered walls |
| **Portrait, window `3`** | **367.6°** | **36.0 %** | Sharp, and far more floor and ceiling |

Closure validated in both good runs (frame 46/47 matched frame 0 with 101–336 inliers), so drift is
being cancelled as intended.

### Three findings that changed the defaults

**1. `rotation_smoothing_window` must scale with degrees-per-frame, not frames.** This was my bug.
Upstream smooths by averaging rotation *matrices* across the window, which is only valid while those
rotations are small. Their example uses `17` because their `interval` extraction produces ~375 frames
about 1° apart. I switched to 48 uniform frames — 7.5° apart — where a window of 17 averages across
±60° of yaw and collapses the sweep. Changing the extraction method silently invalidated their
smoothing value. Now `3`, with the reasoning recorded next to it in `config.template.yaml`.

**2. Tell sellers to hold the phone upright.** A landscape 16:9 frame at 64° HFOV has only a 39°
vertical field, so a single-height pan covers a ±19° band — 33 % of the sphere at best. Rotate the
same phone and the tall axis carries the wide angle: 64° vertical, a ±32° band, 53 %. Measured
22 % → 36 % actual panorama coverage from the identical scene. It is the cheapest quality win
available and costs nothing but a sentence of guidance, now shown on the landing page and next to
every video upload field.

**3. `hfov_deg` must match the orientation.** Landscape ≈ 64, portrait ≈ 39. Get it wrong and the
panorama either repeats itself or fails to close. This remains the first knob to turn on a bad stitch.

### A fourth finding, from the first end-to-end run

**The worker cannot ask the seller which way they held the phone, so it works it out.** The first
real queue run stitched the portrait clip with the landscape default and reported **393°** of
rotation for one full turn — a ~9 % over-rotation that shows up as a duplicated seam. `stitch_room.py`
now derives the horizontal FOV from each video's frame shape (`horizontal_fov()`), assuming a 64°
long-axis sensor: 1920×1080 → 64°, 1080×1920 → 38.7°, 1440×1920 → 50.2°. Re-running the identical
job gave **367.6°**. Nobody has to configure anything.

### Still open

- **The uncovered band still looks bad.** Above and below the covered band the pipeline stretches
  edge pixels into long vertical smears. Pannellum supports partial panoramas via `haov`/`vaov`/
  `vOffset`; cropping the output to the genuinely covered band and declaring `vaov` would show clean
  empty space instead of smear. Worth doing before anyone shows this to a buyer.
- **Runtime:** ~70 s per room on 8 cores at 4096 px, 48 frames. Comfortable for a GitHub Actions run.
- **Not yet tested on real footage:** rolling shutter, motion blur, low light, and blank Nordic walls
  are all absent from the synthetic scene. Expect `min_inliers` to need attention on a real clip.

### Defaults and why they differ from upstream

| Setting | Ours | Upstream | Reason |
|---|---|---|---|
| `intrinsics.hfov_deg` | 64 (landscape) / 39 (portrait) | 42 | Phone *video* is cropped versus stills. Must match orientation. |
| `matching.rotation_smoothing_window` | **3** | 17 (their example) | Measured above. Matrix averaging is only valid for small rotations. |
| `video_extraction.method` | `uniform`, 48 frames | `interval`, every 2nd | A 25 s clip at 30 fps gives ~375 frames — minutes of matching for no gain. |
| `matching.match_full_res` | `false` @ 1280 px | `true` | Video frames are softer than stills; much faster, nearly as accurate. |
| `matching.min_inliers` | 90 | 200 | 200 is a high bar for a plain painted wall. |
| `matching.use_clahe` | `true` | `false` | Buys back features in dim rooms. |
| `disable_circular_closure` | `false` | `true` | A room pan returns to its start; detecting that cancels drift. |
| `blending.method` | `multiband` | `none` | Auto-exposure always shifts panning past a window. |

### Reproducing

```powershell
.venv\Scripts\python.exe stitcher\make_test_video.py --out out\testroom --portrait --width 1080 --hfov 38.7
.venv\Scripts\python.exe stitcher\stitch_room.py  --video out\testroom\pan.mp4 --out out\testroom\stitched --hfov 38.7
```

Then compare `out\testroom\truth.jpg` against `out\testroom\stitched\panorama.jpg`, or load the
result in the viewer with `tour.html?pano=<url>`.

---

## 7. Changelog

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
