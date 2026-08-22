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

/**
 * Vertical field of view of a phone held UPRIGHT, in degrees - the long sensor
 * axis. This is a lens property, so it stays put no matter how far the seller
 * swept, which is exactly what makes it the right thing to assume. A full 360
 * sweep at this figure comes out around 4.7:1; anything squarer stopped short.
 */
export const PANO_VFOV_DEG = 68;

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

/**
 * Largest source width we will work with. A panorama straight off a phone is
 * 10786 x 3706 or bigger - forty megapixels, 160 MB once expanded to RGBA - and
 * holding two or three copies of that is what makes canvas operations start
 * failing instead of throwing. Since 4096 is also the widest image we ever
 * output, decoding above it costs memory and buys nothing.
 */
const MAX_DECODE_WIDTH = 4096;

/**
 * What kind of file is this really?
 *
 * The extension and the browser-reported MIME type both lie: Windows hands over
 * ".jpg" for things that are not, and a HEIC dragged out of a synced iCloud
 * folder often arrives with an empty type. Only the first few bytes are honest,
 * and getting this right decides whether the seller is told something true or is
 * sent chasing a camera setting that was never the problem.
 */
async function sniff(file) {
  const b = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));

  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';

  // ISO base media: [size][ftyp][major brand][minor version][compatible brands...].
  // The major brand is not enough on its own - the sample iPhone files carry
  // major brand "mif1" with "heic" only appearing further down the list.
  if (ascii(4, 4) === 'ftyp') {
    const size = Math.min((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3], b.length);
    const brands = [];
    for (let o = 8; o + 4 <= size; o += 4) if (o !== 12) brands.push(ascii(o, 4));
    if (brands.some((x) => x === 'avif' || x === 'avis')) return 'avif';
    if (brands.some((x) => /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(x))) return 'heic';
    return 'video';
  }
  return 'unknown';
}

/**
 * Decode a HEIC ourselves, because no browser but Safari will.
 *
 * iPhones write HEIC by default, and Panorama mode is no exception, so this is
 * not an edge case for our seller - it is the default path. Telling them to go
 * and change Camera > Formats works, but only after they have already failed
 * once and lost the photo they were trying to upload.
 *
 * libheif is 1.2 MB of WebAssembly, which is why it is imported here and not at
 * the top of the file: it is fetched only when a HEIC actually turns up, and
 * never at all on Safari, whose native decoder is both present and faster.
 */
async function decodeHeic(file, onStage) {
  onStage?.('Converting HEIC…');
  const { default: libheifFactory } = await import('../vendor/libheif/libheif-bundle.js');
  const libheif = await libheifFactory();

  const images = new libheif.HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
  if (!images?.length) throw new Error('That HEIC file contains no image.');

  // A HEIC holds several images: the photo, a thumbnail, sometimes a depth map.
  // The biggest one is the photo.
  const image = images.reduce((a, b) => (b.get_width() * b.get_height() > a.get_width() * a.get_height() ? b : a));
  const w = image.get_width();
  const h = image.get_height();

  // libheif hands back raw pixels, so go straight from those to a bitmap the
  // browser has already shrunk for us. Painting them into a full-size canvas on
  // the way would mean holding forty megapixels twice over - a real panorama is
  // 10786 x 3706, which is 160 MB per copy - and that is the sort of pressure
  // under which canvas operations start failing rather than throwing.
  const pixels = new ImageData(w, h);
  await new Promise((resolve, reject) => {
    image.display(pixels, (out) =>
      out ? resolve(out) : reject(new Error('libheif could not render that HEIC.'))
    );
  });
  images.forEach((im) => im.free?.());

  return w <= MAX_DECODE_WIDTH
    ? await createImageBitmap(pixels)
    : await createImageBitmap(pixels, { resizeWidth: MAX_DECODE_WIDTH, resizeQuality: 'high' });
}

/** Human wording for a file we recognise but cannot use. */
const WRONG_KIND = {
  video: 'That is a video, not a photo. Use the "Room video" button for clips.',
  unknown: 'That file is not an image the browser recognises.',
};

/**
 * Decode a File into something canvas can draw, bounded in size.
 *
 * Every return here is checked by decode() below, because the one thing this
 * must never do is hand back nothing at all: an undefined reaching drawImage
 * surfaces as a wall of WebIDL type names that says nothing about which decoder
 * gave up or why.
 */
