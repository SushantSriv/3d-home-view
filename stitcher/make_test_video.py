#!/usr/bin/env python3
"""
Generate a synthetic "phone pan of a room" video, with known ground truth.

Why this exists: the stitching pipeline is the riskiest part of the project, and
testing it should not require someone to walk into a room with a phone. This
builds a textured virtual room, renders the equirectangular panorama a perfect
camera would see, then re-renders that panorama as a handheld pan - complete with
pitch and roll wobble and exposure drift - and writes it out as MP4.

Feeding the result to stitch_room.py exercises the whole pipeline, and because we
kept the ground-truth panorama we can measure how close the reconstruction got
instead of squinting at it.

    python stitcher/make_test_video.py --out out/testroom
    python stitcher/stitch_room.py --video out/testroom/pan.mp4 --out out/testroom/stitched
    python stitcher/compare_panorama.py out/testroom/truth.jpg out/testroom/stitched/panorama.jpg
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np

# Room in metres. Camera sits at the centre, at chest height.
ROOM_W, ROOM_D, ROOM_H = 5.6, 4.4, 2.5
CAM_H = 1.5

SURFACES = ("north", "east", "south", "west", "floor", "ceiling")


# --------------------------------------------------------------- textures ---


def make_surface_texture(rng: np.random.Generator, kind: str, size=(768, 768)) -> np.ndarray:
    """
    A wall that is a flat colour gives ORB nothing to latch onto, and the stitch
    fails for reasons that have nothing to do with the code. So every surface gets
    a base tone plus a lot of hard-edged clutter - which is also what a real room
    full of furniture, sockets and picture frames actually provides.
    """
    h, w = size
    base = {
        "north": (205, 200, 190), "east": (196, 202, 208),
        "south": (188, 196, 186), "west": (210, 198, 200),
        "floor": (95, 120, 150), "ceiling": (240, 242, 245),
    }[kind]

    img = np.full((h, w, 3), base, dtype=np.uint8)
    img = img.astype(np.int16) + rng.integers(-8, 9, (h, w, 3))
    img = np.clip(img, 0, 255).astype(np.uint8)

    if kind == "floor":
        # Plank lines: strong, regular, high-contrast horizontal structure.
        for y in range(0, h, 48):
            cv2.line(img, (0, y), (w, y), (70, 90, 115), 2)
        for x in range(0, w, 160):
            cv2.line(img, (x, 0), (x, h), (78, 98, 122), 1)
        return img

    if kind == "ceiling":
        cv2.circle(img, (w // 2, h // 2), 40, (255, 250, 230), -1)
        cv2.circle(img, (w // 2, h // 2), 40, (200, 198, 190), 3)
        return img

    # Walls: skirting, a rail, then assorted "furniture and frames".
    cv2.rectangle(img, (0, int(h * 0.92)), (w, h), (235, 235, 235), -1)
    cv2.line(img, (0, int(h * 0.92)), (w, int(h * 0.92)), (120, 120, 120), 2)

    for _ in range(26):
        x, y = int(rng.integers(0, w - 60)), int(rng.integers(0, int(h * 0.9) - 60))
        rw, rh = int(rng.integers(30, 190)), int(rng.integers(30, 170))
        colour = tuple(int(c) for c in rng.integers(20, 235, 3))
        cv2.rectangle(img, (x, y), (min(x + rw, w), min(y + rh, h)), colour, -1)
        cv2.rectangle(img, (x, y), (min(x + rw, w), min(y + rh, h)), (30, 30, 30), 2)

    for _ in range(18):
        c = (int(rng.integers(0, w)), int(rng.integers(0, h)))
        cv2.circle(img, c, int(rng.integers(6, 26)), tuple(int(v) for v in rng.integers(0, 255, 3)), -1)

    cv2.putText(img, kind.upper(), (24, int(h * 0.86)), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (40, 40, 40), 4)
    return img


# ------------------------------------------------------- ground-truth pano ---


def render_truth_panorama(width: int, rng: np.random.Generator) -> np.ndarray:
    """
    Equirectangular view from the centre of the room.

    Convention, used identically by the renderer below:
        lon = (u/W - 0.5) * 2pi      x = sin(lon)cos(lat)
        lat = (0.5 - v/H) * pi       y = sin(lat)          (up)
                                     z = cos(lon)cos(lat)  (forward / north)
    """
    height = width // 2
    u = (np.arange(width) + 0.5) / width
    v = (np.arange(height) + 0.5) / height
    lon = (u - 0.5) * 2 * np.pi
    lat = (0.5 - v) * np.pi

    lon_g, lat_g = np.meshgrid(lon, lat)
    cos_lat = np.cos(lat_g)
    dx = np.sin(lon_g) * cos_lat
    dy = np.sin(lat_g)
    dz = np.cos(lon_g) * cos_lat

    # Distance along the ray to each of the six planes; negative or behind = invalid.
    def hit(numer, denom):
        with np.errstate(divide="ignore", invalid="ignore"):
            t = numer / denom
        return np.where((denom != 0) & (t > 1e-6), t, np.inf)

    candidates = {
        "north":   hit(ROOM_D / 2, dz),
        "south":   hit(-ROOM_D / 2, dz),
        "east":    hit(ROOM_W / 2, dx),
        "west":    hit(-ROOM_W / 2, dx),
        "ceiling": hit(ROOM_H - CAM_H, dy),
        "floor":   hit(-CAM_H, dy),
    }
    stack = np.stack([candidates[s] for s in SURFACES])
    which = np.argmin(stack, axis=0)
    t = np.min(stack, axis=0)

    px, py, pz = dx * t, dy * t, dz * t
    out = np.zeros((height, width, 3), dtype=np.uint8)

    # Per-surface local UV, then sample that surface's texture.
    local = {
        "north":   ((px + ROOM_W / 2) / ROOM_W, (ROOM_H - CAM_H - py) / ROOM_H),
        "south":   ((ROOM_W / 2 - px) / ROOM_W, (ROOM_H - CAM_H - py) / ROOM_H),
        "east":    ((ROOM_D / 2 - pz) / ROOM_D, (ROOM_H - CAM_H - py) / ROOM_H),
        "west":    ((pz + ROOM_D / 2) / ROOM_D, (ROOM_H - CAM_H - py) / ROOM_H),
        "floor":   ((px + ROOM_W / 2) / ROOM_W, (pz + ROOM_D / 2) / ROOM_D),
        "ceiling": ((px + ROOM_W / 2) / ROOM_W, (ROOM_D / 2 - pz) / ROOM_D),
    }

    for idx, name in enumerate(SURFACES):
        mask = which == idx
        if not mask.any():
            continue
        tex = make_surface_texture(rng, name)
        th, tw = tex.shape[:2]
        su, sv = local[name]
        xi = np.clip((su[mask] * tw).astype(np.int32), 0, tw - 1)
        yi = np.clip((sv[mask] * th).astype(np.int32), 0, th - 1)
        out[mask] = tex[yi, xi]

    # Vignette towards the poles, as a real lens stack would give.
    falloff = (0.72 + 0.28 * np.cos(lat_g * 0.9)).astype(np.float32)
    return np.clip(out * falloff[..., None], 0, 255).astype(np.uint8)


# ------------------------------------------------------------- pan render ---


def rotation(yaw_deg: float, pitch_deg: float, roll_deg: float) -> np.ndarray:
    y, p, r = np.radians([yaw_deg, pitch_deg, roll_deg])
    ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    rx = np.array([[1, 0, 0], [0, np.cos(p), -np.sin(p)], [0, np.sin(p), np.cos(p)]])
    rz = np.array([[np.cos(r), -np.sin(r), 0], [np.sin(r), np.cos(r), 0], [0, 0, 1]])
    return ry @ rx @ rz


def render_frame(pano: np.ndarray, R: np.ndarray, size, hfov_deg: float) -> np.ndarray:
    """Perspective view of the panorama, looking along the camera's +Z after R."""
    w, h = size
    f = (w / 2) / np.tan(np.radians(hfov_deg) / 2)
    xs = np.arange(w) - (w - 1) / 2
    ys = np.arange(h) - (h - 1) / 2
    gx, gy = np.meshgrid(xs, ys)

    # Image rows grow downward but world y grows upward, so gy must be negated.
    # Without this the whole render is vertically mirrored and the stitcher
    # faithfully reconstructs a room with its floor on the ceiling.
    dirs = np.stack([gx, -gy, np.full_like(gx, f)], axis=-1)
    dirs /= np.linalg.norm(dirs, axis=-1, keepdims=True)
    world = dirs @ R.T

    lon = np.arctan2(world[..., 0], world[..., 2])
    lat = np.arcsin(np.clip(world[..., 1], -1, 1))

    ph, pw = pano.shape[:2]
    map_x = ((lon / (2 * np.pi)) + 0.5) * pw
    map_y = (0.5 - lat / np.pi) * ph
    return cv2.remap(
        pano, map_x.astype(np.float32), map_y.astype(np.float32),
        cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP,
    )


