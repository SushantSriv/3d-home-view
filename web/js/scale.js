/**
 * Putting a real scale on a panorama.
 *
 * A single-viewpoint panorama records DIRECTIONS, not distances. Nothing in the
 * pixels says whether that wall is two metres away or twenty, and any "size" read
 * straight out of one would be invented.
 *
 * What rescues it is the floor. The floor is a known plane at a known distance
 * below the camera, so for a level camera at height h, a floor point seen at
 * depression angle φ below the horizon is exactly
 *
 *     d = h / tan(φ)
 *
 * away. That is a real measurement, not an inference: the only assumption is h,
 * and this app already tells the seller to hold the phone at chest height. Get h
 * wrong by ten per cent and every distance is wrong by ten per cent - which is
 * what "roughly" buys, and roughly is what was asked for.
 *
 * Two things this relies on, and both are worth knowing about:
 *
 *   - The horizon must really be at the middle of the image. It is, for a phone
 *     held upright and level; a sweep taken tilted puts it elsewhere, and that is
 *     what v_offset records.
 *   - The declared vaov must be right, since it is what turns a pixel row into an
 *     angle. It comes from the lens, not from the sweep, so it is the sounder half
 *     of the geometry - but it is still an assumed 68 degrees.
 */

/**
 * Height of the phone above the floor, in metres.
 *
 * Chest height for a standing adult, which is what the capture instructions ask
 * for ("close to your chest"). Held at eye level this is nearer 1.6 and every
 * distance comes out about 10% short.
 */
export const ASSUMED_CAMERA_HEIGHT_M = 1.45;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Distance along the floor to whatever is at this pitch, in metres.
 * Null at or above the horizon, where the ray never meets the floor.
 */
export function floorDistance(pitchDeg, heightM = ASSUMED_CAMERA_HEIGHT_M) {
  if (pitchDeg > -1.2) return null;
  return heightM / Math.tan(-pitchDeg * RAD);
}

/** The inverse: how far below the horizon a floor point this far away appears. */
export function pitchForDistance(metres, heightM = ASSUMED_CAMERA_HEIGHT_M) {
  if (!(metres > 0)) return null;
  return -Math.atan(heightM / metres) * DEG;
}

/**
 * How far across a room of this area is, roughly.
 *
 * Rooms are not square, so this is a characteristic size rather than a
 * measurement - a 30 m² room reads as "about 5.5 m across". Stated that loosely
 * on purpose: the area is real, the shape is not known, and rounding to the
 * nearest tenth of a metre would imply otherwise.
 */
export function roomWidthFromArea(m2) {
  return m2 > 0 ? Math.sqrt(m2) : null;
}

/**
 * The NEAREST floor point a panorama with this geometry can show.
 *
 * Not the farthest, which is the intuitive reading and the wrong one. Distance
 * and depression angle run opposite ways - d = h/tan(φ) - so the bottom edge of
 * the image, being the steepest angle downwards, is the closest the floor gets to
 * being seen. Everything beyond it lies higher up the image, all the way to the
 * horizon.
 *
 * The consequence is a blind circle underfoot. A band 68 degrees tall from
 * 1.45 m up cannot see the floor within about 2.1 m of where the seller stood -
 * you cannot see your own feet - so that is where the rings have to start.
 */
export function floorNearest(vaovDeg, vOffsetDeg = 0, heightM = ASSUMED_CAMERA_HEIGHT_M) {
  return floorDistance(vOffsetDeg - vaovDeg / 2, heightM);
}

/**
 * Which distance rings are worth drawing.
 *
 * Only those outside the blind circle, and never so many that the floor turns
 * into graph paper.
 */
export function ringsFor(vaovDeg, vOffsetDeg = 0, heightM = ASSUMED_CAMERA_HEIGHT_M, max = 4) {
  const nearest = floorNearest(vaovDeg, vOffsetDeg, heightM);
  if (nearest == null) return []; // the band stops above the horizon: no floor in it
  const out = [];
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8]) {
    if (m < nearest * 1.05) continue;
    out.push(m);
  }
  return out.slice(0, max);
}

