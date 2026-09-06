/**
 * Public tour viewer.
 *
 *   tour.html?t=<slug>   a real tour from Supabase
 *   tour.html?demo=1     the browser-generated demo tour (no backend at all)
 *   tour.html?pano=<url> a single panorama, for eyeballing stitcher output
 *   ...&room=<slug>      deep link straight into one room
 *   ...&scale=1          open with the measuring tool already on
 *
 * No login, ever. This is the URL that goes in a finn.no listing, and it is
 * almost always opened on a phone held upright.
 *
 * Two things shape this file.
 *
 * FIRST, the page is a layout, not a canvas with things floating on it. On a
 * narrow screen the stage is a 4:3 box and the room navigation lives in a shelf
 * underneath it. That is what makes a 68-degree-tall phone sweep openable at 84
 * degrees instead of 34.6 - see panoramaConfig() in scale.js for why the
 * alternative was a keyhole the buyer could not zoom out of.
 *
 * SECOND, nothing here is allowed to leave the buyer stranded. A room that
 * fails to load dims its own canvas and leaves the plan and the chips working;
 * Back goes to the previous room rather than ejecting them to finn.no; and no
 * text from a library or a database ever reaches the page unescaped, because
 * this page is read by strangers who have no idea what a Supabase URL is.
 */

import { renderFloorPlan, bearingBetween } from './floorplan.js';
import { BUCKETS } from './config.js';
import {
  ASSUMED_CAMERA_HEIGHT_M,
  floorDistance,
  pitchForDistance,
  roomWidthFromArea,
  ringsFor,
  formatDistance,
  geometryOf,
  panoramaConfig,
  FULL_CIRCLE_DEG,
  FULL_SPHERE_EPS,
} from './scale.js';

const params = new URLSearchParams(location.search);

const els = {
  shell: document.getElementById('shell'),
  stage: document.getElementById('stage'),
  pano: document.getElementById('pano'),
  h1: document.getElementById('doc-h1'),
  tag: document.getElementById('tag'),
  actions: document.getElementById('actions'),
  measureBtn: document.getElementById('measure-btn'),
  next: document.getElementById('next'),
  share: document.getElementById('share'),
  fullscreen: document.getElementById('fullscreen'),
  dock: document.getElementById('dock'),
  dockLabel: document.getElementById('dock-label'),
  plan: document.getElementById('plan'),
  bar: document.getElementById('bar'),
  chips: document.getElementById('chips'),
  measure: document.getElementById('measure'),
  msg: document.getElementById('msg'),
  msgInner: document.getElementById('msg-inner'),
  boot: document.getElementById('boot'),
  scrimL: document.getElementById('scrim-l'),
  scrimR: document.getElementById('scrim-r'),
};

let tour = null;
let viewer = null;
let demo = null; // demo module, imported only when needed

/** The room the buyer is in. Only ever set once its panorama actually loaded. */
let currentId = null;
/** The room the canvas is showing. Diverges from currentId only after a failure. */
let shownId = null;
/** The room they asked for and are waiting on. */
let pendingId = null;
/** Guards against a slow room landing after a faster one was asked for. */
let mountToken = 0;

const roomSlugs = new Map(); // room id -> url slug
const prefetched = new Set();

/* ------------------------------------------------------------ small tools */

function node(tag, className, textContent) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (textContent != null) n.textContent = textContent;
  return n;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** Rooms are numbered by their place in the property, so plan pins, chips and
 *  the plaque all say the same number even when one room has no photo yet. */
const roomIndex = (room) => (tour?.rooms || []).indexOf(room);
const roomById = (id) => (tour?.rooms || []).find((r) => r.id === id) || null;
const currentRoom = () => roomById(pendingId ?? currentId);

/** A room can be walked into once its panorama resolves to something loadable. */
const canEnter = (room) => !!(room && (room.panoramaSrc || tour?.is_demo));
const viewable = () => (tour?.rooms || []).filter(canEnter);

/**
 * The database stores STORAGE PATHS, not URLs, so that the project can be renamed
 * without rewriting every row. Turn them into CDN URLs once, here, rather than at
 * each use site - forgetting one is how the viewer ended up asking GitHub Pages
 * for a panorama that lives in Supabase.
 *
 * The result goes in `panoramaSrc`. `panorama_url` keeps meaning what it means
 * everywhere else in the codebase - a storage path - because overwriting it here
 * made the same field mean two different things depending on who read it.
 */
function resolveStorageUrls(db, t) {
  t.floorPlanSrc = db.publicUrl(BUCKETS.floorPlans, t.floor_plan_url);
  for (const room of t.rooms || []) {
    room.panoramaSrc = db.publicUrl(BUCKETS.panoramas, room.panorama_url);
  }
}

