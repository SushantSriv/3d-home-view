/**
 * Panorama photo import.
 *
 * Why this exists: offline feature-matching of a handheld video keeps losing to
 * the two things phones are bad at - hand wobble and the camera not staying in
 * one place. Your phone's own panorama mode does not have that problem. It has
 * the gyroscope, it runs optical flow live, it blends column by column as you
 * sweep, and it shows you an arrow so you keep the horizon level. It is a far
 * better stitcher than anything we can run afterwards, and it has already run by
 * the time the file reaches us.
 *
 * So for a panorama photo there is no stitching to do at all - only a projection
 * conversion, which is exact, instant, and cannot fail. No queue, no worker.
 *
 * Two kinds of file arrive here:
 *
 *   Photo Sphere / Street View  already equirectangular, and carries GPano XMP
 *                               metadata giving the exact angles. Best case:
 *                               we read the numbers and use the image as-is.
 *
 *   Ordinary phone pano         a cylindrical strip: horizontal position is
 *                               proportional to yaw, but vertical position is
 *                               proportional to tan(pitch), not pitch. Feeding
 *                               that to a sphere viewer squashes everything
 *                               toward the horizon, so we remap it.
 */

/** Parsed GPano XMP, or null when the file has none. */
export async function readGPano(file) {
  // The XMP packet lives in the first few hundred KB of a JPEG; no need to read
  // a 20 MB panorama into a string to find it.
  const head = await file.slice(0, 512 * 1024).text().catch(() => '');
  if (!head.includes('GPano:')) return null;

  const num = (tag) => {
    const m =
      head.match(new RegExp(`GPano:${tag}\\s*=\\s*"(-?\\d+)"`)) ||
      head.match(new RegExp(`<GPano:${tag}>(-?\\d+)</GPano:${tag}>`));
    return m ? parseInt(m[1], 10) : null;
  };

  const fullW = num('FullPanoWidthPixels');
  const fullH = num('FullPanoHeightPixels');
  const cropW = num('CroppedAreaImageWidthPixels');
  const cropH = num('CroppedAreaImageHeightPixels');
  const left = num('CroppedAreaLeftPixels');
  const top = num('CroppedAreaTopPixels');
  if (!fullW || !fullH || !cropW || !cropH) return null;

  return {
    haov: (cropW / fullW) * 360,
    vaov: (cropH / fullH) * 180,
    // Pannellum's vOffset is the pitch of the image's centre.
    vOffset: 90 - (((top ?? 0) + cropH / 2) / fullH) * 180,
  };
}

/** Decode a File into something canvas can draw. */
async function decode(file) {
  if (window.createImageBitmap) return createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('That image could not be decoded.'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Cylindrical strip -> equirectangular.
 *
 * In a cylindrical projection a point at pitch p lands at y = f*tan(p) from the
 * middle; in equirectangular it lands at y proportional to p itself. Columns are
 * already correct in both, so this is a pure vertical remap and we can do it one
 * output row at a time with drawImage - no per-pixel loop, and the browser gives
 * us filtering for free.
 *
 * f comes from the horizontal sweep: the strip covers `haov` degrees across its
 * full width, so f = width / haov_in_radians.
 */
export async function cylindricalToEquirect(file, haovDeg = 360, maxWidth = 4096) {
  const src = await decode(file);
  const sw = src.width;
  const sh = src.height;

  const f = sw / ((haovDeg * Math.PI) / 180);
  const maxPitch = Math.atan(sh / 2 / f);
  const vaov = (2 * maxPitch * 180) / Math.PI;

  const outW = Math.min(sw, maxWidth);
  // Keep degrees-per-pixel identical on both axes, which is what makes the
  // result a valid equirectangular patch rather than a stretched one.
  const outH = Math.max(1, Math.round((outW * vaov) / haovDeg));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  // Each output row spans a pitch range; project both of its edges back into the
  // strip and copy exactly that slice. Near the horizon the slice is about one
  // pixel tall, and towards the top and bottom it grows - which is precisely the
  // tan() compression we are undoing.
  const srcYOf = (pitch) => sh / 2 - f * Math.tan(pitch);

  for (let y = 0; y < outH; y++) {
    const pitchTop = maxPitch - (y / outH) * 2 * maxPitch;
    const pitchBottom = maxPitch - ((y + 1) / outH) * 2 * maxPitch;

    const top = srcYOf(pitchTop);
    const height = srcYOf(pitchBottom) - top;

    const clampedTop = Math.max(0, Math.min(sh - 1, top));
    const clampedHeight = Math.max(1, Math.min(sh - clampedTop, height));
    ctx.drawImage(src, 0, clampedTop, sw, clampedHeight, 0, y, outW, 1);
  }

  src.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  return { blob, haov: haovDeg, vaov, vOffset: 0, width: outW, height: outH };
}

/** Re-encode an already-equirectangular image, capping its width. */
export async function normaliseEquirect(file, geometry, maxWidth = 4096) {
  const src = await decode(file);
  const scale = Math.min(1, maxWidth / src.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.width * scale);
  canvas.height = Math.round(src.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  src.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  return { blob, ...geometry, width: canvas.width, height: canvas.height };
}

/**
 * Turn whatever panorama the seller picked into something the viewer can show.
 * Returns the JPEG blob plus the angles Pannellum needs to place it on the sphere.
 */
export async function preparePanorama(file, { assumedHaov = 360 } = {}) {
  const gpano = await readGPano(file);
  if (gpano) {
    return { source: 'photosphere', ...(await normaliseEquirect(file, gpano)) };
  }
  return { source: 'cylindrical', ...(await cylindricalToEquirect(file, assumedHaov)) };
}
