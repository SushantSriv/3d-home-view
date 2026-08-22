/**
 * Self-contained demo tour.
 *
 * Paints synthetic equirectangular panoramas onto a canvas at runtime, so the whole
 * viewer - floor plan, pins, room tags, doorway hotspots - can be demonstrated with
 * no Supabase project, no Python, no uploaded video and no network. This is what
 * `tour.html?demo=1` shows, and it is the fastest way to sanity-check the viewer
 * after a change.
 *
 * The projection is real, not faked: for every output column we cast a ray from the
 * camera at the centre of a rectangular room, find which wall it hits and how far
 * away it is, and place the floor and ceiling junctions at the pitch angles that
 * distance implies. That is why the walls bow correctly near the corners.
 */

const PANO_W = 2048;
const PANO_H = 1024; // equirectangular is always 2:1
const CAMERA_HEIGHT_M = 1.5;
const CEILING_HEIGHT_M = 2.5;

/* ---------------------------------------------------------------- room specs */

const ROOMS = [
  {
    id: 'demo-living',
    label: 'Living Room',
    dimensions_m2: 24.5,
    pin_x: 0.30, pin_y: 0.63,
    size: [5.6, 4.4],
    heading_offset: 0,
    palette: { wall: '#d9cfc0', ceiling: '#f1ece4', floor: '#9c7248', accent: '#b9482f' },
    features: [
      { type: 'window', wall: 0, u: 0.32, width: 1.6, sill: 0.9, height: 1.4 },
      { type: 'window', wall: 0, u: 0.68, width: 1.6, sill: 0.9, height: 1.4 },
      { type: 'art', wall: 2, u: 0.5, width: 1.1, sill: 1.3, height: 0.8 },
    ],
  },
  {
    id: 'demo-kitchen',
    label: 'Kitchen',
    dimensions_m2: 11.0,
    pin_x: 0.30, pin_y: 0.27,
    size: [3.8, 3.0],
    heading_offset: 0,
    palette: { wall: '#e8ebee', ceiling: '#fbfcfd', floor: '#8d9296', accent: '#2f6f5e' },
    features: [
      { type: 'window', wall: 0, u: 0.5, width: 1.2, sill: 1.1, height: 1.0 },
      { type: 'cabinet', wall: 1, u: 0.5, width: 2.2, sill: 0.0, height: 0.9 },
      { type: 'cabinet', wall: 1, u: 0.5, width: 2.2, sill: 1.6, height: 0.7 },
    ],
  },
  {
    id: 'demo-bedroom',
    label: 'Bedroom',
    dimensions_m2: 13.2,
    pin_x: 0.71, pin_y: 0.29,
    size: [4.0, 3.3],
    heading_offset: 0,
    palette: { wall: '#c9d3dd', ceiling: '#eef3f7', floor: '#a8825c', accent: '#3d5a80' },
    features: [
      { type: 'window', wall: 1, u: 0.5, width: 1.4, sill: 1.0, height: 1.3 },
      { type: 'art', wall: 3, u: 0.45, width: 0.7, sill: 1.4, height: 0.9 },
    ],
  },
  {
    id: 'demo-bathroom',
    label: 'Bathroom',
    dimensions_m2: 5.4,
    pin_x: 0.72, pin_y: 0.66,
    size: [2.6, 2.1],
    heading_offset: 0,
    palette: { wall: '#dfe4e6', ceiling: '#f7f9fa', floor: '#6f767b', accent: '#4a6b7c' },
    features: [
      { type: 'tile', wall: 1, u: 0.5, width: 2.0, sill: 0.0, height: 2.0 },
      { type: 'tile', wall: 3, u: 0.5, width: 2.0, sill: 0.0, height: 2.0 },
      { type: 'art', wall: 0, u: 0.5, width: 0.8, sill: 1.2, height: 0.7 },
    ],
  },
];

/* ------------------------------------------------------------------ geometry */

/** Pitch in radians -> pixel row. +pi/2 is the zenith (row 0). */
const rowForPitch = (pitch) => (0.5 - pitch / Math.PI) * PANO_H;

/**
 * Cast a ray at compass yaw `yawDeg` from the centre of a `w` x `d` room.
 * Returns which wall it hits, how far away that wall is, and where along the
 * wall it landed (0..1). Walls: 0 = north, 1 = east, 2 = south, 3 = west.
 */