/** Stable, readable per-room URL fragments, deduplicated by suffix. */
function buildRoomSlugs() {
  const used = new Set();
  (tour?.rooms || []).forEach((room, i) => {
    const base =
      String(room.label || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || `room-${i + 1}`;
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    roomSlugs.set(room.id, slug);
  });
}

/* ------------------------------------------------------------- messages */

/**
 * The one place any message reaches the buyer.
 *
 * Everything is built as text nodes rather than markup, so there is no path by
 * which a database string, a library error or a URL can be interpreted as HTML.
 *
 * `fatal` means the whole page is the message - a bad link, a paused project.
 * A room that failed to load is NOT fatal: it dims its own canvas and leaves
 * the floor plan and the room chips working, because the next room may be fine.
 */
function showMessage({ title, lines = [], actions = [], fatal = true }) {
  els.boot?.remove();

  const inner = els.msgInner;
  inner.replaceChildren(node('h1', null, title));
  for (const line of lines) if (line) inner.append(node('p', null, line));

  if (actions.length) {
    const row = node('p');
    for (const action of actions) {
      if (row.childNodes.length) row.append(document.createTextNode(' '));
      const btn = action.href ? node('a', null, action.label) : node('button', null, action.label);
      btn.className = `btn${action.primary ? ' primary' : ''}`;
      if (action.href) btn.href = action.href;
      else {
        btn.type = 'button';
        btn.addEventListener('click', action.onClick);
      }
      row.append(btn);
    }
    inner.append(row);
  }

  els.msg.classList.toggle('room-scoped', !fatal);
  els.msg.classList.remove('hidden');

  if (fatal) {
    els.msg.setAttribute('role', 'alertdialog');
    els.msg.setAttribute('aria-modal', 'true');
    els.shell.classList.add('solo');
    els.shell.classList.remove('nodock');
    els.bar.classList.add('hidden');
    els.tag.classList.add('hidden');
    els.actions.classList.add('hidden');
    els.dock.classList.add('hidden');
    els.measure.classList.add('hidden');
    els.msg.tabIndex = -1;
    els.msg.focus({ preventScroll: true });
  } else {
    els.msg.setAttribute('role', 'alert');
    els.msg.removeAttribute('aria-modal');
  }
}

function hideMessage() {
  els.msg.classList.add('hidden');
  els.msg.classList.remove('room-scoped');
  els.msg.removeAttribute('role');
  els.msg.removeAttribute('aria-modal');
}

let toastTimer = 0;

/** Transient, non-blocking, and never an alert() - which stops a phone dead. */
function toast(message, kind = '') {
  for (const old of document.querySelectorAll('.toast[data-tour]')) old.remove();

  const box = node('div', `toast${kind ? ` ${kind}` : ''}`);
  box.dataset.tour = '1';
  box.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  box.append(node('span', 'grow', message));

  const close = node('button', 'btn ghost sm x');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  const glyph = node('span', null, '×');
  glyph.setAttribute('aria-hidden', 'true');
  close.append(glyph);
  close.addEventListener('click', () => box.remove());
  box.append(close);

  document.body.append(box);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.remove(), 5200);
}


/* ------------------------------------------------------------- navigation */

/**
 * Doorway hotspots point at the two nearest other rooms on the floor plan. More
 * than that turns a small room into a wall of arrows.
 */
