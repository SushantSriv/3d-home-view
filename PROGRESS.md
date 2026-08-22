# Progress & Plan

**Last updated:** 2026-08-22 · **Live site:** _not deployed yet_ · **Supabase:** _not created yet_

This file is the single source of truth for where the project stands. It is updated in the same
commit as the work it describes.

---

## 1. Milestone board

| # | Milestone | Status | Notes |
|---|---|---|---|
| 0 | Repo, README, licenses, progress tracking | 🟡 In progress | This commit |
| 1 | Stitching pipeline proof of concept | ⬜ Blocked | Needs **Python 3.12** installed → [action #1](#3-what-only-you-can-do) |
| 2 | Basic 360° viewer (Pannellum) | ⬜ Not started | Demo mode proves this with no backend |
| 3 | Upload flow (video → stitch → panorama URL) | ⬜ Blocked | Needs Supabase → [action #3](#3-what-only-you-can-do) |
| 4 | Floor plan + click-to-place pins | ⬜ Blocked | Needs Supabase |
| 5 | Connected viewer (floor plan ↔ 360° rooms) | ⬜ Not started | Demo mode proves this first |
| 6 | Shareable public link + error handling | ⬜ Not started | |
| 7 | Deploy (Pages + cloud stitching worker) | ⬜ Not started | |
| 8 | *Added:* studio authentication | ⬜ Deferred | See [risk R1](#5-risks--open-questions) |

Legend: ✅ done · 🟡 in progress · ⬜ not started · 🔴 blocked on someone else

---

## 2. Execution steps

Ordered so that something visible works as early as possible. Each step ends in a commit.

- [ ] **Step 1 — Repo skeleton.** `git init`, `.gitignore`, `README`, `LICENSE`,
      `THIRD_PARTY_LICENSES`, this file. *(Milestone 0)*
- [ ] **Step 2 — GitHub.** Install `gh`, you authenticate, create the public repo, push, turn on Pages.
- [ ] **Step 3 — Static site + demo mode.** Full `web/` app with a browser-generated demo panorama.
      Gives a live public URL before Python or Supabase exist. *(Milestones 2, 5)*
- [ ] **Step 4 — Supabase wiring.** `schema.sql`, buckets, real studio flow. *(Milestones 3, 4)*
- [ ] **Step 5 — Stitcher.** Submodule + wrapper + tuning on a real phone video. *(Milestone 1)*
- [ ] **Step 6 — Local worker.** Closes the loop: upload in browser → stitch on your PC → panorama
      appears in the tour. *(Milestone 3)*
- [ ] **Step 7 — Share links + polish.** Slugs, publish toggle, pretty URLs, friendly failure copy.
      *(Milestone 6)*
- [ ] **Step 8 — Cloud worker.** Actions cron runs the same worker; your PC no longer needed.
      *(Milestone 7)*

---

## 3. What only you can do

I cannot create accounts, complete interactive logins, install to system PATH reliably, or hold your
credentials. These are yours:

| # | Action | Blocks | Cost | Done? |
|---|---|---|---|---|
| 1 | **Install Python 3.12** from [python.org](https://www.python.org/downloads/) — tick *"Add python.exe to PATH"*. The `python` on your PATH today is the Microsoft Store stub, which is not a real interpreter. | Steps 5–8 | free | ⬜ |
| 2 | **Run `gh auth login`** once in a terminal (interactive browser flow — I cannot do it for you). | Step 2 | free | ⬜ |
| 3 | **Create a Supabase project**, run `supabase/schema.sql` in the SQL editor, create the 3 storage buckets, then give me the **Project URL** and **anon key**. Walkthrough: `supabase/README.md`. | Steps 4, 6 | free | ⬜ |
| 4 | **Record a test room video** — slow, steady 360° pan, ~20–30 s, generous overlap between frames. Save it somewhere outside the repo. | Step 5 | free | ⬜ |
| 5 | **Add Actions secrets** `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in repo Settings → Secrets → Actions. The service key must **never** be committed. | Step 8 | free | ⬜ |
| 6 | *Optional:* install `ffmpeg` (better video decoding coverage than OpenCV alone). | polish | free | ⬜ |
| 7 | *Optional:* buy a domain if you want a nicer share URL than `*.github.io`. | polish | ~$12/yr | ⬜ |

### The anon key vs. the service key

The **anon key** is designed to be public — it ships in the browser and belongs in `web/js/config.js`,
committed. The **service key** bypasses all security rules; it goes in your local `.env` and in
GitHub Actions secrets, and never anywhere else.

---

## 4. Decisions made

| Decision | Choice | Why |
|---|---|---|
| Hosting | Public GitHub repo → GitHub Pages | Pages on a free account requires a public repo. Also unlocks unlimited Actions minutes, which become our free stitching worker. |
| Stitching compute | Local first, identical script on Actions later | Fastest route to a first real panorama; promoting to cloud is adding a secret, not rewriting code. |
| Frontend | Plain HTML/CSS/ES modules, no build step | Matches the brief, keeps Pages deployment trivial, nothing to break. |
| Backend API | **None** | The browser talks to Supabase directly, so there is no server to host or pay for. |
| Studio auth | None, for now | Your call — pet-project speed. See risk R1. |
| Upstream stitcher | Pinned git submodule, unmodified | Keeps the MIT boundary clean and lets you pull upstream fixes. Our tuning lives in `stitcher/config.template.yaml`. |
| Pin coordinates | Normalized 0–1, not pixels | Floor plan stays correct at any screen size. |

---

## 5. Risks & open questions

**R1 — No auth on a public studio page.** The site is public, the Supabase anon key is public, and
there is no login, so anyone who finds `studio.html` can create or delete tours. Accepted
deliberately for now. Mitigations in place: a `DEPLOY_STUDIO` flag in the Pages workflow lets you
drop the studio from the public site with a one-line change, and Milestone 8 adds Supabase
magic-link auth when this stops being a pet project.

**R2 — Free-tier ceilings.**
- Supabase **pauses a project after 7 days with no activity** (one click to resume, data is kept).
- Supabase free: 500 MB database, **1 GB storage**, 5 GB egress/month. Raw videos will exhaust
  storage first, so the worker **deletes the source video after a successful stitch**.
- GitHub Pages: 1 GB site, 100 GB/month bandwidth (soft). Panoramas are the heavy asset here.
- GitHub Actions: unlimited on public repos. Actions cron can be delayed by several minutes under
  load — fine for this workload.

**R3 — Stitch quality is the real unknown.** Feature-based stitching of a handheld pan can fail on
blank walls, low light, or a fast pan. Milestone 1 exists specifically to find the tuning limits
before anything is built on top. Findings get recorded in section 6.

**R4 — Actions runners are CPU-only and time-limited** (6 h/job, far more than needed). If stitching
turns out to be slow, the fallback is a free Hugging Face Space instead of Actions — same worker code.

---

## 6. Stitching tuning notes

_Empty until Milestone 1 runs. Will record: frame extraction rate, minimum usable video length,
required overlap between frames, output resolution, per-video runtime, and known failure modes._

---

## 7. Changelog

- **2026-08-22** — Project bootstrapped from `home-tour-app-claude-code-brief.md`. Researched hosting
  constraints (Pages is static-only and needs a public repo on the free plan), chose the
  browser→Supabase→offline-worker architecture, wrote repo skeleton and this plan.