function castRay(yawDeg, w, d) {
  const a = (yawDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = Math.cos(a);
  const hx = w / 2;
  const hy = d / 2;

  let best = { t: Infinity, wall: 0, u: 0.5 };

  const consider = (t, wall, u) => {
    if (t > 1e-6 && t < best.t) best = { t, wall, u };
  };

  if (dy > 1e-9) consider(hy / dy, 0, (hx + (hy / dy) * dx) / w);
  if (dx > 1e-9) consider(hx / dx, 1, (hy - (hx / dx) * dy) / d);
  if (dy < -1e-9) consider(-hy / dy, 2, (hx - (-hy / dy) * dx) / w);
  if (dx < -1e-9) consider(-hx / dx, 3, (hy + (-hx / dx) * dy) / d);

  return { distance: best.t, wall: best.wall, u: best.u };
}

/** Physical length of a wall, needed to turn a feature's metre width into a u-span. */
const wallLength = (wall, w, d) => (wall % 2 === 0 ? w : d);

/* -------------------------------------------------------------------- colour */

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(Math.min(255, Math.max(0, amount >= 0 ? c + (255 - c) * amount : c * (1 + amount))))
  );
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

/* ------------------------------------------------------------------ painting */

function paintRoom(spec, doorYawDeg) {
  const [w, d] = spec.size;
  const p = spec.palette;

  const canvas = document.createElement('canvas');
  canvas.width = PANO_W;
  canvas.height = PANO_H;
  const ctx = canvas.getContext('2d');

  // A doorway to the next room, placed on whichever wall that room lies behind.
  const features = spec.features.slice();
  if (doorYawDeg != null) {
    const hit = castRay(doorYawDeg, w, d);
    features.push({ type: 'door', wall: hit.wall, u: hit.u, width: 0.9, sill: 0, height: 2.05 });
  }

  const maxDist = Math.hypot(w, d) / 2;

  for (let x = 0; x < PANO_W; x++) {
    const yaw = (x / PANO_W) * 360;
    const { distance, wall, u } = castRay(yaw, w, d);

    const floorRow = rowForPitch(-Math.atan(CAMERA_HEIGHT_M / distance));
    const ceilRow = rowForPitch(Math.atan((CEILING_HEIGHT_M - CAMERA_HEIGHT_M) / distance));

    // Nearer surfaces catch more light; each wall gets its own bias so corners read.
    const near = 1 - distance / maxDist;
    const wallTone = [0.06, -0.05, -0.12, 0.0][wall] + near * 0.10;

    ctx.fillStyle = shade(p.ceiling, 0.02 + near * 0.05);
    ctx.fillRect(x, 0, 1, ceilRow);

    ctx.fillStyle = shade(p.wall, wallTone);
    ctx.fillRect(x, ceilRow, 1, floorRow - ceilRow);

    ctx.fillStyle = shade(p.floor, -0.15 + near * 0.25);
    ctx.fillRect(x, floorRow, 1, PANO_H - floorRow);

    // Skirting board - a thin band right at the wall/floor junction.
    ctx.fillStyle = shade(p.wall, 0.25);
    ctx.fillRect(x, floorRow - Math.max(2, 14 / distance), 1, Math.max(2, 14 / distance));

    for (const f of features) {
      if (f.wall !== wall) continue;
      const halfU = f.width / 2 / wallLength(wall, w, d);
      if (u < f.u - halfU || u > f.u + halfU) continue;

      const top = rowForPitch(Math.atan((f.sill + f.height - CAMERA_HEIGHT_M) / distance));
      const bottom = rowForPitch(Math.atan((f.sill - CAMERA_HEIGHT_M) / distance));
      ctx.fillStyle = featureFill(f, p, near);
      ctx.fillRect(x, top, 1, bottom - top);

      // Frame, so openings do not read as flat colour patches.
      ctx.fillStyle = shade(p.wall, -0.35);
      ctx.fillRect(x, top, 1, 2);
      ctx.fillRect(x, bottom - 2, 1, 2);
      if (u < f.u - halfU + 0.004 || u > f.u + halfU - 0.004) ctx.fillRect(x, top, 1, bottom - top);
    }
  }

  drawLabel(ctx, spec, w, d);
  addGrain(ctx);

  return canvas.toDataURL('image/jpeg', 0.86);
}