function neighboursOf(room) {
  if (room.pin_x == null || room.pin_y == null) return [];
  return viewable()
    .filter((r) => r.id !== room.id && r.pin_x != null && r.pin_y != null)
    .map((r) => ({ room: r, dist: Math.hypot(r.pin_x - room.pin_x, r.pin_y - room.pin_y) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 2)
    .map((n) => n.room);
}

async function enterRoom(roomId, { history: mode = 'push' } = {}) {
  const room = roomById(roomId);
  if (!room) return;
  if (!canEnter(room)) {
    toast(`${room.label || 'That room'} has no panorama yet.`);
    return;
  }
  if (room.id === shownId && !pendingId) {
    hideMessage(); // already here - the only thing left to undo is an error card
    return;
  }

  pendingId = room.id;
  hideMessage();
  renderTag(room, { loading: true });
  renderChips();

  const geometry = geometryOf(room);
  const neighbours = neighboursOf(room);
  const bearings = neighbours.map((n) => ({
    room: n,
    yaw: bearingBetween(room, n, room.heading_offset || 0),
  }));

  let panoramaUrl = room.panoramaSrc;
  if (tour.is_demo) {
    await nextFrame(); // let the plaque render before the synchronous paint blocks
    panoramaUrl = demo.getDemoPanorama(room.id, bearings[0]?.yaw);
  }

  await mountViewer(panoramaUrl, geometry, {
    hotSpots: doorHotspots(bearings, geometry.haov),
    onLoad: () => commitRoom(room, mode),
    onError: () => failRoom(room),
  });
}

/**
 * Only here does the app's idea of where the buyer is actually move. Doing it
 * on the tap instead meant one failed image left the plaque, the plan and the
 * Next button all pointing at a room nobody could see.
 */
function commitRoom(room, mode) {
  currentId = room.id;
  shownId = room.id;
  pendingId = null;
  els.boot?.remove();
  hideMessage();

  renderTag(room);
  renderDock();
  renderChips();
  layout();
  pushRoomToHistory(room, mode);
  document.title = `${room.label} · ${tour.name} — 360° tour`;

  if (scaleOn) {
    drawRings(room);
    showMeasureHint(room);
  }
  updateScrims();
  watchScrims();
  prefetchNeighbours(room);
}

/** A room that would not load. The canvas is the casualty; the rest still works. */
function failRoom(room) {
  pendingId = null;
  shownId = null; // the canvas holds a room nobody can see; anything may remount
  const back = roomById(currentId);
  if (back) renderTag(back);
  renderChips();

  const others = viewable().filter((r) => r.id !== room.id);
  showMessage({
    fatal: false,
    title: 'This room would not load',
    lines: [
      `The panorama for ${room.label} could not be fetched. It may still be uploading, or the connection dropped.`,
      others.length ? 'The other rooms are still available.' : '',
    ],
    actions: [
      { label: 'Try again', primary: true, onClick: () => enterRoom(room.id, { history: 'none' }) },
      ...(back && back.id !== room.id
        ? [{ label: `Back to ${back.label}`, onClick: () => enterRoom(back.id, { history: 'none' }) }]
        : []),
    ],
  });
}

/* -------------------------------------------------------------- history */

function pushRoomToHistory(room, mode) {
  if (mode === 'none') return;
  // A child browsing context writes into the TOP-LEVEL session history, so the
  // demo embedded in the landing page's hero would make the browser's Back
  // button walk backwards through rooms the visitor explored in a 340px frame
  // instead of leaving the page. Measured: history.length 2 -> 3 after one
  // doorway click. Embedded, we replace rather than push.
  const embedded = window.top !== window.self;
  if (embedded) mode = 'replace';
  try {
    const url = new URL(location.href);
    url.searchParams.set('room', roomSlugs.get(room.id) || room.id);
    if (mode === 'replace' || url.href === location.href) {
      history.replaceState({ roomId: room.id }, '', url);
    } else {
      history.pushState({ roomId: room.id }, '', url);
    }
  } catch (err) {
    console.error(err); // a missing History API is not worth failing the tour over
  }
}

function roomFromLocation() {
  const want = new URLSearchParams(location.search).get('room');
  if (!want) return null;
  for (const room of tour?.rooms || []) {
    if (roomSlugs.get(room.id) === want || room.id === want) return canEnter(room) ? room : null;
  }
  return null;
}

// Back must move between rooms. Before this it ejected the buyer straight back
// to the finn.no listing they came from, one tap after arriving.
window.addEventListener('popstate', () => {
  const room = roomFromLocation() || viewable()[0];
  if (room && room.id !== currentId) enterRoom(room.id, { history: 'none' });
});

/* ----------------------------------------------------------------- chrome */

function renderTag(room, { loading = false } = {}) {
  const n = roomIndex(room) + 1;
  const total = (tour?.rooms || []).length;
  const label = room.label || `Room ${n}`;

  const parts = [];
  if (room.dimensions_m2) parts.push(`${room.dimensions_m2} m²`);
  if (total > 1) parts.push(`${n}/${total}`);

  els.tag.replaceChildren(
    node('div', 'rm', label),
    node('div', 'sz', loading ? 'Loading…' : parts.join(' · '))
  );
  // "1/4" is a plaque, not a sentence. Spell it out for anyone listening.
  els.tag.setAttribute(
    'aria-label',
    [
      label,
      room.dimensions_m2 ? `${room.dimensions_m2} square metres` : '',
      total > 1 ? `room ${n} of ${total}` : '',
      loading ? 'loading' : '',
    ]
      .filter(Boolean)
      .join(', ')
  );
  els.tag.classList.remove('hidden');
  els.pano.setAttribute('aria-label', `360 degree photograph of ${label}`);
}

/**
 * The room switcher. This is the primary navigation on a phone and it has to
 * work with no floor plan at all, which the collapsed plan drawer never did.
 */
function renderChips() {
  const rooms = tour?.rooms || [];
  const enterable = viewable();
  els.chips.replaceChildren();
  if (enterable.length < 2) return;

  const activeId = pendingId ?? currentId;
  rooms.forEach((room, i) => {
    const chip = node('button', `roomchip${canEnter(room) ? '' : ' empty'}`);
    chip.type = 'button';
    chip.append(node('span', 'n', String(i + 1)), node('span', 't', room.label || `Room ${i + 1}`));

    if (canEnter(room)) {
      if (room.id === activeId) {
        chip.setAttribute('aria-current', 'true');
        queueMicrotask(() => chip.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      }
      chip.setAttribute('aria-label', `${room.label || `Room ${i + 1}`}, room ${i + 1}`);
      chip.addEventListener('click', () => enterRoom(room.id));
    } else {
      // Not enterable, but still shown: the buyer should be able to see that a
      // room exists and simply has no photograph yet.
      chip.setAttribute('aria-disabled', 'true');
      chip.setAttribute('aria-label', `${room.label || `Room ${i + 1}`}, no panorama yet`);
      chip.addEventListener('click', () =>
        toast(`${room.label || 'That room'} has no panorama yet.`)
      );
    }
    els.chips.append(chip);
  });
}

let dockDefaulted = false;

function renderDock() {
  if (!tour?.floorPlanSrc) {
    els.dock.classList.add('hidden');
    return;
  }
  els.dock.classList.remove('hidden');

  // Fold the plan away where it would cover its own subject - a phone held
  // sideways, which is exactly how one is held to look at a panorama. Only the
  // first render decides; re-folding it on every room would undo the buyer's
  // own choice. Upright phones get the shelf instead and need no folding.
  if (!dockDefaulted) {
    dockDefaulted = true;
    if (window.matchMedia('(max-height: 520px)').matches) els.dock.open = false;
  }

  const n = (tour.rooms || []).findIndex((r) => r.id === (pendingId ?? currentId)) + 1;
  const total = (tour.rooms || []).length;
  els.dockLabel.textContent =
    n > 0 && total > 1 ? `Floor plan · room ${n} of ${total}` : 'Floor plan';

  renderFloorPlan(els.plan, {
    imageUrl: tour.floorPlanSrc,
    rooms: tour.rooms,
    activeId: pendingId ?? currentId,
    onPinClick: (room) => enterRoom(room.id),
  });
  markPins();
}

/**
 * renderFloorPlan is shared with the studio and knows nothing about panoramas,
 * so the buyer-only distinction - which pins can actually be walked into - is
 * applied here, over the pins it just drew, in the same order it drew them.
 */
function markPins() {
  const pinned = (tour.rooms || []).filter((r) => r.pin_x != null && r.pin_y != null);
  const pins = els.plan.querySelectorAll('.pin');
  pins.forEach((pin, i) => {
    const room = pinned[i];
    if (!room) return;
    if (room.id === (pendingId ?? currentId)) pin.setAttribute('aria-current', 'true');
    if (!canEnter(room)) {
      pin.classList.add('empty');
      pin.setAttribute('aria-disabled', 'true');
      pin.setAttribute('aria-label', `${room.label}, no panorama yet`);
    }
  });
}

/* ------------------------------------------------------------- controls */

function wireControls() {
  els.next.addEventListener('click', () => {
    const list = viewable();
    if (list.length < 2) return;
    const i = list.findIndex((r) => r.id === (pendingId ?? currentId));
    enterRoom(list[(i + 1) % list.length].id);
  });
  if (viewable().length < 2) els.next.classList.add('hidden');

  els.measureBtn.addEventListener('click', () => setScale(!scaleOn));
  els.share.addEventListener('click', shareTour);

  if (els.shell.requestFullscreen) {
    els.fullscreen.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await els.shell.requestFullscreen();
      } catch (err) {
        console.error(err);
      }
    });
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement;
      els.fullscreen.setAttribute('aria-pressed', String(on));
      els.fullscreen.title = on ? 'Leave full screen' : 'Full screen';
      els.fullscreen.setAttribute('aria-label', els.fullscreen.title);
    });
  } else {
    els.fullscreen.classList.add('hidden'); // iOS Safari, and anything in an iframe
  }

  // n / PageDown and m only. Pannellum captures ArrowRight (39) and s (83) on
  // the focused container without stopping propagation, so the old bindings
  // made Right both pan the room and teleport out of it.
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (key === 'n' || key === 'PageDown') els.next.click();
    else if (key === 'm') els.measureBtn.click();
    else if (key === 'Escape' && els.msg.classList.contains('room-scoped')) hideMessage();
  });

  // Dragging the panorama ends in a click too, so only treat it as a tap when
  // the pointer barely moved - otherwise every look around measures something.
  let downAt = null;
  els.pano.addEventListener('pointerdown', (ev) => {
    downAt = [ev.clientX, ev.clientY];
    watchScrims();
  });
  els.pano.addEventListener('click', (ev) => {
    if (!downAt) return;
    const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
    downAt = null;
    if (moved <= 6) onPanoClick(ev);
  });
  els.pano.addEventListener('wheel', watchScrims, { passive: true });
  els.pano.addEventListener('keydown', watchScrims);

  els.dock.addEventListener('toggle', positionMeasure);

  window.addEventListener('offline', () =>
    toast('You are offline. The rooms already loaded still work.', 'err')
  );
  window.addEventListener('online', () => toast('Back online.', 'ok'));

  // The stage changes shape without the window doing so - the shelf appearing,
  // a room chip strip arriving, fullscreen. The zoom limits are derived from
  // that shape, so they have to follow it.
  let sized = 0;
  const onResize = () => {
    cancelAnimationFrame(sized);
    sized = requestAnimationFrame(() => {
      viewer?.resize?.();
      syncViewportBounds();
      positionMeasure();
      updateScrims();
    });
  };
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(els.stage);
  window.addEventListener('resize', () => layout());
  window.addEventListener('orientationchange', () => layout());
}

