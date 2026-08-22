/**
 * Building an equirectangular panorama out of frames whose orientation we know.
 *
 * Everything else in this project has tried to work out where a frame belongs by
 * looking at the pixels - matching features between frames, correlating overlaps.
 * That is the part that keeps failing on real footage, because a room is full of
 * blank walls and repeating skirting board and a handheld phone does not rotate
 * about its own lens.
 *
 * A phone knows where it is pointing. Once the yaw and pitch of each frame come
 * from the gyroscope instead of from the image, placing that frame is arithmetic
 * rather than inference: it cannot mismatch, it cannot double an armchair, and it
 * does not care that three walls look identical.
 *
 * The projection, for a phone held upright and level:
 *
 *   A pinhole camera looking down +z maps a direction at yaw θ and pitch φ
 *   (both relative to the camera axis) to
 *
 *       u = f·tan(θ)                    v = f·tan(φ) / cos(θ)
 *
 *   u depends on θ alone, which is what makes this cheap. Along one column of
 *   constant θ the vertical mapping is the ordinary cylindrical tan() curve with
 *   an effective focal length of f/cos(θ). So a frame can be turned into an
 *   equirectangular patch in two separable passes, both of which are plain
 *   drawImage calls rather than a per-pixel loop:
 *
 *     A. per column - read source column u = f·tan(θ) and scale it vertically by
 *        cos(θ), which cancels the 1/cos(θ) and leaves a true cylindrical strip
 *     B. per row - the standard cylindrical-to-equirectangular remap, y ∝ φ
 *
 * The narrowing in pass A is not an approximation: the top corners of a
 * rectilinear frame really do sit at a lower pitch than its top centre, so a
 * frame covers a bow-tie of the sphere rather than a rectangle. Overlapping
 * frames fill in the pinched corners.
 */

/** 4096 px around the full circle - the widest panorama we ever hand the viewer. */
export const DEFAULT_DEG_PER_PX = 360 / 4096;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const focalFromHfov = (hfovDeg, widthPx) => widthPx / 2 / Math.tan((hfovDeg * RAD) / 2);
export const hfovFromFocal = (focalPx, widthPx) => 2 * Math.atan(widthPx / 2 / focalPx) * DEG;

