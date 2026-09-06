/**
 * Studio: build a tour.
 *
 * Create a property, upload a floor plan, click to drop a pin per room, give each
 * room a panorama photo, then publish and copy the share link. That photo path is
 * the whole product: the phone already stitched the picture, so all that is left
 * here is a projection conversion that cannot fail.
 *
 * The video path still exists behind a disclosure - worker/worker.py and its
 * GitHub Actions cron are live - but it is experimental and no longer leads.
 *
 * There is deliberately no login. See risk R1 in PROGRESS.md.
 *
 * Rendering rule, learned the hard way: room cards are RECONCILED, never
 * replaced. A five-second poll that calls replaceChildren() destroys whatever
 * the agent was half-way through typing in another field.
 */

import { isConfigured, LIMITS, BUCKETS } from './config.js';
import { renderFloorPlan } from './floorplan.js';
import { COMPLETE_SWEEP_DEG, FULL_CIRCLE_DEG } from './scale.js';

const $ = (id) => document.getElementById(id);
const els = {
  setup: $('setup'), boot: $('boot'), welcome: $('welcome'), welcomeStart: $('welcome-start'),
  propCard: $('prop-card'), propDetails: $('prop-details'),
  select: $('prop-select'), newBtn: $('prop-new'), newForm: $('new-form'), newSubmit: $('new-submit'),
  newName: $('new-name'), newAddress: $('new-address'), newCancel: $('new-cancel'),
  editor: $('editor'),
  plan: $('plan'), planFile: $('plan-file'), planHint: $('plan-hint'), planJob: $('plan-job'),
  planName: $('plan-name'), addRoom: $('add-room'), placeCentre: $('place-centre'),
  roomForm: $('room-form'), roomName: $('room-name'), roomSize: $('room-size'),
  roomChips: $('room-chips'), roomSave: $('room-save'), roomCancel: $('room-cancel'),
  rooms: $('rooms'), refresh: $('refresh'), pollNote: $('poll-note'), ready: $('ready'),
  publish: $('publish'),
  sharebar: $('sharebar'), shareState: $('share-state'), shareUrl: $('share-url'),
  shareCopy: $('share-copy'), shareOpen: $('share-open'),
  pName: $('p-name'), pAddress: $('p-address'), pDelete: $('p-delete'),
};

const QUICK_ROOMS = ['Living room', 'Kitchen', 'Bathroom', 'Bedroom', 'Hall', 'Storage'];

let db = null;
let properties = [];
let property = null;
let rooms = [];
let jobs = [];
let placing = false;
let pendingPin = null;
let pollTimer = null;
let pollDelay = 5000;
let reloadGen = 0;
let firstLoad = true;

/** roomId -> its card element. The card outlives every poll tick. */
const cards = new Map();
/** roomIds with an upload in flight; their job box belongs to the uploader. */
const busyRooms = new Set();

/* -------------------------------------------------------------------- boot */

(async function boot() {
  window.addEventListener('unhandledrejection', (ev) => report(ev.reason));

  if (!isConfigured()) {
    setBooting(false);
    return banner(
      els.setup,
      `<p><strong>Supabase is not configured.</strong></p>
       <p class="muted">Set <span class="mono">SUPABASE_URL</span> and <span class="mono">SUPABASE_ANON_KEY</span>
       in <span class="mono">web/js/config.js</span>, then run <span class="mono">supabase/schema.sql</span>.
       Full walkthrough in <span class="mono">supabase/README.md</span>.</p>`
    );
  }

  try {
    db = await import('./db.js');
    properties = await db.listProperties();
  } catch (err) {
    setBooting(false);
    return banner(els.setup, `<p><strong>Cannot reach the database.</strong></p>
      <p class="muted">${esc(db ? db.humanError(err) : err.message)}</p>`, 'err');
  }

  wireStaticHandlers();
  renderChips();
  renderPropertySelect();

  if (!properties.length) {
    setBooting(false);
    els.welcome.classList.remove('hidden');
    return;
  }

  els.propCard.classList.remove('hidden');
  const wanted = new URLSearchParams(location.search).get('p');
  const start = wanted && properties.some((p) => p.id === wanted) ? wanted : properties[0].id;
  try {
    await selectProperty(start);
  } catch (err) {
    setBooting(false); // never leave the skeleton shimmering over a dead load
    report(err);
  }
})();

function setBooting(on) {
  els.boot.classList.toggle('hidden', !on);
}

/* ---------------------------------------------------------------- handlers */