async function shareTour() {
  const url = location.href;
  const data = {
    title: tour?.name ? `${tour.name} — 360° tour` : '360° Home Tour',
    text: tour?.address || 'Walk through this home in 360 degrees.',
    url,
  };
  try {
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      await navigator.share(data);
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return; // the buyer closed the share sheet
    console.error(err);
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied.', 'ok');
  } catch (err) {
    console.error(err);
    // navigator.clipboard is undefined on any plain-http preview, which is the
    // first thing anyone tests on. Never write the URL into the button itself.
    toast('Copy the link from the address bar.', 'err');
  }
}

/* ------------------------------------------------------------------ layout */

const narrowQuery = window.matchMedia('(max-width: 760px) and (orientation: portrait)');
const compactQuery = window.matchMedia('(max-width: 639px)');

/**
 * Decides where the floor plan lives and how much room the photograph gets.
 *
 * On an upright phone the plan moves OUT of the picture and into the shelf
 * below it, next to the room chips. That is what buys the stage its 4:3 shape,
 * and the 4:3 shape is what makes the panorama openable at all.
 */
function layout() {
  const hasChips = els.chips.childElementCount > 0;
  const hasDock = !els.dock.classList.contains('hidden');
  const plansBelow = narrowQuery.matches && hasDock;

  const home = plansBelow ? els.bar : els.stage;
  if (els.dock.parentElement !== home) home.append(els.dock);

  const shelf = hasChips || plansBelow;
  els.bar.classList.toggle('hidden', !shelf);
  els.shell.classList.toggle('solo', !shelf);
  els.shell.classList.toggle('nodock', shelf && !plansBelow && narrowQuery.matches);

  // Four labelled buttons and a plaque do not both fit across a phone. The
  // icons carry the meaning there; the chips below carry the navigation.
  for (const label of els.actions.querySelectorAll('.lbl')) {
    label.classList.toggle('hidden', compactQuery.matches);
  }

  positionMeasure();
  syncViewportBounds();
}