/** Signed difference a - b folded into (-180, 180]. */
export function angleDelta(a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/**
 * Turn one frame into an equirectangular patch.
 *
 * Returned x/y are where the patch belongs on a full-circle canvas of the given
 * scale, with yaw 0 at the left edge and pitch 0 at the vertical centre.
 */
function projectFrame(source, { yaw, pitch, focal, degPerPx, canvasWidth, canvasHeight }) {
  const w = source.width;
  const h = source.height;

  // tan() runs away near 90 degrees, and no phone camera is that wide anyway.
  const hfov = Math.min(hfovFromFocal(focal, w), 100);
  const halfH = (hfov * RAD) / 2;
  const phiMax = Math.atan(h / 2 / focal);

  const cw = Math.max(1, Math.round(hfov / degPerPx));

  // ---- pass A: rectify horizontally, and undo the 1/cos(θ) vertical stretch.
  const cyl = document.createElement('canvas');
  cyl.width = cw;
  cyl.height = h;
  const cylCtx = cyl.getContext('2d');
  cylCtx.imageSmoothingQuality = 'high';

  for (let i = 0; i < cw; i++) {
    const theta = ((i + 0.5) / cw - 0.5) * 2 * halfH;
    const u = w / 2 + focal * Math.tan(theta);
    if (u < 0 || u >= w) continue;
    const k = Math.cos(theta);
    const dh = h * k;
    cylCtx.drawImage(source, u, 0, 1, h, i, (h - dh) / 2, 1, dh);
  }

  // ---- pass B: cylindrical -> equirectangular, carrying the frame's pitch.
  // The patch spans the pitches this frame can see, shifted by where it pointed.
  const topPhi = Math.min(phiMax + pitch * RAD, (canvasHeight / 2) * degPerPx * RAD);
  const botPhi = Math.max(-phiMax + pitch * RAD, -(canvasHeight / 2) * degPerPx * RAD);
  if (topPhi <= botPhi) return null;

  const rows = Math.max(1, Math.round(((topPhi - botPhi) * DEG) / degPerPx));
  const patch = document.createElement('canvas');
  patch.width = cw;
  patch.height = rows;
  const pctx = patch.getContext('2d');
  pctx.imageSmoothingQuality = 'high';

  for (let j = 0; j < rows; j++) {
    // World pitch of this output row, then the same pitch seen by the camera.
    const phiTop = topPhi - (j / rows) * (topPhi - botPhi);
    const phiBot = topPhi - ((j + 1) / rows) * (topPhi - botPhi);
    const vTop = h / 2 - focal * Math.tan(phiTop - pitch * RAD);
    const vBot = h / 2 - focal * Math.tan(phiBot - pitch * RAD);
    const y = Math.max(0, Math.min(h - 1, vTop));
    const height = Math.max(1, Math.min(h - y, vBot - vTop));
    pctx.drawImage(cyl, 0, y, cw, height, 0, j, cw, 1);
  }

  // Feather the left and right edges so overlapping frames cross-fade instead of
  // showing a hard vertical join where the exposure changed mid-sweep.
  const fade = Math.max(2, Math.round(cw * 0.18));
  const grad = pctx.createLinearGradient(0, 0, cw, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(fade / cw, 'rgba(0,0,0,1)');
  grad.addColorStop(1 - fade / cw, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  pctx.globalCompositeOperation = 'destination-in';
  pctx.fillStyle = grad;
  pctx.fillRect(0, 0, cw, rows);

  return {
    canvas: patch,
    // Yaw 0 sits at the centre of the working canvas, which is where a reader of
    // an equirectangular image expects it - and makes the wrap at +/-180 the seam
    // rather than putting the seam straight ahead.
    x: canvasWidth / 2 + yaw / degPerPx - cw / 2,
    y: canvasHeight / 2 - (topPhi * DEG) / degPerPx,
    hfov,
    vaov: (topPhi - botPhi) * DEG,
  };
}

/**
 * Accumulates frames onto one full-circle canvas.
 *
 * Coverage is tracked per column in degrees rather than by inspecting pixels,
 * because we want to tell the person turning on the spot how much of the room
 * they still have left while they are still standing in it.
 */
export function createPanoBuilder({ degPerPx = DEFAULT_DEG_PER_PX, vaovDeg = 120 } = {}) {
  const width = Math.round(360 / degPerPx);
  const height = Math.round(vaovDeg / degPerPx);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const columns = new Uint8Array(width);
  let frames = 0;

  /**
   * Mean luminance per column of a canvas region, ignoring anything not solidly
   * covered. Half-transparent pixels are the feathered edges of earlier frames
   * and would drag the profile towards the background.
   */
  function profileOf(source, x0, w, y0, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cx = c.getContext('2d');
    // Draw three times so a window straddling the 0/360 seam still fills.
    for (const dx of [-width, 0, width]) cx.drawImage(source, -x0 + dx, -y0);
    const d = cx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w);
    const filled = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let seen = 0;
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 200) continue;
        sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        seen++;
      }
      gray[x] = seen ? sum / seen : 0;
      filled[x] = seen > h * 0.4 ? 1 : 0;
    }
    return { gray, filled };
  }

  /**
   * Nudge a patch into place against what is already on the canvas.
   *
   * The gyroscope says where the phone was pointing; it does not say where the
   * picture was taken. Those differ by however long the camera pipeline held the
   * frame - a tenth of a second at 30 degrees per second is three degrees - and
   * by whatever the sensor has drifted since the sweep began. Both are small and
   * both accumulate, and both show up as structures repeating slightly offset
   * from themselves.
   *
   * So the sensor reading is treated as a starting point rather than an answer:
   * correlate the incoming patch against the overlap it should have with the
   * panorama so far, and take the correction if the evidence is good. Bounded,
   * because a large "correction" against a repetitive wall is a wrong one.
   */
  function refine(patch, maxShiftPx) {
    const y0 = Math.max(0, Math.round(patch.y));
    const h = Math.min(height - y0, patch.canvas.height);
    if (h < 8) return 0;

    const cw = patch.canvas.width;
    const x0 = Math.round(patch.x);
    const base = profileOf(canvas, x0 - maxShiftPx, cw + 2 * maxShiftPx, y0, h);
    const mine = profileOf(patch.canvas, 0, cw, 0, h);

    let best = { shift: 0, score: -Infinity };
    for (let s = 0; s <= 2 * maxShiftPx; s++) {
      let n = 0;
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let x = 0; x < cw; x++) {
        if (!mine.filled[x] || !base.filled[x + s]) continue;
        const a = base.gray[x + s];
        const b = mine.gray[x];
        n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
      }
      if (n < cw * 0.25) continue;
      const cov = sab / n - (sa / n) * (sb / n);
      const va = saa / n - (sa / n) ** 2;
      const vb = sbb / n - (sb / n) ** 2;
      if (va <= 1e-6 || vb <= 1e-6) continue;
      const score = cov / Math.sqrt(va * vb);
      if (score > best.score) best = { shift: s - maxShiftPx, score };
    }
    // A weak peak means the overlap is a blank wall; the sensor is the better
    // guess there, so leave it alone.
    return best.score > 0.55 ? best.shift : 0;
  }

  function paint(patch) {
    // Wrap across the 0/360 seam by drawing the patch up to three times; the
    // off-canvas copies cost nothing and remove every special case.
    for (const dx of [-width, 0, width]) {
      ctx.drawImage(patch.canvas, Math.round(patch.x) + dx, Math.round(patch.y));
    }
    const from = Math.round(patch.x);
    for (let i = 0; i < patch.canvas.width; i++) {
      columns[(((from + i) % width) + width) % width] = 1;
    }
  }

  return {
    canvas,
    degPerPx,

    /**
     * yaw and pitch in degrees, focal in source pixels. Returns the yaw the frame
     * was actually placed at, which is the sensor reading plus any correction the
     * overlap justified.
     */
    addFrame(source, { yaw, pitch = 0, focal, refineDeg = 0 }) {
      const patch = projectFrame(source, {
        yaw, pitch, focal, degPerPx, canvasWidth: width, canvasHeight: height,
      });
      if (!patch) return null;

      let correction = 0;
      if (refineDeg > 0 && frames > 0) {
        const shift = refine(patch, Math.max(1, Math.round(refineDeg / degPerPx)));
        patch.x += shift;
        correction = shift * degPerPx;
      }

      paint(patch);
      frames++;
      return { yaw: yaw + correction, correction };
    },

    frameCount: () => frames,

    /** Fraction of the circle captured so far, 0..1. */
    coverage() {
      let n = 0;
      for (let i = 0; i < width; i++) n += columns[i];
      return n / width;
    },

    /** Which 5-degree sectors are still missing, for the guidance ring. */
    sectors(count = 72) {
      const out = new Array(count).fill(false);
      const per = width / count;
      for (let s = 0; s < count; s++) {
        let hit = 0;
        for (let i = Math.floor(s * per); i < Math.floor((s + 1) * per); i++) hit += columns[i];
        out[s] = hit > per * 0.6;
      }
      return out;
    },

    /**
     * Crop to what was actually captured and report the angles that go with it.
     * The image and the declared angles have to describe the same thing.
     */
    finish() {
      const covered = this.coverage();
      const full = covered >= 0.985;

      // Longest run of captured columns, wrapping, exactly as for joined sweeps.
      let start = 0;
      let best = { at: 0, len: 0 };
      let len = 0;
      for (let i = 0; i < width * 2 && best.len < width; i++) {
        if (columns[i % width]) {
          if (len === 0) start = i;
          if (++len > best.len) best = { at: start, len };
        } else {
          len = 0;
        }
      }
      const cw = full ? width : Math.min(best.len, width);
      if (!cw) return null;

      // Vertical extent: the rows that actually received pixels.
      const data = ctx.getImageData(0, 0, width, height).data;
      let top = height;
      let bottom = -1;
      for (let y = 0; y < height; y++) {
        let seen = 0;
        for (let x = 0; x < width; x += 16) {
          if (data[(y * width + x) * 4 + 3] > 24) seen++;
          if (seen > 3) break;
        }
        if (seen > 3) {
          if (y < top) top = y;
          bottom = y;
        }
      }
      if (bottom < top) return null;
      const ch = bottom - top + 1;

      const out = document.createElement('canvas');
      out.width = cw;
      out.height = ch;
      const octx = out.getContext('2d');
      const s = full ? 0 : best.at % width;
      const head = Math.min(cw, width - s);
      octx.drawImage(canvas, s, top, head, ch, 0, 0, head, ch);
      if (cw > head) octx.drawImage(canvas, 0, top, cw - head, ch, head, 0, cw - head, ch);

      return {
        canvas: out,
        haov: full ? 360 : cw * degPerPx,
        vaov: ch * degPerPx,
        // Pitch of the band's centre, relative to the horizon.
        vOffset: (height / 2 - (top + ch / 2)) * degPerPx,
        frames,
      };
    },
  };
}