def make_video(pano, out_path: Path, *, frames: int, fps: int, size, hfov: float,
               turns: float, wobble: float, seed: int) -> None:
    rng = np.random.default_rng(seed)
    writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    if not writer.isOpened():
        raise SystemExit(f"OpenCV could not open a writer for {out_path}")

    # Smooth random walk, so the wobble looks like a hand rather than like noise.
    pitch_walk = np.cumsum(rng.normal(0, wobble, frames))
    roll_walk = np.cumsum(rng.normal(0, wobble, frames))
    pitch_walk -= np.linspace(0, pitch_walk[-1], frames)
    roll_walk -= np.linspace(0, roll_walk[-1], frames)

    for i in range(frames):
        progress = i / frames
        # Slightly uneven speed: nobody pans at a perfectly constant rate.
        yaw = 360.0 * turns * (progress + 0.02 * np.sin(progress * 2 * np.pi * 3))
        frame = render_frame(pano, rotation(yaw, pitch_walk[i], roll_walk[i]), size, hfov)

        # Auto-exposure drift, which is exactly what makes `blending: none` show seams.
        gain = 1.0 + 0.07 * np.sin(progress * 2 * np.pi * 2)
        frame = np.clip(frame.astype(np.float32) * gain, 0, 255).astype(np.uint8)
        frame = cv2.GaussianBlur(frame, (3, 3), 0.6)  # video is softer than stills

        writer.write(frame)
        if i % 20 == 0:
            print(f"  frame {i}/{frames}", flush=True)

    writer.release()


