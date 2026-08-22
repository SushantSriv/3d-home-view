#!/usr/bin/env python3
"""
Stitching worker: claim a queued room video, turn it into a panorama, publish it.

One script, two runners:

    python worker/worker.py --loop        on your machine, while you work
    python worker/worker.py --once        one cycle, which is what CI invokes

Nothing else in the system moves a job between states -- the browser only ever
enqueues, and the database functions (claim_next_job / complete_job / fail_job)
make each transition atomic. That is what lets a laptop and a GitHub Actions run
poll the same queue without ever grabbing the same video.

Requires SUPABASE_URL and SUPABASE_SERVICE_KEY. The service key bypasses row
level security, so it lives in .env or in Actions secrets and nowhere else.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path

from dotenv import load_dotenv
from supabase import Client, create_client

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from stitcher.stitch_room import StitchError, stitch  # noqa: E402

BUCKET_VIDEOS = "raw-videos"
BUCKET_PANORAMAS = "panoramas"


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    return default if raw is None else raw.strip().lower() in {"1", "true", "yes", "on"}


def connect() -> Client:
    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()

    if not url or not key:
        sys.exit(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.\n"
            "Locally:  copy .env.example to .env and fill it in (see supabase/README.md).\n"
            "In CI:    add them as repository secrets."
        )
    # A pasted anon key here would fail later with a confusing row-level-security
    # error, so catch the mix-up now while the cause is still obvious.
    if '"role":"anon"' in key or "InFub24i" in key:
        sys.exit(
            "That looks like the anon key, not the service_role key. The worker needs the "
            "service_role key from Project Settings -> API."
        )
    return create_client(url, key)


# --------------------------------------------------------------------- one job


def claim(sb: Client) -> dict | None:
    rows = sb.rpc("claim_next_job", {}).execute().data
    if not rows:
        return None
    row = rows[0] if isinstance(rows, list) else rows
    return {
        "video_id": row["j_video_id"],
        "room_id": row["j_room_id"],
        "property_id": row["j_property_id"],
        "room_label": row["j_room_label"],
        "video_path": row["j_video_path"],
    }


def process(sb: Client, job: dict, *, delete_source: bool, keep_output: bool) -> None:
    label = job["room_label"]
    print(f"\n=== {label} ({job['video_path']})", flush=True)

    workdir = Path(tempfile.mkdtemp(prefix="tour-stitch-"))
    try:
        local_video = workdir / Path(job["video_path"]).name
        print(f"[worker] downloading {job['video_path']}", flush=True)
        local_video.write_bytes(sb.storage.from_(BUCKET_VIDEOS).download(job["video_path"]))

        result = stitch(local_video, workdir / "out")

        # Overwrite the same key each time so re-stitching a room replaces its
        # panorama instead of quietly leaving orphans on the 1 GB free tier.
        dest = f"{job['property_id']}/{job['room_id']}.jpg"
        print(f"[worker] uploading {dest}", flush=True)
        sb.storage.from_(BUCKET_PANORAMAS).upload(
            dest,
            result.panorama.read_bytes(),
            {"content-type": "image/jpeg", "cache-control": "3600", "upsert": "true"},
        )

        sb.rpc("complete_job", {"job_id": job["video_id"], "panorama_path": dest}).execute()
        print(f"[worker] DONE {label} -> {dest}", flush=True)

        if delete_source:
            # Off by default. The raw video is the biggest consumer of the free
            # storage tier, but while the pipeline is still being tuned it is the
            # only way to re-stitch a room with different settings - and throwing
            # it away the moment a mediocre panorama appears is how you end up
            # asking the seller to walk round the house again.
            sb.storage.from_(BUCKET_VIDEOS).remove([job["video_path"]])
            print("[worker] removed source video", flush=True)

    except StitchError as err:
        print(f"[worker] FAILED {label}: {err}", flush=True)
        sb.rpc("fail_job", {"job_id": job["video_id"], "reason": str(err)}).execute()

    except Exception:
        detail = traceback.format_exc()
        print(f"[worker] ERROR {label}\n{detail}", flush=True)
        sb.rpc(
            "fail_job",
            {"job_id": job["video_id"], "reason": f"Worker error:\n{detail[-1500:]}"},
        ).execute()

    finally:
        if keep_output:
            print(f"[worker] left working files in {workdir}", flush=True)
        else:
            _rmtree_quietly(workdir)


def _rmtree_quietly(path: Path) -> None:
    import shutil

    # On Windows a virus scanner can still hold a frame open for a moment; a failed
    # cleanup of a temp directory must never take the worker down.
    shutil.rmtree(path, ignore_errors=True)


# ----------------------------------------------------------------------- loops


def run_once(sb: Client, **kw) -> bool:
    job = claim(sb)
    if job is None:
        return False
    process(sb, job, **kw)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Claim and stitch queued room videos.")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="drain the queue, then exit (CI default)")
    mode.add_argument("--loop", action="store_true", help="keep polling until interrupted")
    ap.add_argument("--interval", type=int, default=int(os.environ.get("WORKER_POLL_INTERVAL", 15)),
                    help="seconds between polls in --loop mode")
    ap.add_argument("--max-jobs", type=int, default=int(os.environ.get("WORKER_MAX_JOBS", 5)),
                    help="stop after this many jobs in --once mode, to bound a CI run")
    ap.add_argument("--keep-output", action="store_true", help="do not delete the temp working dir")
    ap.add_argument("--keep-source", action="store_true", help="do not delete the video after stitching")
    args = ap.parse_args()

    sb = connect()
    opts = {
        "delete_source": not args.keep_source and env_flag("WORKER_DELETE_SOURCE", False),
        "keep_output": args.keep_output,
    }

    if args.loop:
        print(f"[worker] polling every {args.interval}s. Ctrl+C to stop.", flush=True)
        idle_announced = False
        try:
            while True:
                if run_once(sb, **opts):
                    idle_announced = False
                else:
                    if not idle_announced:
                        print("[worker] queue empty, waiting...", flush=True)
                        idle_announced = True
                    time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\n[worker] stopped.", flush=True)
        return 0

    done = 0
    while done < args.max_jobs and run_once(sb, **opts):
        done += 1
    print(f"[worker] processed {done} job(s).", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