function wireStaticHandlers() {
  els.select.onchange = guard(() => selectProperty(els.select.value));

  els.welcomeStart.onclick = () => {
    els.welcome.classList.add('hidden');
    els.propCard.classList.remove('hidden');
    els.newForm.classList.remove('hidden');
    els.newName.focus();
  };

  els.newBtn.onclick = () => {
    const nowHidden = els.newForm.classList.toggle('hidden');
    if (!nowHidden) els.newName.focus();
  };

  els.newCancel.onclick = () => {
    els.newForm.classList.add('hidden');
    // Cancelling out of the very first property must not leave a blank page.
    if (!properties.length) {
      els.propCard.classList.add('hidden');
      els.welcome.classList.remove('hidden');
    }
  };

  els.newForm.onsubmit = guard(async (ev) => {
    ev.preventDefault();
    const name = els.newName.value.trim();
    if (!name) { els.newName.focus(); return toast('Give the property a name.', 'err'); }

    const created = await db.createProperty({ name, address: els.newAddress.value.trim() });
    properties.unshift(created);
    els.newName.value = els.newAddress.value = '';
    els.newForm.classList.add('hidden');
    els.welcome.classList.add('hidden');
    els.propCard.classList.remove('hidden');
    renderPropertySelect();
    await selectProperty(created.id);
    toast(`Created "${created.name}".`, 'ok');
  }, els.newSubmit);

  autosave(els.pName, 'name', (v) => v.trim(), true);
  autosave(els.pAddress, 'address', (v) => v.trim() || null, false);

  els.pDelete.onclick = guard(async () => {
    if (!confirm(`Delete "${property.name}" and all of its rooms? This cannot be undone.`)) return;

    // Collect the storage paths before the rows that name them are gone.
    const panoramas = rooms.map((r) => r.panorama_url).filter(Boolean);
    const plan = property.floor_plan_url;
    const gone = property.id;

    await db.deleteProperty(gone);
    for (const path of panoramas) await removeStored(BUCKETS.panoramas, path);
    await removeStored(BUCKETS.floorPlans, plan);

    properties = properties.filter((p) => p.id !== gone);
    property = null; rooms = []; jobs = [];
    cards.clear(); busyRooms.clear(); els.rooms.replaceChildren();
    clearTimeout(pollTimer);
    renderPropertySelect();
    els.editor.classList.add('hidden');
    els.propDetails.classList.add('hidden');
    toast('Property deleted.', 'ok');

    if (properties.length) await selectProperty(properties[0].id);
    else {
      els.propCard.classList.add('hidden');
      els.welcome.classList.remove('hidden');
    }
  }, els.pDelete);

  /* ---- floor plan ---- */

  els.planFile.onchange = guard(async () => {
    const file = els.planFile.files[0];
    if (!file) return;
    try {
      if (file.size > LIMITS.maxImageBytes) {
        throw new Error('That image is very large. Export the plan under 15 MB.');
      }
      els.planName.textContent = file.name;

      const bar = progressBar('Uploading the floor plan');
      els.planJob.replaceChildren(bar, el('p', 'muted', 'Uploading the floor plan…'));

      const previous = property.floor_plan_url;
      const path = await db.uploadFloorPlan(property.id, file, (frac) => setProgress(bar, frac));

      try {
        property = await db.updateProperty(property.id, { floor_plan_url: path });
      } catch (err) {
        await removeStored(BUCKETS.floorPlans, path); // never leave an orphan behind
        throw err;
      }
      syncProperty();
      if (previous && previous !== path) await removeStored(BUCKETS.floorPlans, previous);

      els.planJob.replaceChildren();
      setPlanHint();
      renderPlan();
      toast('Floor plan updated.', 'ok');
    } catch (err) {
      els.planJob.replaceChildren(
        el('p', 'muted', 'The floor plan did not upload. Choose the file again to try once more.')
      );
      throw err;
    } finally {
      // Always, or the picker wedges against the same file after a failure.
      els.planFile.value = '';
    }
  });

  els.addRoom.onclick = () => {
    if (!property?.floor_plan_url) {
      return toast('Upload a floor plan first — the button is at the bottom of this card.', 'err');
    }
    placing = !placing;
    closeRoomForm();
    setPlacingChrome();
    renderPlan();
  };

  els.placeCentre.onclick = () => {
    placing = false;
    setPlacingChrome();
    openRoomForm(0.5, 0.5);
  };

  els.roomCancel.onclick = () => {
    closeRoomForm();
    setPlanHint();
    renderPlan();
    els.addRoom.focus();
  };

  els.roomForm.onsubmit = guard(async (ev) => {
    ev.preventDefault();
    const label = els.roomName.value.trim();
    if (!label) { els.roomName.focus(); return toast('Give the room a name.', 'err'); }

    const rawSize = els.roomSize.value.trim();
    const size = parseDecimal(rawSize);
    if (rawSize && size == null) {
      els.roomSize.focus();
      return toast('Size must be a number, for example 28,5.', 'err');
    }

    const at = pendingPin || { x: 0.5, y: 0.5 };
    const room = await db.createRoom(property.id, {
      label, pin_x: at.x, pin_y: at.y, dimensions_m2: size, sort_order: nextSortOrder(),
    });
    rooms.push(room);

    closeRoomForm();
    setPlanHint();
    renderPlan();
    renderRooms();
    renderReadiness();
    toast(`Added "${room.label}".`, 'ok');

    const card = cards.get(room.id);
    if (card) {
      card.scrollIntoView({ block: 'nearest' });
      card.querySelector('.f-label')?.focus();
    }
  }, els.roomSave);

  /* ---- publish and share ---- */

  els.publish.onchange = async () => {
    const want = els.publish.checked;
    els.publish.disabled = true;
    try {
      if (want) {
        const missing = rooms.filter((r) => !r.panorama_url).map((r) => r.label || 'a room');
        if (missing.length && !confirm(
          `${listNames(missing)} ${missing.length > 1 ? 'have' : 'has'} no panorama yet, so ` +
          `${missing.length > 1 ? 'those rooms' : 'that room'} will not open for a buyer. Publish anyway?`
        )) return;
      }
      property = await db.updateProperty(property.id, { is_published: want });
      syncProperty();
      toast(property.is_published ? 'Published. The link is live.' : 'Unpublished.', 'ok');
    } catch (err) {
      report(err);
    } finally {
      // The truth is whatever the server last told us, never what the box shows.
      els.publish.disabled = false;
      renderShare();
    }
  };

  els.shareCopy.onclick = guard(async () => {
    const url = db.shareUrl(property.share_slug);
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      els.shareCopy.textContent = 'Copied';
      setTimeout(() => (els.shareCopy.textContent = 'Copy link'), 1600);
    } catch {
      // No clipboard on plain http, which is exactly how a phone previews a laptop.
      els.shareUrl.focus();
      els.shareUrl.select();
      toast('Press Ctrl+C to copy the selected link.', 'err');
    }
  }, els.shareCopy);

  els.refresh.onclick = guard(() => reload(), els.refresh);
}