for (const query of [narrowQuery, compactQuery]) {
  query.addEventListener('change', () => layout());
}

/**
 * Keep the distance readout off the floor plan's tap target.
 *
 * A `?scale=1` link used to be unnavigable: the measure card sat over the plan
 * drawer and swallowed the tap that would have opened it.
 */
function positionMeasure() {
  els.measure.style.removeProperty('bottom');
  if (els.measure.classList.contains('hidden')) return;
  if (els.dock.classList.contains('hidden') || els.dock.parentElement !== els.stage) return;

  const card = els.measure.getBoundingClientRect();
  const dock = els.dock.getBoundingClientRect();
  const overlaps =
    card.left < dock.right && card.right > dock.left && card.top < dock.bottom && card.bottom > dock.top;
  if (!overlaps) return;
  els.measure.style.bottom = `calc(${Math.round(dock.height)}px + var(--sp-5) + env(safe-area-inset-bottom))`;
}

/* ----------------------------------------------------------------- viewer */

/**
 * Pannellum is 66 kB of JavaScript plus its stylesheet, and four of the exits
 * from this page - bad link, unpublished, nothing ready, no link at all - are
 * text and never need any of it. So it is fetched here, once, on the first
 * panorama that is actually going to be shown.
 */
let pannellumPromise = null;

function loadPannellum() {
  if (pannellumPromise) return pannellumPromise;
  pannellumPromise = new Promise((resolve, reject) => {
    if (window.pannellum) return resolve(window.pannellum);

    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'vendor/pannellum/pannellum.css';
    document.head.append(css);

    const script = document.createElement('script');
    script.src = 'vendor/pannellum/pannellum.js';
    script.onload = () =>
      window.pannellum
        ? resolve(window.pannellum)
        : reject(new Error('pannellum.js loaded but registered nothing'));
    script.onerror = () => reject(new Error('pannellum.js could not be fetched'));
    document.head.append(script);
  });
  return pannellumPromise;
}

/** English, and with no %s in it: the vendor builds that placeholder out of an
 *  element's outerHTML, so buyers were shown literal angle brackets and the
 *  project's Supabase address when an image 404'd. */
const VIEWER_STRINGS = {
  loadButtonLabel: 'Show this room',
  loadingLabel: 'Loading…',
  bylineLabel: '',
  noPanoramaError: 'No panorama was given for this room.',
  fileAccessError: 'The panorama for this room could not be loaded.',
  malformedURLError: 'The panorama address for this room is not valid.',
  iOS8WebGLError: 'This version of iOS cannot display this panorama.',
  genericWebGLError: 'This browser cannot display 360 photographs.',
  textureSizeError: 'This panorama is larger than this device can display.',
  unknownError: 'This room could not be displayed.',
};

/** The stage's own shape, which is what the panorama is fitted to - not the
 *  window's, which stopped being the same thing the moment the shelf existed. */
function stageAspect() {
  const box = els.stage.getBoundingClientRect();
  return box.width > 0 && box.height > 0 ? box.width / box.height : 16 / 9;
}

function doorHotspots(bearings, haov) {
  // Roughly half of all plan bearings point outside a 230-degree sweep. Rather
  // than placing an arrow the buyer can never turn to, pin it at the edge of
  // what was photographed and say that is the direction.
  const limit = haov / 2 - 10;
  return bearings.map(({ room: target, yaw }) => {
    const beyond = Number.isFinite(limit) && limit > 0 && Math.abs(yaw) > limit;
    const label = target.dimensions_m2
      ? `${target.label} · ${target.dimensions_m2} m²`
      : target.label;
    return {
      pitch: -3,
      yaw: beyond ? Math.sign(yaw) * limit : yaw,
      cssClass: 'hs-door',
      createTooltipFunc: (div) => {
        div.append(node('span', 'lbl', beyond ? `${label} — this way` : label));
        // A title attribute never appears on a touch screen, and neither does
        // a hover state, so the hotspot has to be reachable and named itself.
        div.setAttribute('role', 'link');
        div.setAttribute('aria-label', `Go to ${label}`);
        div.tabIndex = 0;
        div.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            enterRoom(target.id);
          }
        });
      },
      clickHandlerFunc: () => enterRoom(target.id),
    };
  });
}