async function decodeSource(file, onStage) {
  if (window.createImageBitmap) {
    try {
      const probe = await createImageBitmap(file);
      if (probe.width <= MAX_DECODE_WIDTH) return probe;
      // Shrink the bitmap we already have rather than decoding the file a second
      // time. The old two-pass version decoded forty megapixels twice, which on
      // a phone panorama is most of the wait.
      const resized = await createImageBitmap(probe, {
        resizeWidth: MAX_DECODE_WIDTH,
        resizeQuality: 'high',
      });
      probe.close?.();
      return resized;
    } catch (err) {
      // Native decoding failed. Before blaming the format, find out what the
      // format actually is - the previous version of this blamed HEIC for every
      // failure, including the ones that were nothing of the sort.
      const kind = await sniff(file).catch(() => 'unknown');
      if (kind === 'heic') return await decodeHeic(file, onStage);
      throw new Error(
        WRONG_KIND[kind] ||
        `That ${kind.toUpperCase()} could not be decoded by this browser (${err.message}). ` +
        'Try re-exporting it as a JPEG.'
      );
    }
  }
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

async function decode(file, onStage) {
  const src = await decodeSource(file, onStage);
  const drawable =
    (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) ||
    src instanceof HTMLCanvasElement ||
    src instanceof HTMLImageElement;
  if (!drawable) {
    throw new Error(
      `"${file.name}" decoded to nothing usable (${Object.prototype.toString.call(src)}). This is ` +
      'a bug in the app rather than a problem with your photo - please report it, and try a JPEG ' +
      'export in the meantime.'
    );
  }
  return src;
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
 * f comes from the VERTICAL field of view, which is fixed by the lens. The
 * horizontal sweep is then read off the width - see below for why that way round.
 */
export async function cylindricalToEquirect(file, { vfovDeg = PANO_VFOV_DEG, haovDeg = null, maxWidth = 4096, degPerPx = null, onStage = null } = {}) {
  const src = await decode(file, onStage);
  const sw = src.width;
  const sh = src.height;

  // Which quantity is known matters. The VERTICAL field of view is a property of
  // the lens and does not change with how far you swept, so that is the input.
  // The HORIZONTAL sweep is whatever the seller managed before the phone stopped,
  // and it falls out of the strip's aspect ratio. Assuming 360 here - as this
  // first did - silently stretches a 240-degree sweep around the whole sphere.
  const maxPitch = (vfovDeg * Math.PI) / 360;
  const f = sh / 2 / Math.tan(maxPitch);
  const vaov = vfovDeg;
  const haov = haovDeg ?? Math.min(360, (sw / f) * (180 / Math.PI));

  // Keep degrees-per-pixel identical on both axes, which is what makes the
  // result a valid equirectangular patch rather than a stretched one. When
  // several sweeps are being joined they must all share one scale, hence degPerPx.
  const scale = degPerPx ?? haov / Math.min(sw, maxWidth);
  const outW = Math.max(1, Math.round(haov / scale));
  const outH = Math.max(1, Math.round(vaov / scale));

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

  return { canvas, haov, vaov, vOffset: 0, degPerPx: scale };
}

/** Re-draw an already-equirectangular image, capping its width. */
export async function normaliseEquirect(file, geometry, maxWidth = 4096, onStage = null) {
  const src = await decode(file, onStage);
  const k = Math.min(1, maxWidth / src.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.width * k);
  canvas.height = Math.round(src.height * k);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  src.close?.();
  return { canvas, ...geometry, degPerPx: geometry.haov / canvas.width };
}

/* ------------------------------------------------------- joining sweeps --- */

/**
 * Join several sweeps of the same room into one panorama.
 *
 * This is the answer to a phone that refuses to sweep past ~240 degrees: shoot
 * the room in two or three goes and let the app put them together.
 *
 * It is far easier than general stitching, and that is the whole point. Every
 * sweep comes from the same lens at the same vertical field of view, and every
 * one has already been converted to equirectangular at a shared degrees-per-pixel.
 * So two sweeps of the same room differ by a HORIZONTAL SHIFT and nothing else -
 * no scale, no rotation, no perspective. Finding that shift is a one-dimensional
 * search, which is cheap and hard to get wrong.
 */
function toGrayRow(canvas, sampleH = 64) {
  // Correlate on a horizontal band through the middle: it carries the furniture
  // and wall edges, and skips the ceiling, which is usually a blank expanse.
  const w = canvas.width;
  const y0 = Math.max(0, Math.floor(canvas.height / 2 - sampleH / 2));
  const data = canvas.getContext('2d').getImageData(0, y0, w, Math.min(sampleH, canvas.height - y0)).data;
  const rows = data.length / 4 / w;

  const gray = new Float32Array(w);
  const filled = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let seen = 0;
    for (let r = 0; r < rows; r++) {
      const i = (r * w + x) * 4;
      if (data[i + 3] < 8) continue; // transparent = no coverage here
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      seen++;
    }
    gray[x] = seen ? sum / seen : 0;
    filled[x] = seen ? 1 : 0;
  }
  return { gray, filled, w };
}

/**
 * Best horizontal offset of `patch` against `base`, both wrapped at fullW.
 * Normalised cross-correlation over the columns where the two actually overlap,
 * so a wide sweep is not favoured merely for being wide.
 */
function bestOffset(base, patch, fullW, minOverlapPx) {
  let best = { offset: 0, score: -Infinity, overlap: 0 };

  for (let off = 0; off < fullW; off++) {
    let n = 0;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;

    for (let x = 0; x < patch.w; x++) {
      if (!patch.filled[x]) continue;
      const bx = (off + x) % fullW;
      if (!base.filled[bx]) continue;
      const a = base.gray[bx];
      const b = patch.gray[x];
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    if (n < minOverlapPx) continue;

    const cov = sab / n - (sa / n) * (sb / n);
    const va = saa / n - (sa / n) ** 2;
    const vb = sbb / n - (sb / n) ** 2;
    if (va <= 1e-6 || vb <= 1e-6) continue;

    // Slight preference for more overlap breaks ties between near-identical peaks.
    const score = (cov / Math.sqrt(va * vb)) * (1 + 0.05 * Math.min(1, n / (fullW * 0.25)));
    if (score > best.score) best = { offset: off, score, overlap: n };
  }
  return best;
}

/** Shrink a canvas to fit a width ceiling, preserving its aspect ratio. */
function capWidth(canvas, maxWidth) {
  if (canvas.width <= maxWidth) return canvas;
  const out = document.createElement('canvas');
  out.width = maxWidth;
  out.height = Math.max(1, Math.round((canvas.height * maxWidth) / canvas.width));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/**
 * Trim the 360-degree working canvas down to the arc that actually has pixels
 * on it.
 *
 * The compositing above happens on a full circle because that is the only frame
 * in which two sweeps can be positioned relative to each other. But handing that
 * canvas to the viewer while declaring haov as the covered arc tells it to spread
 * a full circle of image across, say, 225 degrees - so everything ends up in the
 * wrong place. The image and the angle have to describe the same thing, and the
 * honest one is the covered arc.
 *
 * The run is found with wrap-around, because the gap in a two-sweep panorama is
 * quite often behind the photographer, straddling the 0-degree line.
 */
function cropToCoverage(out, degPerPx) {
  const fullW = out.width;
  const { filled } = toGrayRow(out);
  const covered = filled.reduce((a, b) => a + b, 0);
  if (covered >= fullW * 0.985) return { canvas: out, haov: 360, wrapped: true };

  let bestStart = 0;
  let bestLen = 0;
  let start = 0;
  let len = 0;
  for (let i = 0; i < fullW * 2 && bestLen < fullW; i++) {
    if (filled[i % fullW]) {
      if (len === 0) start = i;
      if (++len > bestLen) {
        bestLen = len;
        bestStart = start;
      }
    } else {
      len = 0;
    }
  }
  if (!bestLen) return { canvas: out, haov: 360, wrapped: false };

  const crop = document.createElement('canvas');
  crop.width = Math.min(bestLen, fullW);
  crop.height = out.height;
  const cx = crop.getContext('2d');

  const s = bestStart % fullW;
  const head = Math.min(crop.width, fullW - s);
  cx.drawImage(out, s, 0, head, out.height, 0, 0, head, out.height);
  const tail = crop.width - head;
  if (tail > 0) cx.drawImage(out, 0, 0, tail, out.height, head, 0, tail, out.height);

  return { canvas: crop, haov: crop.width * degPerPx, wrapped: false };
}

/**
 * Composite the patches onto one 360-degree canvas.
 * Returns the canvas plus how much of the circle actually got covered.
 */
function mergePatches(patches) {
  const degPerPx = Math.max(...patches.map((p) => p.degPerPx));
  const fullW = Math.round(360 / degPerPx);
  const height = Math.max(...patches.map((p) => p.canvas.height));

  const out = document.createElement('canvas');
  out.width = fullW;
  out.height = height;
  const ctx = out.getContext('2d');

  // Re-render every patch at the shared scale first, so offsets are comparable.
  const scaled = patches.map((p) => {
    const w = Math.max(1, Math.round(p.haov / degPerPx));
    const h = Math.max(1, Math.round(p.vaov / degPerPx));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = height;
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(p.canvas, 0, Math.round((height - h) / 2), w, h);
    return c;
  });

  // Widest sweep first: it makes the most reliable anchor for the rest.
  const order = scaled.map((c, i) => i).sort((a, b) => scaled[b].width - scaled[a].width);

  ctx.drawImage(scaled[order[0]], 0, 0);
  const placements = [{ index: order[0], offset: 0 }];

  for (const idx of order.slice(1)) {
    const base = toGrayRow(out);
    const patch = toGrayRow(scaled[idx]);
    const minOverlap = Math.max(24, Math.round(scaled[idx].width * 0.08));
    const { offset, score, overlap } = bestOffset(base, patch, fullW, minOverlap);

    // A weak peak means these two sweeps do not actually share a view. Butt it up
    // against what we have rather than pasting it somewhere wrong and confident.
    const covered = base.filled.reduce((a, b) => a + b, 0);
    const place = score > 0.35 ? offset : covered % fullW;
    placements.push({ index: idx, offset: place, score, overlap, joined: score > 0.35 });

    ctx.save();
    ctx.drawImage(scaled[idx], place, 0);
    // Wrap around the seam at 360 degrees.
    if (place + scaled[idx].width > fullW) {
      ctx.drawImage(scaled[idx], place - fullW, 0);
    }
    ctx.restore();
  }

  const cropped = cropToCoverage(out, degPerPx);

  // Two sweeps composited at their own resolution can come out wider than either
  // of them - 6826 px for a 225-degree join here. Older phone GPUs cap a texture
  // at 4096, and the viewer is the one thing in this project that has to work on
  // a stranger's handset, so bring it back to the same ceiling as everything else.
  const canvas = capWidth(cropped.canvas, MAX_DECODE_WIDTH);
  const { haov, wrapped } = cropped;

  return {
    canvas,
    haov,
    vaov: Math.max(...patches.map((p) => p.vaov)),
    vOffset: 0,
    degPerPx: haov / canvas.width,
    placements,
    wrapped,
  };
}

/**
 * Encode a canvas, and refuse to hand back something empty.
 *
 * toBlob reports failure by calling back with null rather than throwing, and an
 * unchecked null becomes a zero-byte upload that every other layer treats as a
 * success. Retry once at lower quality in case it was a transient memory spike,
 * then give up loudly.
 */
async function encode(canvas) {
  for (const quality of [0.9, 0.75]) {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (blob && blob.size > 1024) return blob;
  }
  throw new Error(
    `The browser could not encode the ${canvas.width}x${canvas.height} panorama, which usually ` +
    'means it ran out of memory. Close some tabs and try again, or export the photo at a ' +
    'smaller size first.'
  );
}

/* ------------------------------------------------------------------ public */

/**
 * Turn one or more panorama photos of a room into a single equirectangular
 * image plus the angles Pannellum needs to place it on the sphere.
 */
export async function preparePanorama(files, { vfovDeg, haovDeg, onStage = null } = {}) {
  const list = Array.from(files);

  const patches = [];
  for (const [i, file] of list.entries()) {
    const label = list.length > 1 ? ` (${i + 1} of ${list.length})` : '';
    const stage = (text) => onStage?.(text + label);
    stage('Reading panorama…');

    const gpano = await readGPano(file);
    const patch = gpano
      ? { source: 'photosphere', ...(await normaliseEquirect(file, gpano, 4096, stage)) }
      : { source: 'cylindrical', ...(await cylindricalToEquirect(file, { vfovDeg, haovDeg, onStage: stage })) };

    // A panorama is wider than it is tall - always, whatever the projection. A
    // portrait one means the image arrived rotated, and every angle derived from
    // its aspect ratio below would be nonsense. Catch it here rather than storing
    // a room the viewer cannot make sense of.
    if (patch.canvas.height > patch.canvas.width) {
      throw new Error(
        `"${file.name}" is taller than it is wide, so it is either not a panorama or it came ` +
        'through rotated. Open it, rotate it upright, and save it again.'
      );
    }
    patches.push(patch);
  }

  if (list.length > 1) onStage?.(`Joining ${list.length} sweeps…`);
  const merged = patches.length === 1 ? patches[0] : mergePatches(patches);

  onStage?.('Encoding…');
  const blob = await encode(merged.canvas);

  return {
    blob,
    haov: merged.haov,
    vaov: merged.vaov,
    vOffset: merged.vOffset ?? 0,
    source: patches.length > 1 ? 'merged' : patches[0].source,
    parts: patches.length,
    placements: merged.placements ?? null,
    width: merged.canvas.width,
    height: merged.canvas.height,
  };
}
