# 360° Home Tour

A free web app for property sellers and agents (*meglere*). Photograph each room with your
phone's **Panorama mode**, upload the photos with a floor plan, mark where each room sits, and
get **one shareable link** to paste into a listing.

**Buyers need no login and no app** — just the link.

> Not a continuous 3D scan like Matterport. It is a set of linked 360° panoramas, one per room,
> navigated from the floor plan.

---

## Try it right now

The viewer runs with **no backend, no account and no Python**, because the demo tour generates
its panorama in the browser:

```
https://sushantsriv.github.io/3d-home-view/tour.html?demo=1
```

Locally:

```powershell
python -m http.server 8000 --directory web
# then open http://localhost:8000/tour.html?demo=1
```

---

## How it works

```
Browser (GitHub Pages, static)          Supabase (free tier)
  studio.html ──── upload ────────▶  Storage: panoramas, floor-plans
    floor plan, pins, photos                  raw-videos (legacy)
  tour.html   ◀─── read ──────────  Postgres: properties, rooms
    floor plan + Pannellum                     room_videos (legacy)
```

There is **no server of ours running anywhere**. The whole front end is static files, and the
browser talks to Supabase directly.

### Why a panorama photo rather than a video

The project originally stitched a slow phone video of each room into a panorama offline. That
path still exists (see *Legacy*), but it loses to two things phones are bad at: hand wobble, and
the camera not staying in one place. Your phone's own Panorama mode has neither problem — it has
the gyroscope, it runs optical flow live, and it blends column by column as you sweep. It is a
far better stitcher than anything we can run afterwards, and it has already run by the time the
file reaches us.

So a panorama photo needs **no stitching at all** — only a projection conversion, which is exact,
instant, and happens in the browser. No queue, no worker, no waiting.

### Partial panoramas are normal

A phone usually gives up somewhere around 200–270°, so one sweep rarely closes the circle. The
app measures what you actually captured, records it, and fences the viewer to that arc — so the
buyer sees the room you photographed and is stopped at the edge instead of dragging into a void.
You can also select **two overlapping sweeps at once** and they are joined automatically.

---

## Setting it up for yourself

You need a free Supabase project. `supabase/README.md` has the click-path; the short version:

1. Create a project, then run `supabase/schema.sql` in the SQL editor (safe to re-run).
2. Create three storage buckets: `panoramas`, `floor-plans`, `raw-videos`.
3. Put your project URL and **anon** key in `web/js/config.js`.

The anon key is **public by design** — it ships to every browser that loads the site, and what
protects the data is row-level security, not secrecy of that key. The `service_role` key is a
different thing entirely: it bypasses RLS, must never appear anywhere under `web/`, and is only
used by the optional Python worker. The Pages workflow fails the build if it finds one.

> **No login, by design.** Anyone with the studio URL can create and edit tours. That is a
> deliberate trade for a small project — see risk R1 in [PROGRESS.md](PROGRESS.md). Set
> `DEPLOY_STUDIO: false` in `.github/workflows/pages.yml` to keep the studio off the public site.

---

## Repository layout

```
web/                 the entire site — no build step, deployed byte-for-byte
  index.html           landing page
  studio.html          create and edit a tour
  tour.html            the public viewer
  css/app.css          the design system: tokens, components, both themes
  js/api.js            small hand-written Supabase client (see below)
  js/db.js             data layer
  js/pano.js           panorama import: HEIC decode, projection, sweep joining
  js/scale.js          real-world distances derived from the floor plane
  js/tour.js           viewer
  js/studio.js         editor
  js/floorplan.js      pin placement, shared by both
  js/demo.js           browser-generated demo tour, needs no backend
  vendor/              Pannellum, libheif, Instrument Sans — all self-hosted
supabase/schema.sql  tables, row-level security, buckets, job queue
stitcher/, worker/   the legacy video path (see below)
```

### No CDN, no runtime third parties

Everything the browser needs is served from the same origin. `web/js/api.js` is a small
PostgREST + Storage client written for this project rather than an import of `supabase-js` from
esm.sh — the library was only ever used for queries, one URL concatenation and one delete, since
uploads already go through raw XHR to get progress events. Importing it cost 186 kB across 14
cross-origin modules and, worse, meant that a bad day at the CDN made every published listing
link fail to load.

---

## Measuring the room

A single-viewpoint panorama records **directions, not distances** — nothing in the pixels says
whether a wall is two metres away or twenty. The floor rescues it: for a level camera at height
`h`, a floor point seen `φ` below the horizon is exactly `h / tan(φ)` away.

So the viewer's **Measure** button can put real distance rings on the floor and answer a tap with
a number. The one assumption is the camera height (1.45 m — chest height, which is what the
capture instructions ask for). Ten per cent wrong on that is ten per cent wrong on every
distance, which is what "roughly" buys.

One consequence worth knowing: the same geometry means a 68°-tall panorama **cannot see the floor
within about 2.1 m of where you stood**. You cannot see your own feet, so the rings start outside
that blind circle.

---

## Legacy: the video path

`stitcher/` and `worker/` implement the original pipeline — upload a slow 360° pan per room, and a
worker (your PC, or a GitHub Actions cron) stitches it into an equirectangular panorama with
[Kronbii/360-spherical-stitching](https://github.com/Kronbii/360-spherical-stitching).

It works, and the queue is still live, but it is **not the recommended path**: on real handheld
footage the results were consistently poor, which is what drove the move to panorama photos. It
is kept because the infrastructure exists and costs nothing. `scripts/bootstrap.ps1` sets up the
Python side if you want to try it.

Note that GitHub disables a repository's Actions cron after 60 days without activity.

---

## Credits

Built on [Pannellum](https://pannellum.org) and
[Kronbii/360-spherical-stitching](https://github.com/Kronbii/360-spherical-stitching), both MIT,
with HEIC decoding by [libheif](https://github.com/strukturag/libheif) (LGPL-3.0) and the
[Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans) typeface (OFL).
Full texts in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