async function mountViewer(panoramaUrl, geometry = {}, { hotSpots = [], onLoad, onError } = {}) {
  const token = ++mountToken;

  let pannellum;
  try {
    pannellum = await loadPannellum();
  } catch (err) {
    console.error(err);
    return showMessage({
      title: 'The 360 viewer could not start',
      lines: ['Part of the page failed to download. A reload usually fixes it.'],
      actions: [{ label: 'Reload', primary: true, onClick: () => location.reload() }],
    });
  }
  if (token !== mountToken) return;

  clearRings();
  try {
    viewer?.destroy();
  } catch (err) {
    console.error(err);
  }
  viewer = null;

  const fitted = panoramaConfig({ ...geometry, aspect: stageAspect() });
  const { partial, narrow, fit, ...pannellumKeys } = fitted;

  const config = {
    type: 'equirectangular',
    panorama: panoramaUrl,
    autoLoad: true,
    // Our own controls live in .tour-actions. The vendor's are two white
    // 2011-era boxes that sat half-clipped under our plaque.
    showZoomCtrl: false,
    showFullscreenCtrl: false,
    showControls: false,
    keyboardZoom: true,
    friction: 0.15,
    backgroundColor: [0.024, 0.027, 0.039],
    strings: VIEWER_STRINGS,
    hotSpots,
    ...pannellumKeys,
  };

  // Only meaningful for remote images; setting it on a data: URL is pointless noise.
  if (/^https?:/i.test(panoramaUrl)) config.crossOrigin = 'anonymous';

  try {
    viewer = pannellum.viewer(els.pano, config);
  } catch (err) {
    console.error(err);
    onError?.(err);
    return;
  }

  viewer.on('load', () => {
    if (token !== mountToken) return;
    onLoad?.();
  });
  viewer.on('error', (err) => {
    // Never rendered. It is built from an element's outerHTML upstream, and it
    // names the storage host, which is nothing a buyer can act on.
    console.error('Pannellum could not load the panorama:', err);
    if (token !== mountToken) return;
    if (onError) onError(err);
    else
      showMessage({
        title: 'This panorama would not load',
        lines: ['The image could not be fetched.'],
        actions: [{ label: 'Try again', primary: true, onClick: () => location.reload() }],
      });
  });
  for (const event of ['zoomchange', 'mousedown', 'touchstart', 'animatefinished']) {
    viewer.on(event, watchScrims);
  }
}

/**
 * Re-fit the zoom limits to the stage's current shape.
 *
 * Pannellum recomputes its own ceiling from the live canvas while
 * avoidShowingBackground is on, but the bounds and the flag itself are ours,
 * and they change when a phone is rotated or the shelf appears.
 */
function syncViewportBounds() {
  if (!viewer) return;
  const room = currentRoom();
  const fitted = panoramaConfig({ ...geometryOf(room || {}), aspect: stageAspect() });
  if (!fitted.partial) return;
  try {
    const live = viewer.getConfig();
    live.avoidShowingBackground = fitted.avoidShowingBackground;
    viewer.setHfovBounds([fitted.minHfov, fitted.maxHfov]);
    if (viewer.getHfov() > fitted.maxHfov) viewer.setHfov(fitted.maxHfov, 0);
  } catch (err) {
    console.error(err);
  }
}

function showSinglePanorama(url) {
  document.title = 'Panorama preview';
  els.shell.classList.add('solo');
  els.tag.replaceChildren(
    node('div', 'rm', 'Panorama preview'),
    node('div', 'sz mono', url)
  );
  els.tag.classList.remove('hidden');
  mountViewer(url, {}, { onLoad: () => els.boot?.remove() });
}

/* ------------------------------------------------------- edge of the sweep */

/**
 * A 230-degree panorama has two ends, and running into one of them silently
 * reads as a broken page. These fade a soft edge in as the buyer approaches,
 * so it reads as the end of what was photographed.
 */
let scrimFrame = 0;
let scrimIdle = 0;
let scrimYaw = null;
let edgeAnnounced = false;

const EDGE_FADE_DEG = 14;

/**
 * The extra degrees Pannellum keeps in hand at each end of a partial sweep.
 *
 * With avoidShowingBackground on it pulls the yaw fence in by this much so that
 * a tilted view never exposes the empty band at the corner of the frame. This
 * mirrors that calculation (vendor/pannellum/pannellum.js, the yaw clamp in its
 * render loop) because the number is not exposed, and the edge scrim has to
 * agree with the wall the buyer actually hits. pannellum.js is vendored in this
 * repository, so this cannot drift underneath us; and if it ever did, the scrim
 * would simply fade a little early or late.
 */
function edgeSlackDeg(config) {
  if (!config.avoidShowingBackground || !viewer) return 0;
  // The viewer object exposes no canvas getter; the renderer's is not public
  // either. The element itself is, and its ratio is all this needs.
  const canvas = els.pano.querySelector('canvas');
  if (!canvas || !canvas.height) return 0;
  const rad = Math.PI / 180;
  const half = viewer.getHfov() / 2;
  const tilt = Math.atan2(Math.tan(half * rad), canvas.width / canvas.height) / rad;
  const pitch = viewer.getPitch();
  return half * (1 - Math.min(Math.cos((pitch - tilt) * rad), Math.cos((pitch + tilt) * rad)));
}