/**
 * Work out the camera's focal length from the phone's own movement.
 *
 * No browser API reports a camera's field of view, and guessing it from the model
 * is both brittle and impossible to do for a device you have never heard of. But
 * if the phone reports it turned by Δθ and the picture slid sideways by Δx pixels,
 * then f = Δx / Δθ. The phone measures one, the image measures the other, and the
 * answer needs no lookup table.
 *
 * Correlating a narrow band through the middle of the frame is enough, and it is
 * the same one-dimensional search used for joining sweeps.
 */
export function shiftBetween(a, b, maxShiftPx) {
  const n = Math.min(a.length, b.length);
  let best = { shift: 0, score: -Infinity };
  for (let s = -maxShiftPx; s <= maxShiftPx; s++) {
    let count = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let x = Math.max(0, -s); x < Math.min(n, n - s); x++) {
      const va = a[x];
      const vb = b[x + s];
      count++;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
    if (count < n * 0.35) continue;
    const cov = sab / count - (sa / count) * (sb / count);
    const va = saa / count - (sa / count) ** 2;
    const vb = sbb / count - (sb / count) ** 2;
    if (va <= 1e-6 || vb <= 1e-6) continue;
    const score = cov / Math.sqrt(va * vb);
    if (score > best.score) best = { shift: s, score };
  }
  return best;
}