/** Property name/address save on blur. One save model per screen, not two. */
function autosave(input, key, clean, required) {
  input.onchange = async () => {
    if (!property) return;
    const value = clean(input.value);
    if (required && !value) {
      input.value = property[key] ?? '';
      return toast('A property needs a name.', 'err');
    }
    if ((value ?? '') === (property[key] ?? '')) return;

    input.readOnly = true; // readOnly, not disabled: disabling would steal the focus
    try {
      property = await db.updateProperty(property.id, { [key]: value });
      syncProperty();
      renderPropertySelect();
    } catch (err) {
      report(err);
    } finally {
      input.readOnly = false;
      if (document.activeElement !== input) input.value = property[key] ?? '';
    }
  };
}

/* ------------------------------------------------------------------ state */

async function selectProperty(id) {
  const found = properties.find((p) => p.id === id);
  if (!found) return;

  property = found;
  els.select.value = id;
  history.replaceState(null, '', `?p=${encodeURIComponent(id)}`);

  // A different property owns different cards. Keeping them would paint one
  // property's rooms under another's name.
  cards.clear();
  busyRooms.clear();
  els.rooms.replaceChildren();
  rooms = [];
  jobs = [];
  placing = false;
  closeRoomForm();
  setPlacingChrome();

  els.propCard.classList.remove('hidden');
  els.propDetails.classList.remove('hidden');
  renderPropertyFields();
  renderShare();
  setPlanHint();
  renderPlan();
  renderReadiness();
  if (!firstLoad) skeletonRooms();

  try {
    await reload();
  } catch (err) {
    // A skeleton that never resolves is the same lie as a blank page.
    setBooting(false);
    els.editor.classList.remove('hidden');
    els.rooms.replaceChildren(roomsUnavailable());
    throw err;
  }
}

function roomsUnavailable() {
  const wrap = el('div', 'banner err');
  wrap.append(el('p', '', 'The rooms for this property could not be loaded.'));
  const retry = el('button', 'btn sm', 'Try again');
  retry.type = 'button';
  retry.onclick = guard(() => reload(), retry);
  wrap.append(retry);
  return wrap;
}

async function reload() {
  if (!property) return;

  // Two guards against a slow response landing under the wrong property: a
  // monotonic token for "a newer load started", and the id for "we moved on".
  const gen = ++reloadGen;
  const id = property.id;

  const [freshRooms, freshJobs] = await Promise.all([db.listRooms(id), db.listRoomVideos(id)]);
  if (gen !== reloadGen || !property || property.id !== id) return;

  mergeRooms(freshRooms);
  jobs = freshJobs;

  renderPlan();
  renderShare();
  renderRooms();
  renderReadiness();
  renderPropertyFields();

  if (firstLoad) {
    firstLoad = false;
    setBooting(false);
  }
  els.editor.classList.remove('hidden');
  notePoll(null);
  pollDelay = 5000;
  schedulePoll();
}

/**
 * Merge server rows into the room objects we already hold, keeping object
 * identity. Card handlers close over their room, so replacing the objects
 * wholesale would leave every card wired to a stale copy.
 */
function mergeRooms(fresh) {
  const byId = new Map(rooms.map((r) => [r.id, r]));
  rooms = fresh.map((row) => {
    const existing = byId.get(row.id);
    if (!existing) return row;
    for (const key of Object.keys(existing)) if (!(key in row)) delete existing[key];
    return Object.assign(existing, row);
  });
}

function syncProperty() {
  const i = properties.findIndex((p) => p.id === property.id);
  if (i >= 0) properties[i] = property;
}

function nextSortOrder() {
  const highest = rooms.reduce(
    (max, r) => (Number.isFinite(r.sort_order) ? Math.max(max, r.sort_order) : max), -1
  );
  return highest + 1;
}

/** Poll only while something is actually in flight - otherwise sit idle. */
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = jobs.some((j) => j.processing_status === 'queued' || j.processing_status === 'processing');
  if (!busy) return;

  pollTimer = setTimeout(async () => {
    try {
      await reload();
    } catch (err) {
      // One transient failure used to stop the poll forever while the ticking
      // "42s" kept implying the page was still watching.
      console.error(err);
      pollDelay = Math.min(30000, pollDelay * 2);
      notePoll(`Lost contact with the database — trying again in ${Math.round(pollDelay / 1000)}s.`);
      schedulePoll();
    }
  }, pollDelay);
}

function notePoll(text) {
  els.pollNote.textContent = text || '';
  els.pollNote.classList.toggle('hidden', !text);
}

/**
 * A ticking "42s" next to each in-flight job. Without it a five-second poll that
 * finds no change is indistinguishable from a page that has silently given up.
 */
