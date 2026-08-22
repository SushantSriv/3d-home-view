/**
 * Floor plan with room pins. Shared by the studio (place/drag pins) and the tour
 * viewer (click a pin to enter a room).
 *
 * Pin coordinates are stored NORMALISED (0..1 of the image's width/height) rather
 * than in pixels, so the same plan renders correctly in a 300px dock on a phone and
 * in a full-width studio panel.
 */

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * @param {HTMLElement} el        container, gets class "floorplan"
 * @param {object}      opts
 * @param {string}     [opts.imageUrl]   floor plan image
 * @param {string}     [opts.emptyText]  shown when there is no image yet
 * @param {Array}       opts.rooms       [{ id, label, pin_x, pin_y, dimensions_m2 }]
 * @param {string}     [opts.activeId]   room to highlight
 * @param {boolean}    [opts.placing]    crosshair cursor; clicks call onPlace
 * @param {Function}   [opts.onPlace]    (x, y) normalised 0..1
 * @param {Function}   [opts.onPinClick] (room)
 * @param {Function}   [opts.onPinMove]  (room, x, y) enables drag-to-reposition
 */
export function renderFloorPlan(el, opts) {
  const {
    imageUrl, emptyText = 'No floor plan yet.',
    rooms = [], activeId = null,
    placing = false, onPlace, onPinClick, onPinMove,
  } = opts;

  el.classList.add('floorplan');
  el.classList.toggle('placing', !!placing);
  el.replaceChildren();

  if (!imageUrl) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = emptyText;
    el.append(empty);
    return;
  }

  const img = document.createElement('img');
  img.src = imageUrl;
  img.alt = 'Floor plan';
  img.draggable = false;
  el.append(img);

  // Normalised -> pixel conversion always goes through the container's own box, so
  // it stays correct while the image is still loading and after any resize.
  const toNormalised = (ev) => {
    const r = el.getBoundingClientRect();
    return {
      x: clamp01((ev.clientX - r.left) / r.width),
      y: clamp01((ev.clientY - r.top) / r.height),
    };
  };

  if (placing && onPlace) {
    el.onclick = (ev) => {
      if (ev.target.closest('.pin')) return; // clicking an existing pin is not placing
      const { x, y } = toNormalised(ev);
      onPlace(x, y);
    };
  } else {
    el.onclick = null;
  }

  rooms.forEach((room, i) => {
    if (room.pin_x == null || room.pin_y == null) return;

    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'pin' + (room.id === activeId ? ' active' : '');
    pin.style.left = `${room.pin_x * 100}%`;
    pin.style.top = `${room.pin_y * 100}%`;
    pin.textContent = String(i + 1);
    pin.setAttribute('aria-label', room.label || `Room ${i + 1}`);

    const tip = document.createElement('span');
    tip.className = 'tip';
    tip.textContent = room.dimensions_m2
      ? `${room.label} · ${room.dimensions_m2} m²`
      : room.label || `Room ${i + 1}`;
    pin.append(tip);

    if (onPinClick) pin.onclick = (ev) => { ev.stopPropagation(); onPinClick(room); };

    if (onPinMove) makeDraggable(pin, el, room, toNormalised, onPinMove);

    el.append(pin);
  });
}

/**
 * Pointer-events drag. Deliberately ignores movements under a few pixels so that a
 * sloppy tap still registers as a click rather than a no-op micro-drag.
 */
function makeDraggable(pin, container, room, toNormalised, onPinMove) {
  const DRAG_THRESHOLD_PX = 3;
  let start = null;
  let dragging = false;

  pin.style.touchAction = 'none';

  pin.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    start = { x: ev.clientX, y: ev.clientY };
    dragging = false;
    pin.setPointerCapture(ev.pointerId);
  });

  pin.addEventListener('pointermove', (ev) => {
    if (!start) return;
    if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD_PX) return;
    dragging = true;
    const { x, y } = toNormalised(ev);
    pin.style.left = `${x * 100}%`;
    pin.style.top = `${y * 100}%`;
  });

  const end = (ev) => {
    if (!start) return;
    const wasDragging = dragging;
    start = null;
    dragging = false;
    if (wasDragging) {
      ev.stopPropagation();
      const { x, y } = toNormalised(ev);
      onPinMove(room, x, y);
    }
  };
  pin.addEventListener('pointerup', end);
  pin.addEventListener('pointercancel', () => { start = null; dragging = false; });
}

/**
 * Compass bearing from one room's pin to another's, in Pannellum yaw degrees.
 *
 * Floor plan y grows downward, so "up the page" is treated as 0 deg and the angle
 * increases clockwise. `headingOffset` accounts for the fact that we have no idea
 * which way the phone was pointing when recording started - the studio exposes it
 * as a per-room dial.
 */
export function bearingBetween(from, to, headingOffset = 0) {
  const dx = to.pin_x - from.pin_x;
  const dy = to.pin_y - from.pin_y;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return normaliseYaw(deg + (headingOffset || 0));
}

/** Fold any angle into the -180..180 range Pannellum expects for yaw. */
export function normaliseYaw(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