/** Mean luminance of each column across a band through the middle of a frame. */
export function columnProfile(source, bandFraction = 0.4) {
  const w = source.width;
  const h = source.height;
  const bandH = Math.max(8, Math.round(h * bandFraction));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = bandH;
  const ctx = c.getContext('2d');
  ctx.drawImage(source, 0, Math.round((h - bandH) / 2), w, bandH, 0, 0, w, bandH);
  const d = ctx.getImageData(0, 0, w, bandH).data;
  const out = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y < bandH; y++) {
      const i = (y * w + x) * 4;
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    out[x] = sum / bandH;
  }
  return out;
}

/**
 * Which way up does the camera hand us its pixels?
 *
 * This cannot be assumed. A phone held upright in portrait very often delivers
 * frames in the sensor's own landscape orientation - the <video> element hides it,
 * but drawImage does not - and treating a sideways frame as upright puts the yaw
 * axis on the wrong image axis. Every frame then gets placed at the wrong angular
 * width, which is what a mess of overlapping structures looks like.
 *
 * Only two candidates ever need considering, because the caller has already
 * established from the sensors that the phone is being held upright: a landscape
 * frame must be turned a quarter, a portrait one must not. That leaves a single
 * question - which of the two ways round - and it is answered by a sign rather
 * than a magnitude: turning right slides the picture left, so in a correctly
 * oriented frame the shift opposes the change in yaw.
 *
 * An earlier version tried to work out the axis too, by asking which of the two
 * moved more. That does not survive contact with a room: a row profile down a
 * wall is a smooth ramp, and a smooth ramp correlates well against itself at
 * almost any offset, so the argmax lands anywhere and the wrong axis wins.
 */
