#!/usr/bin/env python3
"""
Turn one room video into one equirectangular panorama.

A thin wrapper around Kronbii/360-spherical-stitching (MIT), which lives
unmodified as a git submodule in third_party/. All of our tuning lives in
config.template.yaml so that the upstream tree stays pristine and can be
updated with a plain `git submodule update --remote`.

Usage:
    python stitcher/stitch_room.py --video kitchen.mp4 --out out/kitchen
    python stitcher/stitch_room.py --video kitchen.mp4 --out out/kitchen --hfov 70 --frames 60

Then eyeball the result:
    npx serve web
    http://localhost:3000/tour.html?pano=<url of the panorama>
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = REPO_ROOT / "third_party" / "360-spherical-stitching"
TEMPLATE = Path(__file__).resolve().parent / "config.template.yaml"

# The upstream pipeline prints check marks and degree signs. A Windows console
# defaults to cp1252, which cannot encode them, and the resulting
# UnicodeEncodeError would kill a stitch that had already succeeded. Take the
# replacement characters instead.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):  # already wrapped, or not a real stream
        pass

# Below this, a pan simply has not covered enough angle to close a sphere.
MIN_USEFUL_SECONDS = 8.0

# Field of view along the phone's LONG sensor axis, in degrees. Roughly right for
# the main rear camera of recent iPhone and Pixel models in video mode. The short
# axis follows from the frame's aspect ratio -- see horizontal_fov().
LONG_AXIS_FOV_DEG = 64.0


def horizontal_fov(width: int, height: int, long_axis_fov: float = LONG_AXIS_FOV_DEG) -> float:
    """
    Horizontal field of view of a frame, given the sensor's long-axis FOV.

    This has to be derived per video, not configured once. A seller holding the
    phone upright produces a 1080x1920 frame whose HORIZONTAL field is only ~39
    degrees, while the same phone held sideways gives ~64. Feed the pipeline the
    landscape number for a portrait clip and it thinks each frame is wider than it
    is, spaces them too far apart, and reports ~393 degrees of rotation for what
    was one full turn -- which shows up as a duplicated seam.
    """
    focal = (max(width, height) / 2) / math.tan(math.radians(long_axis_fov) / 2)
    return math.degrees(2 * math.atan((width / 2) / focal))


class StitchError(RuntimeError):
    """Raised with a message meant to be shown to the seller, not to a developer."""


@dataclass
class StitchResult:
    panorama: Path
    output_dir: Path
    frames_used: int
    seconds: float


# --------------------------------------------------------------------- checks


def _require_upstream() -> Path:
    run_py = UPSTREAM / "run.py"
    if not run_py.exists():
        raise StitchError(
            f"The stitching pipeline is missing at {UPSTREAM}.\n"
            "Fetch it with:  git submodule update --init --recursive\n"
            "(or run scripts/bootstrap.ps1, which does that and installs dependencies)"
        )
    return run_py


def probe_video(path: Path) -> tuple[float, int, tuple[int, int]]:
    """Duration, frame count and resolution, via OpenCV so we need no ffmpeg binary."""
    import cv2  # imported late: a missing OpenCV should surface as a setup error, not an import crash

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise StitchError(
            f"Could not open {path.name}. Unsupported codec, or the file is truncated. "
            "MP4 (H.264) and MOV from an iPhone both work."
        )
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    size = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    cap.release()

    seconds = frames / fps if fps > 0 else 0.0
    if frames <= 0 or size[0] <= 0:
        raise StitchError(f"{path.name} contains no readable video frames.")
    return seconds, frames, size


# ---------------------------------------------------------------------- config


def build_config(video: Path, out_dir: Path, overrides: dict) -> Path:
    """Render the template to a concrete config file inside the output directory."""
    cfg = yaml.safe_load(TEMPLATE.read_text(encoding="utf-8"))

    # Upstream resolves relative paths against the working directory, which differs
    # between a local run and a CI run. Absolute paths remove the ambiguity.
    cfg["video"] = str(video.resolve())
    cfg["output_dir"] = str(out_dir.resolve())

    if overrides.get("hfov") is not None:
        cfg["intrinsics"]["hfov_deg"] = overrides["hfov"]
    if overrides.get("frames") is not None:
        cfg["video_extraction"]["num_frames"] = overrides["frames"]
    if overrides.get("width") is not None:
        cfg["output"]["pano_width"] = overrides["width"]
    if overrides.get("smoothing") is not None:
        cfg["matching"]["rotation_smoothing_window"] = overrides["smoothing"]
    if overrides.get("no_closure"):
        cfg["matching"]["disable_circular_closure"] = True
    if overrides.get("debug"):
        cfg["debug"]["enabled"] = True
        cfg["debug"]["save_matches"] = True

    out_dir.mkdir(parents=True, exist_ok=True)
    # Absolute, because the subprocess runs with cwd set to the upstream directory.
    path = (out_dir / "stitch-config.yaml").resolve()
    path.write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")
    return path


# ------------------------------------------------------------------- pipeline


def stitch(video: Path, out_dir: Path, **overrides) -> StitchResult:
    """
    Stitch one video. Raises StitchError with a message safe to show a seller.

    Used both by the CLI below and by worker/worker.py.
    """
    run_py = _require_upstream()
    video = Path(video)
    out_dir = Path(out_dir)

    if not video.exists():
        raise StitchError(f"No such video: {video}")

    seconds, frames, (w, h) = probe_video(video)
    if seconds and seconds < MIN_USEFUL_SECONDS:
        raise StitchError(
            f"That clip is only {seconds:.0f} seconds long. A pan that short cannot cover a whole "
            "room with enough overlap between frames. Re-record a slow, steady full turn of "
            "20-30 seconds, keeping the phone at chest height."
        )

    # Derive the field of view from the frame shape unless told otherwise. This is
    # what makes a portrait clip stitch correctly without the seller knowing anything.
    if overrides.get("hfov") is None:
        overrides = {**overrides, "hfov": round(horizontal_fov(w, h), 2)}
        orientation = "portrait" if h > w else "landscape"
        print(f"[stitch] {orientation} frame -> horizontal fov {overrides['hfov']} deg", flush=True)

    print(f"[stitch] {video.name}: {seconds:.1f}s, {frames} frames, {w}x{h}", flush=True)

    config_path = build_config(video, out_dir, overrides)

    # Remove any previous result first. Success is judged by "a panorama exists"
    # below, so a leftover file from an earlier run would be reported as a fresh
    # success for a stitch that actually failed.
    stale = _find_panorama(out_dir)
    if stale is not None:
        stale.unlink()

    # Run upstream as a subprocess rather than importing it: it manipulates sys.path
    # and configures the root logger, neither of which we want leaking into a
    # long-lived worker process.
    # Force UTF-8 on the child too. Upstream's final success line contains a check
    # mark, and on a cp1252 Windows console that raises inside the pipeline *after*
    # it has already written the panorama -- turning a successful stitch into a
    # non-zero exit code.
    child_env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}

    proc = subprocess.run(
        [sys.executable, str(run_py), str(config_path)],
        cwd=str(UPSTREAM),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=child_env,
    )
    if proc.stdout:
        print(proc.stdout, flush=True)

    # Judge on the artefact, not the exit code. Upstream can die on a cosmetic
    # final print long after the panorama is safely on disk, and throwing away a
    # good stitch over that would be absurd.
    panorama = _find_panorama(out_dir)
    if panorama is None:
        raise StitchError(_explain_failure(proc.stdout, proc.stderr))
    if proc.returncode != 0:
        print(
            f"[stitch] pipeline exited {proc.returncode} but wrote a panorama; keeping it.",
            flush=True,
        )

    used = len(list((out_dir / "frames").glob("*"))) if (out_dir / "frames").exists() else 0
    print(f"[stitch] wrote {panorama} ({panorama.stat().st_size / 1e6:.1f} MB)", flush=True)
    return StitchResult(panorama=panorama, output_dir=out_dir, frames_used=used, seconds=seconds)


def _find_panorama(out_dir: Path) -> Path | None:
    for name in ("panorama.jpg", "panorama.png", "panorama.webp"):
        p = out_dir / name
        if p.exists():
            return p
    # Upstream may version the filename; fall back to the newest image that is not a frame.
    candidates = [
        p for p in out_dir.glob("*.*")
        if p.suffix.lower() in {".jpg", ".jpeg", ".png"} and p.parent == out_dir
    ]
    return max(candidates, key=lambda p: p.stat().st_mtime) if candidates else None


def _explain_failure(stdout: str, stderr: str) -> str:
    """
    Map the pipeline's internal errors onto something a seller can act on. The raw
    log is still appended, because when the mapping is wrong that is all we have.
    """
    blob = f"{stdout}\n{stderr}"
    low = blob.lower()

    if "min_inliers" in low or "not enough" in low or "insufficient" in low or "inliers" in low:
        hint = (
            "Not enough matching detail between consecutive frames. This usually means the pan was "
            "too fast, or the room has large blank surfaces. Re-record more slowly, and include some "
            "furniture or edges in the frame rather than only bare walls."
        )
    elif "no module named 'cv2'" in low or "no module named" in low:
        hint = (
            "A Python dependency is missing. Run scripts/bootstrap.ps1, or "
            "pip install -r stitcher/requirements.txt inside the virtualenv."
        )
    elif "could not read video" in low or "codec" in low:
        hint = "The video could not be decoded. Re-export it as MP4 (H.264) and try again."
    elif "memoryerror" in low or "out of memory" in low or "cannot allocate" in low:
        hint = (
            "Ran out of memory. Lower the output size with --width 2048, or use fewer frames "
            "with --frames 32."
        )
    else:
        hint = "Stitching failed. The pipeline log follows."

    tail = "\n".join(blob.strip().splitlines()[-25:])
    return f"{hint}\n\n--- pipeline log (last lines) ---\n{tail}"


# ------------------------------------------------------------------------ CLI


def main() -> int:
    ap = argparse.ArgumentParser(description="Stitch one room video into a 360 panorama.")
    ap.add_argument("--video", required=True, type=Path, help="source clip (mp4/mov)")
    ap.add_argument("--out", required=True, type=Path, help="output directory")
    ap.add_argument("--hfov", type=float, help="camera horizontal FOV in degrees (default 64)")
    ap.add_argument("--frames", type=int, help="frames to extract (default 48)")
    ap.add_argument("--width", type=int, help="panorama width in pixels (default 4096)")
    ap.add_argument("--smoothing", type=int, help="rotation smoothing window (default 3)")
    ap.add_argument("--no-closure", action="store_true", help="the pan does not return to its start")
    ap.add_argument("--debug", action="store_true", help="save intermediate match visualisations")
    ap.add_argument("--clean", action="store_true", help="empty the output directory first")
    args = ap.parse_args()

    if args.clean and args.out.exists():
        shutil.rmtree(args.out)

    try:
        result = stitch(
            args.video, args.out,
            hfov=args.hfov, frames=args.frames, width=args.width,
            smoothing=args.smoothing,
            no_closure=args.no_closure, debug=args.debug,
        )
    except StitchError as err:
        print(f"\nFAILED\n{err}", file=sys.stderr)
        return 1

    print(f"\nOK  {result.panorama}")
    print(f"    preview it:  npx serve . -l 4173")
    print(f"    then open :  http://localhost:4173/web/tour.html?pano=/{result.panorama.as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
