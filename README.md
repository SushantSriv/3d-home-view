# 360° Home Tour

A free web app for property sellers and brokers (*meglere*). Record one slow phone pan per room,
upload it with a floor plan, and the app stitches each video into a 360° panorama and links them
into one navigable tour behind a single shareable URL.

**Buyers need no login and no app** — just the link.

> This is **not** a continuous 3D scan like Matterport. It is multiple linked 360° panoramas, one
> per room, navigated via the floor plan.

---

## Try it right now

The viewer works with **no backend, no Python and no account** thanks to a built-in demo tour that
generates its panoramas in the browser:

```
https://<your-github-username>.github.io/3d-home-view/tour.html?demo=1
```

Locally:

```powershell
npx --yes serve web
# then open http://localhost:3000/tour.html?demo=1
```

---

## How it works

```
Browser (GitHub Pages, static)        Supabase (free tier)         Worker (your PC, later CI)
  studio.html  ──── upload ────▶  Storage: raw-videos  ──poll──▶  claim job
    floor plan, pins, videos           floor-plans                 stitch panorama
  tour.html    ◀─── read ──────  Postgres: properties  ◀─write──   upload result
    floor plan + Pannellum                rooms                    mark done
                                          room_videos
```

Nothing of ours runs 24/7. The static site talks to Supabase directly; only the stitching job needs
real compute, and that runs on your machine (or a GitHub Actions cron) rather than a paid server.

## Repository layout

| Path | What it is |
|---|---|
| `web/` | The entire static site. No build step — deployed byte-for-byte to GitHub Pages. |
| `supabase/` | `schema.sql` (tables, RLS, storage buckets) plus a click-by-click setup guide. |
| `stitcher/` | Thin wrapper that turns a room video into `panorama.jpg` via the upstream pipeline. |
| `worker/` | Claims a queued video, stitches it, uploads the panorama, marks the job done. |
| `third_party/` | Pinned submodule of the upstream stitching pipeline. Not modified by us. |
| `scripts/` | `bootstrap.ps1` — virtualenv, dependencies, submodule, environment doctor. |
| `.github/workflows/` | Pages deploy, and the cloud stitching worker. |

## Getting set up

```powershell
git clone --recurse-submodules https://github.com/<you>/3d-home-view.git
cd 3d-home-view
./scripts/bootstrap.ps1     # checks your tooling, creates .venv, installs deps
```

Then follow [`supabase/README.md`](supabase/README.md) to create the free database, and paste your
project URL and anon key into `web/js/config.js`.

**Current status, the milestone board, and the list of things only you can do live in
[PROGRESS.md](PROGRESS.md).** Start there.

## Cost

Everything runs on free tiers: GitHub Pages (static hosting), GitHub Actions (unlimited minutes on
public repos), Supabase (500 MB database, 1 GB storage, 5 GB egress). The only optional cost is a
custom domain, roughly $12/year. No paid APIs are used anywhere in the pipeline.

## Licenses

The original code here is **not** open source — see [LICENSE](LICENSE). It is publicly visible only
because GitHub Pages on a free account requires a public repository. It is built on MIT-licensed
components (Pannellum, Kronbii/360-spherical-stitching, supabase-js) whose attributions are kept in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