export function detectRotation(prev, cur, deltaYawDeg) {
  if (Math.abs(deltaYawDeg) < 1.5) return null;

  const candidates = prev.width > prev.height ? [90, 270] : [0, 180];
  const a = rotateFrame(prev, candidates[0]);
  const b = rotateFrame(cur, candidates[0]);
  const { shift, score } = shiftBetween(
    columnProfile(a), columnProfile(b), Math.round(a.width * 0.45)
  );
  if (score < 0.5 || Math.abs(shift) < 4) return null;

  const opposed = Math.sign(shift) !== Math.sign(deltaYawDeg);
  return { degrees: opposed ? candidates[0] : candidates[1], score };
}

/** Rotate a frame by a multiple of 90 degrees. */
export function rotateFrame(source, degrees) {
  const d = ((degrees % 360) + 360) % 360;
  if (d === 0) return source;
  const swap = d === 90 || d === 270;
  const c = document.createElement('canvas');
  c.width = swap ? source.height : source.width;
  c.height = swap ? source.width : source.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return c;
}

/**
 * Accumulates focal-length evidence across a sweep and returns the running
 * median, which shrugs off the occasional frame where the correlation locked on
 * to a repeating skirting board.
 */
export function createFocalEstimator({ fallbackFocal } = {}) {
  const samples = [];
  return {
    /** Both profiles from columnProfile(), deltaYaw in degrees. */
    observe(prevProfile, profile, deltaYawDeg, widthPx) {
      const step = Math.abs(deltaYawDeg);
      if (step < 1.5 || step > 45) return null; // too small to measure, too big to match

      // Only the middle of the frame. Content does not slide uniformly under a
      // rotation - a feature at angle θ moves at f·sec²θ - so correlating the
      // full width returns an average shift that is too large and reads back a
      // focal length that is too long. Measured at 5.2% high before this.
      const keep = Math.round(widthPx * 0.5);
      const from = Math.round((widthPx - keep) / 2);
      const a = prevProfile.subarray(from, from + keep);
      const b = profile.subarray(from, from + keep);

      const { shift, score } = shiftBetween(a, b, Math.round(keep * 0.6));
      if (score < 0.5 || Math.abs(shift) < 4) return null;

      let focal = Math.abs(shift) / (step * RAD);
      // One correction pass: over a half-width band the mean of sec²θ is
      // tan(θc)/θc, and θc follows from the estimate we just made.
      const thetaC = Math.atan(keep / 2 / focal);
      if (thetaC > 1e-4) focal /= Math.tan(thetaC) / thetaC;

      const hfov = hfovFromFocal(focal, widthPx);
      // A portrait 16:9 phone frame is only about 41 degrees across, so the
      // window has to reach well below the 30 an earlier version used.
      if (hfov < 20 || hfov > 110) return null; // not a phone camera; discard
      samples.push(focal);
      return focal;
    },
    count: () => samples.length,
    /** Median of what we have, or the fallback until there is enough. */
    focal() {
      if (samples.length < 3) return fallbackFocal;
      const s = [...samples].sort((a, b) => a - b);
      return s[s.length >> 1];
    },
    settled: () => samples.length >= 3,
  };
}
