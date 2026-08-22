# Progress & Plan

**Last updated:** 2026-08-22
**Live site:** _not deployed yet — blocked on [action #2](#3-what-only-you-can-do)_
**Supabase:** project `ikuovilpewamyareelqm` created; schema not applied yet

This file is the single source of truth for where the project stands. It is updated in the same
commit as the work it describes.

---

## 1. Milestone board

| # | Milestone | Status | Notes |
|---|---|---|---|
| 0 | Repo, README, licenses, progress tracking | ✅ Done | git repo initialised, first commit made |
| 1 | Stitching pipeline proof of concept | 🔴 Blocked | Code written and wired; needs **Python 3.12** → [action #1](#3-what-only-you-can-do) |
| 2 | Basic 360° viewer (Pannellum) | ✅ Done | Proven by the demo tour, no backend involved |
| 3 | Upload flow (video → stitch → panorama URL) | 🟡 Built, untested | Needs schema applied + a worker running |
| 4 | Floor plan + click-to-place pins | 🟡 Built, untested | Needs schema applied → [action #3](#3-what-only-you-can-do) |
| 5 | Connected viewer (floor plan ↔ 360° rooms) | ✅ Done | Demo tour walks four linked rooms |
| 6 | Shareable public link + error handling | ✅ Done | Random 7-char slugs, publish toggle, `/tour/<slug>` pretty URLs |
| 7 | Deploy (Pages + cloud stitching worker) | 🔴 Blocked | Workflows written; needs `gh auth login` and Actions secrets |
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

- [x] **Step 1 — Repo skeleton.** `git init`, `.gitignore`, `.gitattributes`, README, LICENSE,
      THIRD_PARTY_LICENSES, this file. *(Milestone 0)*
- [ ] **Step 2 — GitHub.** `gh` 2.98 installed. **Waiting on `gh auth login`**, then repo creation,
      push, and enabling Pages.
- [x] **Step 3 — Static site + demo mode.** Whole `web/` app built and serving. *(Milestones 2, 5, 6)*
- [x] **Step 4a — Supabase code.** `schema.sql`, storage buckets, RLS, job-queue functions, and the
      studio UI that drives them. Project URL + anon key wired into `web/js/config.js`.
- [ ] **Step 4b — Apply the schema.** Yours: run `supabase/schema.sql`. *(Milestones 3, 4)*
- [x] **Step 5a — Stitcher code.** Upstream pinned as a submodule, wrapper + phone-tuned config written.
- [ ] **Step 5b — Run a real stitch.** Blocked on Python 3.12 and a test video. *(Milestone 1)*
- [x] **Step 6a — Worker code.** `worker.py` + `run_local.ps1`, atomic claim/complete/fail.
- [ ] **Step 6b — Prove the loop.** Upload in the studio → stitch locally → panorama in the tour.
- [x] **Step 7 — Share links + polish.** Slugs, publish toggle, `404.html` rewrite, friendly failure copy.
- [x] **Step 8a — Cloud worker workflow.** `stitch-worker.yml` written.
- [ ] **Step 8b — Enable it.** Add the two Actions secrets. *(Milestone 7)*

---

## 3. What only you can do

I cannot create accounts, complete interactive logins, or hold your credentials. These are yours,
in the order that unblocks the most:

| # | Action | Blocks | Cost | Done? |
|---|---|---|---|---|
| 1 | **Run `gh auth login`** in a terminal, pick GitHub.com → HTTPS → browser. Then tell me, and I'll create the public repo, push, and turn on Pages. | Step 2, live URL | free | ⬜ |
| 2 | **Run `supabase/schema.sql`** in the [SQL editor](https://supabase.com/dashboard/project/ikuovilpewamyareelqm/sql). Walkthrough: [`supabase/README.md`](supabase/README.md). | Steps 4b, 6b | free | ⬜ |
| 3 | **Install Python 3.12** from [python.org](https://www.python.org/downloads/) — tick *"Add python.exe to PATH"*. The `python` on your PATH today is the Microsoft Store stub, not an interpreter. Then run `./scripts/bootstrap.ps1`. | Steps 5b, 6b | free | ⬜ |
| 4 | **Copy the `service_role` key** from Project Settings → API into a local `.env` (start from `.env.example`). | Step 6b | free | ⬜ |
| 5 | **Record a test room video** — slow, steady full turn, 20–30 s, phone at chest height, generous overlap. Include furniture and edges, not just bare wall. | Step 5b | free | ⬜ |
| 6 | **Add Actions secrets** `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (repo Settings → Secrets and variables → Actions). | Step 8b | free | ⬜ |
| 7 | *Optional:* install ffmpeg; *optional:* buy a domain for a nicer share URL. | polish | ~$12/yr | ⬜ |

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

**R3 — Stitch quality is the real unknown.** Feature-based stitching of a handheld pan can fail on
blank walls, low light, or a fast pan. Milestone 1 exists to find those limits before more is built
on top. `hfov_deg` is the first knob to turn; findings go in section 6.

**R4 — Actions runners are CPU-only.** Fine at 4096 px, but if stitching turns out slow the fallback
is a free Hugging Face Space running the same `worker.py`.

**Open question — how does a seller get pin positions right?** Right now they click the plan and
drag to adjust, and `heading_offset` rotates the doorway arrows by hand. If that proves fiddly with
a real listing, the next idea is to derive heading from the panorama itself.

---

## 6. Stitching tuning notes

_Empty until Milestone 1 runs on a real clip._

Starting point in [`stitcher/config.template.yaml`](stitcher/config.template.yaml), and why each
value differs from upstream's tripod-photo defaults:

| Setting | Ours | Upstream | Reason |
|---|---|---|---|
| `intrinsics.hfov_deg` | 64 | 42 | Phone *video* is cropped versus stills. **The first knob to turn.** Panorama repeats itself → lower it; doesn't close → raise it. |
| `video_extraction.method` | `uniform` (48 frames) | `interval` (every 2nd) | A 25 s clip at 30 fps would give ~375 frames — minutes of matching for no gain. Fixed count keeps runtime predictable. |
| `matching.match_full_res` | `false` @ 1280 px | `true` | Video frames are softer than stills; matching at 1280 is nearly as accurate and several times faster. |
| `matching.min_inliers` | 90 | 200 | 200 is a high bar for a plain painted wall. |
| `matching.use_clahe` | `true` | `false` | Buys back features in dim rooms. |
| `disable_circular_closure` | `false` | `true` | A room pan should return to its start; detecting that cancels drift. |
| `blending.method` | `multiband` | `none` | Auto-exposure always shifts when panning past a window; `none` leaves visible steps. |

To record: actual runtime per clip, minimum usable length, whether 48 frames is enough, and the
failure modes worth reporting back to the seller.

---

## 7. Changelog

- **2026-08-22** — Project bootstrapped from `home-tour-app-claude-code-brief.md`. Researched the
  hosting constraints (Pages is static-only and needs a public repo on the free plan) and settled on
  browser → Supabase → offline-worker. Built the full static site including an offline demo tour,
  the Supabase schema with an atomic job queue, the stitcher wrapper over a pinned upstream
  submodule, the worker, and both GitHub Actions workflows. Supabase project created and its anon
  key wired in. First commit made; repo not yet pushed.