function featureFill(f, p, near) {
  switch (f.type) {
    case 'window': return `rgb(${226 + near * 20},${240},${252})`;
    case 'door': return shade(p.accent, -0.35);
    case 'cabinet': return shade(p.accent, 0.12);
    case 'tile': return shade(p.wall, 0.30);
    case 'art': return shade(p.accent, 0.05);
    default: return shade(p.wall, -0.2);
  }
}

/** Room name painted on the wall opposite the default view direction. */
function drawLabel(ctx, spec, w, d) {
  const yaw = 180;
  const { distance } = castRay(yaw, w, d);
  const x = PANO_W / 2;
  const y = rowForPitch(Math.atan((1.75 - CAMERA_HEIGHT_M) / distance));

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.round(96 / distance)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,.20)';
  ctx.fillText(spec.label.toUpperCase(), x, y + 3);
  ctx.fillStyle = shade(spec.palette.accent, -0.1);
  ctx.fillText(spec.label.toUpperCase(), x, y);
  ctx.restore();
}

/** A little luminance noise stops the flat fills looking like a CSS gradient. */
function addGrain(ctx) {
  const img = ctx.getImageData(0, 0, PANO_W, PANO_H);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    px[i] += n;
    px[i + 1] += n;
    px[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/* ---------------------------------------------------------------- floor plan */

function floorPlanDataUrl() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
  <rect width="400" height="300" fill="#f4f1ec"/>
  <g fill="#ffffff" stroke="#2a2f3a" stroke-width="4">
    <rect x="30" y="30" width="150" height="105"/>
    <rect x="30" y="135" width="150" height="135"/>
    <rect x="180" y="30" width="190" height="150"/>
    <rect x="180" y="180" width="190" height="90"/>
  </g>
  <g fill="#6b7280" font-family="Segoe UI, Roboto, sans-serif" font-size="12">
    <text x="105" y="78" text-anchor="middle">Kitchen</text>
    <text x="105" y="94" text-anchor="middle" font-size="10">11.0 m2</text>
    <text x="105" y="196" text-anchor="middle">Living Room</text>
    <text x="105" y="212" text-anchor="middle" font-size="10">24.5 m2</text>
    <text x="275" y="98" text-anchor="middle">Bedroom</text>
    <text x="275" y="114" text-anchor="middle" font-size="10">13.2 m2</text>
    <text x="275" y="222" text-anchor="middle">Bathroom</text>
    <text x="275" y="238" text-anchor="middle" font-size="10">5.4 m2</text>
  </g>
  <g stroke="#f4f1ec" stroke-width="6">
    <line x1="180" y1="70" x2="180" y2="100"/>
    <line x1="180" y1="200" x2="180" y2="230"/>
    <line x1="90" y1="135" x2="120" y2="135"/>
    <line x1="250" y1="180" x2="280" y2="180"/>
  </g>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* --------------------------------------------------------------------- public */

const panoCache = new Map();

/**
 * A tour object shaped exactly like the one `db.getTourBySlug()` returns, so
 * tour.js does not need to know whether it is showing real or demo data.
 */
export function getDemoTour() {
  return {
    id: 'demo',
    name: 'Solsiden 12B (demo)',
    address: 'Sample apartment - generated in your browser',
    share_slug: 'demo',
    is_published: true,
    floor_plan_url: floorPlanDataUrl(),
    is_demo: true,
    rooms: ROOMS.map((r, i) => ({
      id: r.id,
      label: r.label,
      dimensions_m2: r.dimensions_m2,
      pin_x: r.pin_x,
      pin_y: r.pin_y,
      heading_offset: r.heading_offset,
      sort_order: i,
      panorama_url: null, // resolved lazily by getDemoPanorama()
    })),
  };
}

/**
 * Paint (and cache) one demo room. Takes a moment on first call for each room,
 * which is why the viewer shows a loading state rather than doing all four upfront.
 */
export function getDemoPanorama(roomId, doorYawDeg) {
  const key = `${roomId}|${doorYawDeg == null ? '' : Math.round(doorYawDeg)}`;
  if (!panoCache.has(key)) {
    const spec = ROOMS.find((r) => r.id === roomId);
    if (!spec) throw new Error(`Unknown demo room: ${roomId}`);
    panoCache.set(key, paintRoom(spec, doorYawDeg));
  }
  return panoCache.get(key);
}

export const isDemoRoom = (id) => ROOMS.some((r) => r.id === id);