/** "3.2 m", or "85 cm" where metres would read as false precision. */
export function formatDistance(metres) {
  if (metres == null) return null;
  if (metres < 1) return `${Math.round(metres * 100)} cm`;
  return `${metres.toFixed(1)} m`;
}

/* =========================================================================
   Panorama geometry: what a viewport can be allowed to show
   =========================================================================

   Separate concern from the floor maths above, same subject: turning declared
   angles into something a viewer can be configured with. It lives here, and it
   is PURE, because the arithmetic that decides what a buyer is able to drag and
   zoom into is otherwise only testable by dragging.
   ========================================================================= */

export const FULL_CIRCLE_DEG = 360;
export const HALF_CIRCLE_DEG = 180;

/** How close to a full sphere still counts as one. Rounded exports miss by a hair. */
export const FULL_SPHERE_EPS = 0.1;

/** A phone sweep past this much of the circle is "the whole room" for our purposes. */
export const COMPLETE_SWEEP_DEG = 330;

/**
 * Below this width/height ratio a viewport is treated as portrait-shaped.
 *
 * This is the line between "the picture can fill the frame" and "making it fill
 * the frame costs the buyer the room". See panoramaConfig() for what changes.
 */
export const NARROW_ASPECT = 1.2;

/** Zoom range for a full sphere, where nothing constrains it but taste. */
export const DEFAULT_HFOV_DEG = 100;
export const MIN_HFOV_DEG = 50;
export const MAX_HFOV_DEG = 120;

