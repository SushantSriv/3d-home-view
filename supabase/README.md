# Supabase setup

Project already created: **`ikuovilpewamyareelqm`**
Dashboard: <https://supabase.com/dashboard/project/ikuovilpewamyareelqm>
API URL: `https://ikuovilpewamyareelqm.supabase.co` (already wired into `web/js/config.js`)

Three things still need doing, and only you can do them.

---

## 1. Run the schema  *(2 minutes)*

1. Open **SQL Editor** in the dashboard.
2. Paste the entire contents of [`schema.sql`](schema.sql) and press **Run**.
3. You should see a notice like `Schema applied. Buckets: floor-plans, panoramas, raw-videos`.

The script is idempotent — re-run it any time; it will not delete data.

### If the storage-policy block fails

Some projects do not let the SQL editor create policies on `storage.objects`. The script catches
that and prints `Skipped storage policies (insufficient privilege)`. If you see that notice, create
them by hand under **Storage → Policies**:

| Bucket | Policy | Operation | Roles | Rule |
|---|---|---|---|---|
| `floor-plans` | public read | SELECT | `anon`, `authenticated` | `true` |
| `floor-plans` | anon write | INSERT, UPDATE, DELETE | `anon`, `authenticated` | `true` |
| `panoramas` | public read | SELECT | `anon`, `authenticated` | `true` |
| `panoramas` | anon write | INSERT, UPDATE, DELETE | `anon`, `authenticated` | `true` |
| `raw-videos` | upload only | INSERT | `anon`, `authenticated` | `true` |

`raw-videos` deliberately gets **no** SELECT policy — the browser can drop a video in but never read
one back. Only the worker's service key can, and it bypasses policies entirely.

## 2. Confirm the buckets exist  *(30 seconds)*

**Storage** should list exactly three buckets:

| Bucket | Public | Size limit | Holds |
|---|---|---|---|
| `floor-plans` | yes | 15 MB | uploaded floor plan images |
| `panoramas` | yes | 30 MB | stitched equirectangular output |
| `raw-videos` | **no** | 200 MB | source clips, deleted after a successful stitch |

`schema.sql` creates them, so this is just a check.

## 3. Copy the service key into your local `.env`  *(1 minute)*

**Project Settings → API → `service_role` key.**

```powershell
copy .env.example .env
# then edit .env and paste the key into SUPABASE_SERVICE_KEY
```

`.env` is gitignored. **The service key bypasses every security rule in this schema** — it must
never be committed, never be pasted into anything under `web/`, and never be shared. If it ever
leaks, rotate it from the same dashboard page.

The **anon** key is the opposite: it is meant to be public, ships in every browser, and is already
committed in `web/js/config.js`. That is normal and correct.

---

## What the schema sets up

**Tables**

- `properties` — one row per home. `share_slug` is the random 7-character id in the public URL.
- `rooms` — one row per room. `pin_x`/`pin_y` are normalised 0–1 positions on the floor plan, so
  pins stay put at any screen size. `heading_offset` rotates the doorway arrows when the panorama's
  "north" does not match the plan.
- `room_videos` — the stitching queue. `processing_status` moves `queued → processing → done|failed`.

**Functions** (worker-only, `service_role` execute grant)

- `claim_next_job()` — atomically takes the oldest queued job with `FOR UPDATE SKIP LOCKED`, so your
  laptop and a GitHub Actions run can never grab the same video. Also re-claims anything stuck in
  `processing` for over 30 minutes, so a worker that crashes mid-stitch does not wedge the queue.
- `complete_job(job_id, panorama_path)` — writes the panorama onto the room and closes the job.
- `fail_job(job_id, reason)` — records why, which the studio shows back to the seller.

**Row-level security** — the `anon` role has full read/write. This app has no login by design, so
anyone with the studio URL can create or delete tours. See risk **R1** in [`../PROGRESS.md`](../PROGRESS.md)
for the mitigation and the upgrade path.

---

## Free-tier things that will bite you

- **Projects pause after 7 days with no activity.** The app will fail with "cannot reach the
  database" until you press **Resume** in the dashboard. Data is kept.
- **1 GB of storage total.** Room videos are by far the largest objects, which is why the worker
  deletes each source video once its stitch succeeds (`WORKER_DELETE_SOURCE=true`).
- **5 GB egress per month.** Panoramas are ~2–4 MB each; a tour viewed a few hundred times is fine.
- **500 MB database.** This schema stores paths and text only, so it will never be the constraint.
