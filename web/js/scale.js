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