setInterval(() => {
  const now = Date.now();
  for (const node of document.querySelectorAll('.ago[data-since]')) {
    const secs = Math.max(0, Math.round((now - Date.parse(node.dataset.since)) / 1000));
    node.textContent = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`;
  }
}, 1000);

/* ---------------------------------------------------------------- render */

function renderPropertySelect() {
  els.select.replaceChildren();
  if (!properties.length) {
    const none = el('option', '', 'No properties yet');
    none.disabled = true;
    els.select.append(none);
    return;
  }
  for (const p of properties) {
    const option = el('option', '', p.name || '(unnamed)');
    option.value = p.id;
    els.select.append(option);
  }
  if (property) els.select.value = property.id;
}

function renderPropertyFields() {
  if (!property) return;
  if (document.activeElement !== els.pName) els.pName.value = property.name || '';
  if (document.activeElement !== els.pAddress) els.pAddress.value = property.address || '';
}

function setPlacingChrome() {
  els.addRoom.textContent = placing ? 'Cancel' : 'Add room';
  els.addRoom.classList.toggle('primary', !placing);
  els.placeCentre.classList.toggle('hidden', !placing);
  setPlanHint();
}

function setPlanHint() {
  if (!property?.floor_plan_url) {
    els.planHint.innerHTML = 'Upload a floor plan below, then press <em>Add room</em> and click where the room is.';
  } else if (pendingPin) {
    els.planHint.innerHTML = 'Name the room, then press <em>Add room</em>.';
  } else if (placing) {
    els.planHint.innerHTML = '<strong>Click the plan</strong> where the room is.';
  } else {
    els.planHint.innerHTML = 'Press <em>Add room</em> and click where the room is. Drag a pin to move it.';
  }
}

function renderPlan() {
  if (!property) return;
  renderFloorPlan(els.plan, {
    imageUrl: db.publicUrl(BUCKETS.floorPlans, property.floor_plan_url),
    emptyText: 'No floor plan yet. Choose one below — a screenshot of the listing plan is fine.',
    rooms,
    placing,
    onPlace: (x, y) => {
      placing = false;
      setPlacingChrome();
      openRoomForm(x, y);
    },
    onPinMove: guard(async (room, x, y) => {
      const updated = await db.updateRoom(room.id, { pin_x: x, pin_y: y });
      const local = rooms.find((r) => r.id === room.id);
      if (local) Object.assign(local, updated);
    }),
  });
  markEmptyPins();
  drawPendingPin();
}

/**
 * A pin for a room with no photo is a dead end for the buyer, and nothing at
 * either end of the product said so. floorplan.js renders pins in room order,
 * skipping rooms without coordinates, so the two lists line up.
 */
function markEmptyPins() {
  const pinned = rooms.filter((r) => r.pin_x != null && r.pin_y != null);
  const nodes = els.plan.querySelectorAll('.pin');
  if (nodes.length !== pinned.length) return;
  nodes.forEach((node, i) => { if (!pinned[i].panorama_url) markEmpty(node); });
}

/**
 * app.css defines `.pin.empty` (a hollow pin for a room with no photo) and
 * `.floorplan .empty` (the "no floor plan yet" placeholder). A pin lives inside
 * .floorplan, so the placeholder rule matches it too and at equal specificity
 * wins on min-height and padding - which inflated the pin to a 36x170px grey
 * slab lying across the plan. Undo exactly those two declarations here; the
 * rest of the pin, including the leaked grid centring, still comes from the
 * stylesheet. Delete this once that rule is scoped to `.floorplan > .empty`.
 */
function markEmpty(pin) {
  pin.classList.add('empty');
  pin.style.minHeight = '0';
  pin.style.padding = '0';
}

function drawPendingPin() {
  if (!pendingPin) return;
  const dot = el('span', 'pin', '+');
  markEmpty(dot);
  dot.style.left = `${pendingPin.x * 100}%`;
  dot.style.top = `${pendingPin.y * 100}%`;
  dot.setAttribute('aria-hidden', 'true');
  els.plan.append(dot);
}

function renderShare() {
  if (!property) return;
  const url = db.shareUrl(property.share_slug);
  const live = !!property.is_published;
  els.shareUrl.value = url;
  els.shareOpen.href = url;
  els.shareState.textContent = live ? 'live' : 'draft';
  els.shareState.className = `pill ${live ? 'live' : 'queued'}`;
  els.publish.checked = live;
}

function renderReadiness() {
  const total = rooms.length;
  const withPhoto = rooms.filter((r) => r.panorama_url).length;
  const missing = rooms.filter((r) => !r.panorama_url).map((r) => r.label || 'a room');

  if (!total) {
    els.ready.textContent = 'No rooms yet. Press Add room and click the floor plan.';
  } else if (!missing.length) {
    els.ready.textContent = total === 1
      ? 'The room has a photo. Ready to publish.'
      : `All ${total} rooms have a photo. Ready to publish.`;
  } else {
    els.ready.textContent =
      `${withPhoto} of ${total} rooms have a photo — ` +
      `${listNames(missing)} ${missing.length > 1 ? 'are' : 'is'} missing.`;
  }
}

function skeletonRooms() {
  const wrap = el('div');
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) wrap.append(el('div', 'skel line short'), el('div', 'skel block'));
  els.rooms.replaceChildren(wrap);
}

/**
 * Reconcile, never replace. Cards are created once and afterwards only patched,
 * and a card holding the focus is left completely alone.
 */
function renderRooms() {
  if (!rooms.length) {
    cards.clear();
    els.rooms.replaceChildren(
      el('p', 'muted', 'No rooms yet. Press Add room and click the floor plan.')
    );
    return;
  }

  for (const stray of Array.from(els.rooms.children)) {
    if (!stray.classList.contains('room-item')) stray.remove();
  }
  for (const [id, node] of cards) {
    if (!rooms.some((r) => r.id === id)) { node.remove(); cards.delete(id); }
  }

  rooms.forEach((room, i) => {
    let node = cards.get(room.id);
    if (!node) {
      node = roomCard(room);
      cards.set(room.id, node);
      paint(node, room, i);
    } else if (!node.contains(document.activeElement)) {
      paint(node, room, i);
    }
    const at = els.rooms.children[i];
    if (at !== node && !node.contains(document.activeElement)) {
      els.rooms.insertBefore(node, at || null);
    }
  });
}

const ROOM_TEMPLATE = `
  <header>
    <span class="idx"></span>
    <h3></h3>
    <span class="st pill hidden"></span>
    <button class="btn sm danger del" type="button">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
           stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 7h16M9 7V5h6v2M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>
      </svg>
    </button>
  </header>

  <div class="shot"></div>

  <div class="filepick">
    <label class="btn primary">
      <input class="f-photo visually-hidden" type="file" accept="image/*,.heic,.heif" multiple>
      <span class="pick-label">Add panorama photo</span>
    </label>
    <span class="pick-extra"></span>
  </div>

  <div class="row">
    <div class="field">
      <label class="l-label">Name</label>
      <input class="f-label" type="text" autocomplete="off">
    </div>
    <div class="field">
      <label class="l-size">Size (m&sup2;)</label>
      <input class="f-size" type="text" inputmode="decimal" autocomplete="off">
    </div>
  </div>

  <details>
    <summary>Advanced</summary>
    <div class="field">
      <label class="l-heading">Doorway arrow direction (&deg;)</label>
      <input class="f-heading" type="number" step="5">
      <span class="hint">Rotates the doorway arrows if the panorama's north is off.</span>
    </div>
  </details>

  <details>
    <summary>Experimental: upload a video instead</summary>
    <p class="muted">A handheld clip has to be stitched by a worker and often fails; a panorama
      photo is instant and far more reliable. If you try one anyway: phone <strong>upright</strong>,
      held <strong>close to your chest</strong>, one slow turn on the spot in 20&ndash;30 seconds.</p>
    <div class="filepick">
      <label class="btn sm">
        <input class="f-video visually-hidden" type="file" accept="video/*">
        <span class="vid-label">Choose video</span>
      </label>
      <span class="fname muted"></span>
    </div>
  </details>

  <div class="job"></div>
`;

function roomCard(room) {
  const node = el('div', 'room-item');
  node.innerHTML = ROOM_TEMPLATE;
  node.dataset.roomId = room.id;
  node.setAttribute('role', 'group');

  const heading = node.querySelector('h3');
  heading.id = `room-${room.id}-h`;
  node.setAttribute('aria-labelledby', heading.id);

  // Six unlabelled inputs per card is what an unpaired <label> costs.
  for (const key of ['label', 'size', 'heading']) {
    const input = node.querySelector(`.f-${key}`);
    input.id = `room-${room.id}-${key}`;
    node.querySelector(`.l-${key}`).htmlFor = input.id;
  }

  const labelInput = node.querySelector('.f-label');
  const sizeInput = node.querySelector('.f-size');
  const headingInput = node.querySelector('.f-heading');
  const del = node.querySelector('.del');

  labelInput.onchange = () => saveField(node, room, labelInput, async () => {
    const next = labelInput.value.trim();
    if (!next) { labelInput.value = room.label ?? ''; toast('A room needs a name.', 'err'); return null; }
    if (next === room.label) return null;
    return { label: next };
  }, () => (room.label ?? ''));

  sizeInput.onchange = () => saveField(node, room, sizeInput, async () => {
    const raw = sizeInput.value.trim();
    const value = parseDecimal(raw);
    if (raw && (value == null || value < 0)) {
      toast('Size must be a number, for example 28,5.', 'err');
      return null;
    }
    if ((value ?? null) === (room.dimensions_m2 ?? null)) return null;
    return { dimensions_m2: value };
  }, () => (room.dimensions_m2 == null ? '' : String(room.dimensions_m2)));

  headingInput.onchange = () => saveField(node, room, headingInput, async () => {
    const value = parseInt(headingInput.value, 10) || 0;
    if (value === (room.heading_offset ?? 0)) return null;
    return { heading_offset: value };
  }, () => String(room.heading_offset ?? 0));

  del.onclick = guard(async () => {
    if (!confirm(`Delete room "${room.label}"? Its photo is deleted from storage too.`)) return;
    // The photo goes first: someone deleting a room because the picture caught
    // something private is not helped by a row disappearing while the public
    // CDN keeps serving the file.
    if (room.panorama_url) await db.deletePanorama(room.panorama_url);
    await db.deleteRoom(room.id);
    rooms = rooms.filter((r) => r.id !== room.id);
    node.remove();
    cards.delete(room.id);
    renderPlan();
    renderRooms();
    renderReadiness();
    toast(`Deleted "${room.label}".`, 'ok');
  }, del);

  node.querySelector('.f-photo').onchange = guard((ev) => uploadPanorama(room, ev.target));
  node.querySelector('.f-video').onchange = guard((ev) => uploadVideo(room, ev.target));

  return node;
}

/**
 * One write, with the field locked while it is in flight and restored from the
 * server afterwards. A field that silently keeps a value the database rejected
 * is the same lie as a ticked Publish box over a draft pill.
 */
async function saveField(node, room, input, build, current) {
  const patch = await build();
  if (!patch) { input.value = current(); return; }

  input.readOnly = true;
  try {
    Object.assign(room, await db.updateRoom(room.id, patch));
  } catch (err) {
    report(err);
  } finally {
    input.readOnly = false;
    input.value = current();
    paint(node, room, rooms.indexOf(room));
    renderPlan();
    renderReadiness();
  }
}

/* ------------------------------------------------------------- card paint */

function paint(node, room, index) {
  node.querySelector('.idx').textContent = String(index + 1);
  node.querySelector('h3').textContent = room.label || `Room ${index + 1}`;
  node.querySelector('.del').setAttribute('aria-label', `Delete the room ${room.label || index + 1}`);
  node.querySelector('.pick-label').textContent =
    room.panorama_url ? 'Replace panorama' : 'Add panorama photo';
  node.querySelector('.vid-label').textContent = 'Choose video';

  const labelInput = node.querySelector('.f-label');
  const sizeInput = node.querySelector('.f-size');
  const headingInput = node.querySelector('.f-heading');
  if (document.activeElement !== labelInput) labelInput.value = room.label ?? '';
  if (document.activeElement !== sizeInput) {
    sizeInput.value = room.dimensions_m2 == null ? '' : String(room.dimensions_m2);
  }
  if (document.activeElement !== headingInput) headingInput.value = String(room.heading_offset ?? 0);

  paintPill(node, room);
  paintShot(node, room);
  paintPreviewLink(node, room);
  paintJob(node, room);
}

function paintPill(node, room) {
  const pill = node.querySelector('.st');
  const status = jobs.find((j) => j.room_id === room.id)?.processing_status;

  if (status === 'queued' || status === 'processing' || status === 'failed') {
    pill.className = `st pill ${status}`;
    pill.textContent = status;
  } else if (!room.panorama_url) {
    pill.className = 'st pill missing';
    pill.textContent = 'no photo';
  } else {
    pill.className = 'st pill hidden';
    pill.textContent = '';
  }
}

function paintShot(node, room) {
  const shot = node.querySelector('.shot');
  const key = `${room.panorama_url || ''}|${room.haov ?? ''}|${room.label || ''}`;
  if (shot.dataset.key === key) return;
  shot.dataset.key = key;
  shot.replaceChildren();

  if (!room.panorama_url) {
    shot.append(el('div', 'thumb empty', 'No photo yet'));
    return;
  }

  // Panorama paths are timestamped, so a replacement is a different URL and can
  // never be served from the old cache entry. No cache-busting needed.
  const src = db.publicUrl(BUCKETS.panoramas, room.panorama_url);
  const img = el('img', 'thumb');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = `Panorama of ${room.label || 'this room'}`;
  img.src = src;
  shot.append(img);

  if (room.haov != null && room.haov < COMPLETE_SWEEP_DEG) {
    shot.append(el('p', 'muted', `Covers ${Math.round(room.haov)}° of ${FULL_CIRCLE_DEG}° — part of the room is missing.`));
  }

}

/** The one-room preview sits beside the picker, not on a line of its own. */
function paintPreviewLink(node, room) {
  const slot = node.querySelector('.pick-extra');
  const path = room.panorama_url || '';
  if (slot.dataset.key === path) return;
  slot.dataset.key = path;
  slot.replaceChildren();
  if (!path) return;

  const preview = el('a', 'btn sm ghost', 'Preview this room');
  preview.target = '_blank';
  preview.rel = 'noopener';
  preview.href = `tour.html?pano=${encodeURIComponent(db.publicUrl(BUCKETS.panoramas, path))}`;
  slot.append(preview);
}

function paintJob(node, room) {
  // An upload owns this box while it runs, and an inline failure owns it until
  // the agent acts on it.
  if (busyRooms.has(room.id) || node.dataset.jobLocked === '1') return;

  const box = node.querySelector('.job');
  const job = jobs.find((j) => j.room_id === room.id);
  const key = job ? `${job.id}|${job.processing_status}|${job.claimed_at || ''}` : '';
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren();
  if (!job) return;

  if (job.processing_status === 'failed') {
    const wrap = el('div', 'banner err');
    wrap.append(
      el('p', '', 'Stitching failed.'),
      el('p', 'muted', 'Usually this means too little overlap between frames. A panorama photo ' +
        'needs no stitching at all and is the better fix.')
    );
    // The worker writes a raw Python traceback here. Printed straight into the
    // card it is both meaningless to an agent and an unbreakable 600-character
    // string that pushes the whole page sideways, so it goes behind a
    // disclosure and into .mono, which breaks anywhere.
    const raw = (job.error_message || '').trim();
    if (raw) {
      const detail = document.createElement('details');
      detail.append(el('summary', '', 'Technical details'), el('p', 'mono', raw.slice(-1200)));
      wrap.append(detail);
    }
    box.append(wrap);
  } else if (job.processing_status === 'queued') {
    box.append(progressBar('Waiting for a stitching worker', true));
    const p = el('p', 'muted', 'Waiting for a stitching worker — ');
    p.append(ago(job.created_at), document.createTextNode(
      '. A worker picks this up within about 5 minutes. You can close this page; it keeps going.'
    ));
    box.append(p);
  } else if (job.processing_status === 'processing') {
    box.append(progressBar('Stitching', true));
    const p = el('p', 'muted', 'Stitching — ');
    p.append(ago(job.claimed_at || job.created_at), document.createTextNode(' so far. Typically about a minute.'));
    box.append(p);
  }
}

function ago(since) {
  const span = el('span', 'ago');
  span.dataset.since = since;
  return span;
}

/** Hand the job box to an uploader, and stop the poll from painting over it. */
function takeJobBox(node) {
  const box = node.querySelector('.job');
  box.dataset.key = 'manual';
  box.replaceChildren();
  delete node.dataset.jobLocked;
  return box;
}

/** Leave a failure where it happened, with the way out attached to it. */
function lockJobFailure(node, box, message, retry) {
  node.dataset.jobLocked = '1';
  box.replaceChildren();
  const wrap = el('div', 'banner err');
  wrap.append(el('p', '', message));
  const again = el('button', 'btn sm', 'Try again');
  again.type = 'button';
  again.onclick = () => { delete node.dataset.jobLocked; box.replaceChildren(); retry(); };
  wrap.append(again);
  box.append(wrap);
}

/* ------------------------------------------------------------------ upload */

/**
 * A panorama photo needs no worker. The phone already did the stitching - far
 * better than we could offline, because it had the gyroscope and live feedback -
 * so all that is left is a projection conversion, which happens right here and
 * cannot fail. The room is finished by the time this returns.
 */
async function uploadPanorama(room, input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;

  const node = input.closest('.room-item');
  const oversized = files.find((f) => f.size > LIMITS.maxPanoramaBytes);
  if (oversized) {
    input.value = '';
    throw new Error(
      `"${oversized.name}" is ${(oversized.size / 1048576).toFixed(0)} MB. Panoramas over ` +
      `${LIMITS.maxPanoramaBytes / 1048576} MB are usually a mistake - export it smaller.`
    );
  }

  const box = takeJobBox(node);
  const bar = progressBar('Preparing the panorama', true);
  const note = el('p', 'muted', 'Reading panorama…');
  box.append(bar, note);

  busyRooms.add(room.id);
  let placements = null;

  try {
    const { preparePanorama } = await import('./pano.js');
    const pano = await preparePanorama(files, { onStage: (text) => (note.textContent = text) });
    placements = pano.placements;

    if (pano.vaov < 25) {
      throw new Error(
        'That looks like an ordinary photo rather than a panorama. Use your phone camera in ' +
        'Panorama mode and sweep a full circle.'
      );
    }

    const kind = { photosphere: 'Photo Sphere', merged: `${pano.parts} sweeps joined`, cylindrical: 'Converted' };
    note.textContent =
      `${kind[pano.source] || 'Converted'} — ${Math.round(pano.haov)}° around, ` +
      `${Math.round(pano.vaov)}° tall. Uploading…`;

    bar.classList.remove('indeterminate');
    bar.removeAttribute('aria-busy');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-label', 'Uploading the panorama');
    setProgress(bar, 0);

    await storePanorama(room, pano, bar);
  } catch (err) {
    lockJobFailure(node, box, 'That panorama could not be added.', () => input.click());
    throw err;
  } finally {
    busyRooms.delete(room.id);
    input.value = '';
  }

  await reload();
  repaint(room.id);

  // A join is found by correlating the overlap, and correlation cannot tell a
  // true match from a merely plausible one. Two sweeps with a real gap between
  // them still produce a confident-looking answer - measured at 0.67 against
  // 1.03 for a genuine 45-degree overlap - so say when the evidence was thin
  // rather than quietly deciding on the seller's behalf.
  const weak = (placements || []).filter((pl) => pl.score != null && pl.score < 0.8);
  if (weak.length) {
    return toast(
      'The sweeps were joined, but the matching overlap was weak. Check the room looks right; ' +
      'if walls are cut off or repeated, re-shoot with the second sweep starting further back ' +
      'into the first - about a third of a sweep of overlap is plenty.',
      'err'
    );
  }

  if (room.haov < COMPLETE_SWEEP_DEG) {
    toast(
      `"${room.label}" is ready, but the sweep only covers ${Math.round(room.haov)}° of the ` +
      'room, so part of it is missing. The viewer will stop at the edges rather than show a gap. ' +
      'See "Getting the whole room" for how to capture the full circle.',
      'err'
    );
  } else {
    toast(`"${room.label}" is ready — full ${Math.round(room.haov)}°. No stitching needed.`, 'ok');
  }
}

/** Upload a prepared panorama and point the room at it. */
async function storePanorama(room, pano, bar) {
  const path = await db.uploadRoomPanorama(property.id, room.id, pano.blob, (frac) => setProgress(bar, frac));

  const previous = room.panorama_url;
  try {
    Object.assign(room, await db.updateRoom(room.id, {
      panorama_url: path,
      haov: pano.haov,
      vaov: pano.vaov,
      v_offset: pano.vOffset,
    }));
  } catch (err) {
    await db.deletePanorama(path); // the row never pointed at it, so nothing can miss it
    throw err;
  }
  // Only once the row points at the new file, so a failure never orphans the room.
  if (previous && previous !== path) await db.deletePanorama(previous);
}

async function uploadVideo(room, input) {
  const file = input.files[0];
  if (!file) return;

  const node = input.closest('.room-item');
  const name = input.closest('.filepick')?.querySelector('.fname');
  if (name) name.textContent = `${file.name} (${(file.size / 1048576).toFixed(0)} MB)`;

  if (file.size > LIMITS.maxVideoBytes) {
    input.value = '';
    throw new Error(
      `That clip is ${(file.size / 1048576).toFixed(0)} MB. Keep room videos under ` +
      `${LIMITS.maxVideoBytes / 1048576} MB - record at 1080p rather than 4K.`
    );
  }

  const duration = await videoDuration(file);
  if (duration != null && duration < LIMITS.minVideoSeconds) {
    input.value = '';
    throw new Error(
      `That clip is only ${duration.toFixed(0)}s. A pan shorter than ${LIMITS.minVideoSeconds}s rarely ` +
      'has enough overlap to stitch. Re-record a slower full turn of 20-30 seconds.'
    );
  }

  // The bar goes in the room's own card rather than a page-level message, so it
  // is obvious which room is uploading when several are on the go.
  const box = takeJobBox(node);
  const bar = progressBar('Uploading the video');
  const note = el('p', 'muted', 'Starting upload…');
  box.append(bar, note);
  const mb = file.size / 1048576;

  busyRooms.add(room.id);
  try {
    const path = await db.uploadRoomVideo(property.id, room.id, file, (frac) => {
      setProgress(bar, frac);
      note.textContent = `Uploading ${mb.toFixed(0)} MB — ${Math.round(frac * 100)}%`;
    });
    note.textContent = 'Upload complete. Queueing…';
    await db.enqueueVideo(room.id, path, { durationSeconds: duration, sizeBytes: file.size });
  } catch (err) {
    lockJobFailure(node, box, 'That video did not upload.', () => input.click());
    throw err;
  } finally {
    busyRooms.delete(room.id);
    input.value = '';
  }

  await reload();
  repaint(room.id);
  toast(`"${room.label}" is queued. You can keep adding rooms, or close this page.`, 'ok');
}

/**
 * Read a clip's duration without uploading it, so we can reject hopeless ones
 * early. Races a timeout: a codec the browser cannot decode otherwise leaves
 * the whole upload hanging on a metadata event that will never fire.
 */
function videoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 10000);
    video.preload = 'metadata';
    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => finish(null);
    video.src = url;
  });
}

/** Force a card up to date even if its file input still holds the focus. */
function repaint(roomId) {
  const node = cards.get(roomId);
  const room = rooms.find((r) => r.id === roomId);
  if (node && room) paint(node, room, rooms.indexOf(room));
}

async function removeStored(bucket, path) {
  if (!path || /^https?:/.test(path)) return;
  try {
    const { error } = await db.sb.storage.from(bucket).remove([path]);
    if (error) console.warn('Could not remove', path, error.message);
  } catch (err) {
    console.warn('Could not remove', path, err);
  }
}

/* ---------------------------------------------------------- room creation */

function renderChips() {
  els.roomChips.replaceChildren(...QUICK_ROOMS.map((name) => {
    const chip = el('button', 'roomchip', name);
    chip.type = 'button';
    chip.onclick = () => { els.roomName.value = name; els.roomName.focus(); };
    return chip;
  }));
}

function openRoomForm(x, y) {
  pendingPin = { x, y };
  els.roomName.value = '';
  els.roomSize.value = '';
  els.roomForm.classList.remove('hidden');
  setPlanHint();
  renderPlan();
  els.roomName.focus();
}

function closeRoomForm() {
  pendingPin = null;
  els.roomForm.classList.add('hidden');
}

/* ------------------------------------------------------------------- utils */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function progressBar(label, indeterminate = false) {
  const bar = el('div', indeterminate ? 'progress indeterminate' : 'progress');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', label);
  if (indeterminate) {
    bar.setAttribute('aria-busy', 'true');
  } else {
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', '0');
  }
  bar.append(document.createElement('i'));
  return bar;
}

function setProgress(bar, frac) {
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  bar.querySelector('i').style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(pct));
}

/** A Norwegian agent types 28,5. parseFloat used to store 28 and say nothing. */
function parseDecimal(raw) {
  const text = String(raw ?? '').trim().replace(',', '.');
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function listNames(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function banner(node, html, kind = '') {
  node.className = `banner ${kind}`;
  node.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  node.innerHTML = html;
  node.classList.remove('hidden');
}

let toastNode = null;
let toastTimer = null;

/**
 * Errors used to render in a banner at the top of the document - up to 3200px
 * above the control that caused them. A toast follows the eye instead.
 */
function toast(text, kind = '') {
  clearTimeout(toastTimer);
  toastNode?.remove();

  const node = el('div', kind ? `toast ${kind}` : 'toast');
  node.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  node.append(el('span', 'grow', text));

  const close = el('button', 'btn sm ghost x');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss this message');
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const dismiss = () => { node.remove(); if (toastNode === node) toastNode = null; };
  close.onclick = dismiss;
  node.append(close);

  document.body.append(node);
  toastNode = node;
  toastTimer = setTimeout(dismiss, kind === 'err' ? 8000 : 3500);
}

function report(err) {
  console.error(err);
  toast(db ? db.humanError(err) : (err?.message || String(err)), 'err');
}

/**
 * Wrap an async handler so a rejected promise becomes a visible message rather
 * than a silent console error, and so the control that started it cannot be
 * pressed twice while the first write is still in flight.
 */
function guard(fn, busyEl) {
  return async (...args) => {
    if (busyEl) { busyEl.disabled = true; busyEl.setAttribute('aria-busy', 'true'); }
    try {
      await fn(...args);
    } catch (err) {
      report(err);
    } finally {
      if (busyEl) { busyEl.disabled = false; busyEl.removeAttribute('aria-busy'); }
    }
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