# ------------------------------------------------------------------- CLI ---


def main() -> int:
    ap = argparse.ArgumentParser(description="Render a synthetic room pan for testing the stitcher.")
    ap.add_argument("--out", type=Path, default=Path("out/testroom"))
    ap.add_argument("--seconds", type=float, default=24.0)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--width", type=int, default=1920, help="video frame width")
    ap.add_argument("--hfov", type=float, default=64.0, help="camera HFOV; match stitcher config")
    ap.add_argument("--portrait", action="store_true",
                    help="hold the phone vertically: same lens, but the tall axis now carries the wide FOV")
    ap.add_argument("--turns", type=float, default=1.0, help="full rotations during the clip")
    ap.add_argument("--wobble", type=float, default=0.25, help="degrees of handheld jitter per frame")
    ap.add_argument("--pano-width", type=int, default=4096)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(args.seed)

    print(f"[gen] ground-truth panorama {args.pano_width}x{args.pano_width // 2} ...", flush=True)
    pano = render_truth_panorama(args.pano_width, rng)
    truth = args.out / "truth.jpg"
    cv2.imwrite(str(truth), pano, [cv2.IMWRITE_JPEG_QUALITY, 92])

    # Same lens, rotated. The wide axis becomes vertical, so the pan sweeps a much
    # taller band -- and args.hfov must be the HORIZONTAL fov of the rotated frame.
    size = (args.width, int(args.width * 16 / 9)) if args.portrait else (args.width, int(args.width * 9 / 16))
    frames = int(args.seconds * args.fps)
    video = args.out / "pan.mp4"
    print(f"[gen] {frames} frames at {size[0]}x{size[1]}, hfov {args.hfov} deg ...", flush=True)
    make_video(pano, video, frames=frames, fps=args.fps, size=size, hfov=args.hfov,
               turns=args.turns, wobble=args.wobble, seed=args.seed)

    print(f"\nground truth : {truth}")
    print(f"test video   : {video}  ({video.stat().st_size / 1e6:.1f} MB)")
    print(f"\nnow stitch it:\n  python stitcher/stitch_room.py --video {video} --out {args.out / 'stitched'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