function updateScrims() {
  const config = viewer?.getConfig?.();
  const span = config ? config.maxYaw - config.minYaw : NaN;
  if (!config || !Number.isFinite(span) || span >= FULL_CIRCLE_DEG - FULL_SPHERE_EPS) {
    els.scrimL.style.opacity = '0';
    els.scrimR.style.opacity = '0';
    return;
  }

  // Pannellum fences the view's EDGES, not its centre, so the reachable band of
  // centre yaws shrinks as the buyer zooms out - and shrinks again by the slack
  // below. Without both terms the scrim tops out around half strength at a wall
  // the buyer cannot actually push past, which reads as a hesitation rather
  // than as an end.
  const half = viewer.getHfov() / 2;
  const slack = edgeSlackDeg(config);
  const low = config.minYaw + half + slack;
  const high = config.maxYaw - half - slack;
  const yaw = viewer.getYaw();

  const left = high <= low ? 1 : Math.min(1, Math.max(0, (EDGE_FADE_DEG - (yaw - low)) / EDGE_FADE_DEG));
  const right = high <= low ? 1 : Math.min(1, Math.max(0, (EDGE_FADE_DEG - (high - yaw)) / EDGE_FADE_DEG));
  els.scrimL.style.opacity = String(left);
  els.scrimR.style.opacity = String(right);

  if (!edgeAnnounced && Math.max(left, right) > 0.96 && currentId) {
    edgeAnnounced = true;
    toast('That is as far as this photo reaches.');
  }
}

/** Runs only while the view is actually moving, then stops on its own. */
function watchScrims() {
  if (scrimFrame) {
    scrimIdle = 0;
    return;
  }
  const tick = () => {
    scrimFrame = 0;
    if (!viewer) return;
    let yaw = null;
    try {
      yaw = viewer.getYaw();
    } catch {
      return;
    }
    if (scrimYaw === null || Math.abs(yaw - scrimYaw) > 0.01) {
      scrimYaw = yaw;
      scrimIdle = 0;
    } else {
      scrimIdle += 1;
    }
    updateScrims();
    if (scrimIdle < 40) scrimFrame = requestAnimationFrame(tick);
  };
  scrimIdle = 0;
  scrimFrame = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ prefetch */

/** The next room is nearly always the next tap. Fetch it while they look around. */
function prefetchNeighbours(room) {
  if (tour?.is_demo) return;
  const list = viewable();
  const i = list.findIndex((r) => r.id === room.id);
  const candidates = [
    ...neighboursOf(room),
    list[(i + 1) % list.length],
    list[(i - 1 + list.length) % list.length],
  ];
  for (const target of candidates) {
    if (!target || target.id === room.id || !target.panoramaSrc) continue;
    if (prefetched.has(target.id)) continue;
    prefetched.add(target.id);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.src = target.panoramaSrc;
  }
}

/* ------------------------------------------------------------------ scale */

/**
 * Real distances, from the floor.
 *
 * See scale.js for why this works at all. The short of it: the panorama itself
 * has no scale, but the floor is a plane at a known height below the camera, so
 * a depression angle converts straight into metres. Everything here is that one
 * identity, wearing a user interface.
 */
let scaleOn = false;
let ringIds = [];
let measureTimer = 0;

/** Yaws at which to label a ring, kept inside what the panorama actually covers. */
function ringBearings(room) {
  const { haov } = geometryOf(room);
  if (haov >= FULL_CIRCLE_DEG - FULL_SPHERE_EPS) return [0, 60, 120, 180, 240, 300];
  const half = haov / 2 - 6;
  const out = [];
  for (let y = -half; y <= half + 0.001; y += Math.max(30, (2 * half) / 4)) out.push(y);
  return out;
}

function clearRings() {
  for (const id of ringIds) {
    try {
      viewer?.removeHotSpot(id);
    } catch (err) {
      console.error(err); // the viewer was already torn down; the nodes went with it
    }
  }
  ringIds = [];
}

function drawRings(room) {
  clearRings();
  if (!scaleOn || !viewer || !room) return;

  const { vaov, vOffset } = geometryOf(room);
  const distances = ringsFor(vaov, vOffset);
  if (!distances.length) return;

  const bearings = ringBearings(room);
  for (const metres of distances) {
    const pitch = pitchForDistance(metres);
    if (pitch == null || pitch < vOffset - vaov / 2 || pitch > vOffset + vaov / 2) continue;
    for (const yaw of bearings) {
      const id = `ring-${metres}-${Math.round(yaw)}`;
      try {
        viewer.addHotSpot({
          id,
          pitch,
          yaw,
          cssClass: 'hs-ring',
          // Pannellum hands the hotspot's own div to this hook, so the label
          // rides on the marker as a data attribute rather than becoming a
          // hover tooltip - there is no hovering on a phone.
          createTooltipFunc: (div) => {
            div.dataset.m = `${metres} m`;
          },
        });
        ringIds.push(id);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

function setScale(on, { silent = false } = {}) {
  // First thing, unconditionally. Without it a pending "back to the hint"
  // timer fired four seconds after the buyer switched measuring off and put
  // the whole card back on screen.
  clearTimeout(measureTimer);

  scaleOn = !!on;
  els.measureBtn.classList.toggle('on', scaleOn);
  els.measureBtn.setAttribute('aria-pressed', String(scaleOn));

  if (silent) return;

  const room = currentRoom();
  if (!scaleOn) {
    els.measure.classList.add('hidden');
    clearRings();
  } else {
    drawRings(room);
    showMeasureHint(room);
  }
  positionMeasure();
}

function showMeasureHint(room = currentRoom()) {
  if (!scaleOn) return; // the buyer turned this off while a timer was in flight
  clearTimeout(measureTimer);

  const across = room?.dimensions_m2 ? roomWidthFromArea(Number(room.dimensions_m2)) : null;
  const caveat = [
    // A characteristic size, not a measurement: the area is real but the shape
    // is not known, so this is hedged and rounded to half a metre.
    across ? `about ${(Math.round(across * 2) / 2).toFixed(1)} m across` : '',
    `assumes the phone was held about ${ASSUMED_CAMERA_HEIGHT_M.toFixed(2)} m up`,
  ]
    .filter(Boolean)
    .join(' · ');

  const line = node('span');
  line.append(node('b', null, 'Tap the floor'), document.createTextNode(' to measure from where the camera stood'));
  els.measure.replaceChildren(line, node('i', null, caveat));
  els.measure.classList.remove('hidden');
  positionMeasure();
}

/**
 * Turn a tap into a distance.
 *
 * Only the floor can answer: a ray at or above the horizon never meets it, and
 * one just below meets it so far away that the number is meaningless, which is
 * why floorDistance() refuses above -1.2 degrees rather than returning a very
 * large number and looking confident about it.
 */
function onPanoClick(ev) {
  if (!scaleOn || !viewer) return;
  let coords;
  try {
    coords = viewer.mouseEventToCoords(ev);
  } catch (err) {
    console.error(err);
    return;
  }
  if (!coords) return;
  const metres = floorDistance(coords[0]);

  clearTimeout(measureTimer);
  if (metres == null) {
    els.measure.replaceChildren(
      node('span', null, 'That is at or above eye level'),
      node('i', null, 'only the floor can be measured this way')
    );
  } else {
    const line = node('span');
    line.append(node('b', null, formatDistance(metres)), document.createTextNode(' away'));
    els.measure.replaceChildren(line, node('i', null, 'floor, from where the camera stood'));
  }
  els.measure.classList.remove('hidden');
  positionMeasure();
  measureTimer = setTimeout(() => showMeasureHint(), 4000);
}

/* ------------------------------------------------------------------ boot */

/* boot() runs LAST in this file, on purpose.

   It is the only top-level statement that reaches into the rest of the module
   synchronously - `tour.html?pano=<url>` mounts a viewer without awaiting
   anything first - and every `let` below it is in its temporal dead zone until
   evaluation gets there. Declared at the top, that path threw
   "Cannot access 'pannellumPromise' before initialization" and the buyer was
   told the viewer could not start. */

/** A paused free-tier Supabase project takes tens of seconds to wake up. */
function withTimeout(promise, ms) {
  let timer = 0;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { isTimeout: true })), ms);
    }),
  ]);
}