/** Read a number that may arrive as a string, null, or missing entirely. */
function num(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** The declared angles of one room's panorama, with the full-sphere default. */
export function geometryOf(room = {}) {
  return {
    haov: num(room.haov, FULL_CIRCLE_DEG),
    vaov: num(room.vaov, HALF_CIRCLE_DEG),
    vOffset: num(room.v_offset, 0),
  };
}

/** True when the image really covers everything, so no partial config applies. */
export function isFullSphere(haov, vaov) {
  return (
    num(haov, FULL_CIRCLE_DEG) >= FULL_CIRCLE_DEG - FULL_SPHERE_EPS &&
    num(vaov, HALF_CIRCLE_DEG) >= HALF_CIRCLE_DEG - FULL_SPHERE_EPS
  );
}

/**
 * The hfov at which a band `vaovDeg` tall exactly fills a viewport of this shape.
 *
 * Zoom limits cannot be constants, because how much of the screen a panorama
 * covers depends entirely on the viewport's shape. A phone sweep is a band about
 * 68 degrees tall. On a 16:9 window an hfov of 100 works out at a 67.7 degree
 * vertical view, which fits almost exactly - so a fixed 100 looked fine and hid
 * the problem. Turn a phone upright and the SAME band only fills the frame at
 * 34.6 degrees, which is a keyhole into a slab of wall.
 */
export function fitHfov(vaovDeg, aspect) {
  return (2 * Math.atan(Math.tan((vaovDeg * Math.PI) / 360) * aspect) * 180) / Math.PI;
}

/**
 * Everything the viewer needs to know about how to frame one panorama.
 *
 * Pure: give it four numbers, get an object back. No DOM, no viewer, no globals.
 *
 * The hard case is an upright phone. Filling the frame and letting the buyer see
 * the room are in direct conflict there, and the old code always chose the first:
 * maxHfov was pinned to fitHfov(68, 0.46) = 34.6 degrees, and because Pannellum
 * re-derives that clamp from the live canvas on every zoom when
 * avoidShowingBackground is on, RAISING maxHfov alone changes nothing. The buyer
 * was locked at 34.6 degrees with a zoom control that did not work.
 *
 * The real fix is upstream, in the page: on a narrow screen the stage is given a
 * 4:3 box with the room navigation underneath, and a 68 degree band fills THAT at
 * about 84 degrees. So by the time this function sees a portrait aspect at all,
 * something unusual is going on - a very tall window, a browser without the
 * layout, fullscreen on an odd device. That is the case this handles:
 *
 *   aspect >= 1.2  fill the frame, and let Pannellum keep it filled as the
 *                  window changes shape (avoidShowingBackground).
 *   aspect <  1.2  filling the frame is not worth the price. Open at the fitted
 *                  hfov so the first sight is still the picture, then let the
 *                  buyer zoom out to 120 degrees over empty background. The
 *                  letterboxing is the honest report: the photo stops there.
 *                  avoidShowingBackground MUST be false or the ceiling is
 *                  ignored and zoom is a dead control again.
 *
 * @param {object}  g
 * @param {number} [g.haov]    horizontal angle the photo covers, degrees
 * @param {number} [g.vaov]    vertical angle the photo covers, degrees
 * @param {number} [g.vOffset] where the middle of that band sits, degrees
 * @param {number} [g.aspect]  width / height of the element it will be shown in
 */
export function panoramaConfig({ haov, vaov, vOffset, aspect } = {}) {
  const h = num(haov, FULL_CIRCLE_DEG);
  const v = num(vaov, HALF_CIRCLE_DEG);
  const o = num(vOffset, 0);
  const a = num(aspect, 16 / 9) > 0 ? num(aspect, 16 / 9) : 16 / 9;
  const narrow = a < NARROW_ASPECT;

  if (isFullSphere(h, v)) {
    return {
      partial: false,
      narrow,
      fit: null,
      hfov: DEFAULT_HFOV_DEG,
      minHfov: MIN_HFOV_DEG,
      maxHfov: MAX_HFOV_DEG,
      avoidShowingBackground: false,
    };
  }

  // How wide a view can get before empty background creeps in at the top and
  // bottom, or past the end of the sweep - whichever runs out first.
  const vertical = v < HALF_CIRCLE_DEG - FULL_SPHERE_EPS ? fitHfov(v, a) : FULL_CIRCLE_DEG;
  const fit = Math.min(vertical, h);

  const maxHfov = narrow ? Math.min(MAX_HFOV_DEG, h) : Math.min(MAX_HFOV_DEG, fit);
  const opening = narrow ? fit : Math.min(DEFAULT_HFOV_DEG, maxHfov);

  // Always leave a factor of two of zoom in hand, measured from where the view
  // actually opens. A fixed floor of 50 pins zooming altogether on a tall
  // viewport, where the whole usable range can sit below it.
  const minHfov = Math.max(1, Math.min(MIN_HFOV_DEG, opening / 2, maxHfov / 2));
  const hfov = clamp(opening, minHfov, maxHfov);

  const config = {
    partial: true,
    narrow,
    fit,
    haov: h,
    vaov: v,
    vOffset: o,
    hfov,
    minHfov,
    maxHfov,
    // Pannellum re-derives this every frame from the live canvas, so a resized
    // window or a rotated phone keeps the band filling the frame - which a value
    // computed once here cannot do. It is also what makes the ceiling above
    // meaningless, hence off in the narrow case.
    avoidShowingBackground: !narrow,
  };

  // Fence the view to what the panorama actually covers. A phone sweep that
  // stopped at 230 degrees leaves a third of the room missing, and letting
  // someone drag into that void is worse than simply not letting them.
  if (h < FULL_CIRCLE_DEG - FULL_SPHERE_EPS) {
    config.minYaw = -h / 2;
    config.maxYaw = h / 2;
    config.yaw = 0;
  }
  if (v < HALF_CIRCLE_DEG - FULL_SPHERE_EPS) {
    config.minPitch = o - v / 2;
    config.maxPitch = o + v / 2;
    config.pitch = o;
  }
  return config;
}