(async function boot() {
  try {
    if (params.get('demo') !== null) {
      demo = await import('./demo.js');
      tour = demo.getDemoTour();
      tour.floorPlanSrc = tour.floor_plan_url;
    } else if (params.get('pano')) {
      return showSinglePanorama(params.get('pano'));
    } else if (params.get('t')) {
      const db = await import('./db.js');
      try {
        tour = await withTimeout(db.getTourBySlug(params.get('t')), 25000);
      } catch (err) {
        console.error(err);
        return showMessage({
          title: 'Could not load this tour',
          lines: [
            err?.isTimeout
              ? 'The database did not answer. It may be waking up after a quiet spell - this usually works on a second try.'
              : db.humanError(err),
          ],
          actions: [
            { label: 'Try again', primary: true, onClick: () => location.reload() },
            { label: 'See the demo tour', href: 'tour.html?demo=1' },
          ],
        });
      }
      if (!tour) {
        return showMessage({
          title: 'Tour not found',
          lines: [
            'This link does not match any property. It may have been unpublished, or the address mistyped.',
          ],
          actions: [{ label: 'See the demo tour instead', primary: true, href: 'tour.html?demo=1' }],
        });
      }
      if (!tour.is_published) {
        return showMessage({
          title: 'This tour is not published yet',
          lines: ['The owner has not finished it. Ask them to press Publish in the studio.'],
          actions: [{ label: 'See the demo tour', href: 'tour.html?demo=1' }],
        });
      }
      resolveStorageUrls(db, tour);
    } else {
      return showMessage({
        title: '360° Home Tour',
        lines: ['Open a tour with a share link, or take a look at the demo.'],
        actions: [
          { label: 'Open the demo tour', primary: true, href: 'tour.html?demo=1' },
          { label: 'Home', href: 'index.html' },
        ],
      });
    }

    document.title = `${tour.name} — 360° tour`;
    els.h1.textContent = tour.name;
    buildRoomSlugs();

    const rooms = viewable();
    if (!rooms.length) {
      return showMessage({
        title: 'No rooms ready yet',
        lines: [
          'This property has no finished panoramas yet. If photos were only just uploaded, give it a moment.',
        ],
        actions: [{ label: 'Try again', primary: true, onClick: () => location.reload() }],
      });
    }

    wireControls();

    // Decide the layout BEFORE the first panorama mounts. The stage's shape is
    // what the zoom limits are computed from, so it has to be settled first or
    // the opening view is fitted to a box that is about to change size.
    renderChips();
    renderDock();
    layout();
    els.actions.classList.remove('hidden');

    const start = roomFromLocation() || rooms[0];
    if (params.get('scale') !== null) setScale(true, { silent: true });
    await enterRoom(start.id, { history: 'replace' });
  } catch (err) {
    console.error(err);
    showMessage({
      title: 'Something went wrong',
      lines: ['The tour could not be opened in this browser.'],
      actions: [{ label: 'Try again', primary: true, onClick: () => location.reload() }],
    });
  }
})();
