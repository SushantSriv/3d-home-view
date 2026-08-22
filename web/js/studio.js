/**
 * Studio: build a tour.
 *
 * Create a property, upload a floor plan, click to drop a pin per room, upload one
 * video per room, then publish and copy the share link. Stitching happens elsewhere
 * (worker/worker.py) - this page only enqueues jobs and shows their status.
 *
 * There is deliberately no login. See risk R1 in PROGRESS.md.
 */

import { isConfigured, LIMITS, BUCKETS } from './config.js';
import { renderFloorPlan } from './floorplan.js';

const $ = (id) => document.getElementById(id);
const els = {
  setup: $('setup'), flash: $('flash'), app: $('app'), editor: $('editor'),
  select: $('prop-select'), newBtn: $('prop-new'), newForm: $('new-form'),
  newName: $('new-name'), newAddress: $('new-address'), newCancel: $('new-cancel'),
  plan: $('plan'), planFile: $('plan-file'), planHint: $('plan-hint'), addRoom: $('add-room'),
  publish: $('publish'), shareUrl: $('share-url'), shareCopy: $('share-copy'), shareOpen: $('share-open'),
  pName: $('p-name'), pAddress: $('p-address'), pSave: $('p-save'), pDelete: $('p-delete'),
  rooms: $('rooms'), refresh: $('refresh'),
};

let db;
let properties = [];
let property = null;
let rooms = [];
let videos = [];
let placing = false;
let pollTimer = null;

/* -------------------------------------------------------------------- boot */

(async function boot() {
  if (!isConfigured()) {
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
    return banner(els.setup, `<p><strong>Cannot reach the database.</strong></p>
      <p class="muted">${esc(db ? db.humanError(err) : err.message)}</p>`, 'err');
  }

  els.app.classList.remove('hidden');
  wireStaticHandlers();
  renderPropertySelect();

  const wanted = new URLSearchParams(location.search).get('p');
  if (wanted && properties.some((p) => p.id === wanted)) await selectProperty(wanted);
  else if (properties.length) await selectProperty(properties[0].id);
  else els.newForm.classList.remove('hidden');
})();

/* ---------------------------------------------------------------- handlers */

function wireStaticHandlers() {
  els.select.onchange = () => selectProperty(els.select.value);

  els.newBtn.onclick = () => els.newForm.classList.toggle('hidden');
  els.newCancel.onclick = () => els.newForm.classList.add('hidden');

  els.newForm.onsubmit = guard(async (ev) => {
    ev.preventDefault();
    const created = await db.createProperty({
      name: els.newName.value.trim(),
      address: els.newAddress.value.trim(),
    });
    properties.unshift(created);
    els.newName.value = els.newAddress.value = '';
    els.newForm.classList.add('hidden');
    renderPropertySelect();
    await selectProperty(created.id);
    flash(`Created "${created.name}".`, 'ok');
  });

  els.planFile.onchange = guard(async () => {
    const file = els.planFile.files[0];
    if (!file) return;
    if (file.size > LIMITS.maxImageBytes) throw new Error('That image is very large. Export the plan under 15 MB.');
    flash('Uploading floor plan...');
    const path = await db.uploadFloorPlan(property.id, file);
    property = await db.updateProperty(property.id, { floor_plan_url: path });
    els.planFile.value = '';
    renderPlan();
    flash('Floor plan updated.', 'ok');
  });

  els.addRoom.onclick = () => {
    if (!property.floor_plan_url) return flash('Upload a floor plan first.', 'err');
    placing = !placing;
    els.addRoom.textContent = placing ? 'Cancel' : 'Add room';
    els.planHint.innerHTML = placing
      ? '<strong>Click the plan</strong> where the room is.'
      : 'Upload a floor plan, then press <em>Add room</em> and click where the room is. Drag a pin to move it.';
    renderPlan();
  };

  els.publish.onchange = guard(async () => {
    property = await db.updateProperty(property.id, { is_published: els.publish.checked });
    renderShare();
    flash(property.is_published ? 'Published. The link is live.' : 'Unpublished.', 'ok');
  });

  els.shareCopy.onclick = async () => {
    await navigator.clipboard.writeText(db.shareUrl(property.share_slug));
    els.shareCopy.textContent = 'Copied';
    setTimeout(() => (els.shareCopy.textContent = 'Copy link'), 1600);
  };

  els.pSave.onclick = guard(async () => {
    property = await db.updateProperty(property.id, {
      name: els.pName.value.trim(),
      address: els.pAddress.value.trim() || null,
    });
    const i = properties.findIndex((p) => p.id === property.id);
    properties[i] = property;
    renderPropertySelect();
    flash('Saved.', 'ok');
  });

  els.pDelete.onclick = guard(async () => {
    if (!confirm(`Delete "${property.name}" and all of its rooms? This cannot be undone.`)) return;
    await db.deleteProperty(property.id);
    properties = properties.filter((p) => p.id !== property.id);
    property = null;
    renderPropertySelect();
    els.editor.classList.add('hidden');
    if (properties.length) await selectProperty(properties[0].id);
    flash('Property deleted.', 'ok');
  });

  els.refresh.onclick = guard(() => reload());
}

/* ------------------------------------------------------------------ state */

async function selectProperty(id) {
  property = properties.find((p) => p.id === id);
  els.select.value = id;
  history.replaceState(null, '', `?p=${id}`);
  els.editor.classList.remove('hidden');
  await reload();
}

async function reload() {
  [rooms, videos] = await Promise.all([db.listRooms(property.id), db.listRoomVideos(property.id)]);
  els.pName.value = property.name || '';
  els.pAddress.value = property.address || '';
  els.publish.checked = !!property.is_published;
  renderPlan();
  renderShare();
  renderRooms();
  schedulePoll();
}

/** Poll only while something is actually in flight - otherwise sit idle. */
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = videos.some((v) => v.processing_status === 'queued' || v.processing_status === 'processing');
  if (busy) pollTimer = setTimeout(() => reload().catch(console.error), 10000);
}

/* ---------------------------------------------------------------- render */

function renderPropertySelect() {
  els.select.innerHTML = properties
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
    .join('') || '<option disabled>No properties yet</option>';
  if (property) els.select.value = property.id;
}

function renderPlan() {
  renderFloorPlan(els.plan, {
    imageUrl: db.publicUrl(BUCKETS.floorPlans, property.floor_plan_url),
    emptyText: 'No floor plan yet. Upload one below - a screenshot of the listing plan is fine.',
    rooms,
    placing,
    onPlace: guard(async (x, y) => {
      const label = prompt('Room name (e.g. Kitchen)');
      if (!label) return;
      const sizeRaw = prompt(`Size of "${label}" in m2 (optional)`);
      const size = sizeRaw && !Number.isNaN(parseFloat(sizeRaw)) ? parseFloat(sizeRaw) : null;
      const room = await db.createRoom(property.id, {
        label: label.trim(), pin_x: x, pin_y: y, dimensions_m2: size, sort_order: rooms.length,
      });
      rooms.push(room);
      placing = false;
      els.addRoom.textContent = 'Add room';
      renderPlan();
      renderRooms();
      flash(`Added "${room.label}".`, 'ok');
    }),
    onPinMove: guard(async (room, x, y) => {
      const updated = await db.updateRoom(room.id, { pin_x: x, pin_y: y });
      Object.assign(rooms.find((r) => r.id === room.id), updated);
    }),
  });
}

function renderShare() {
  const url = db.shareUrl(property.share_slug);
  els.shareUrl.textContent = url;
  els.shareOpen.href = url;
  els.shareUrl.style.opacity = property.is_published ? '1' : '.5';
}

function renderRooms() {
  if (!rooms.length) {
    els.rooms.innerHTML = `<p class="muted">No rooms yet. Press <em>Add room</em> and click the floor plan.</p>`;
    return;
  }

  els.rooms.replaceChildren(...rooms.map((room, i) => roomCard(room, i)));
}

function roomCard(room, i) {
  const job = videos.find((v) => v.room_id === room.id); // newest first from the query
  const node = document.createElement('div');
  node.className = 'room-item';
  node.innerHTML = `
    <header>
      <span class="idx">${i + 1}</span>
      <strong>${esc(room.label)}</strong>
      ${job ? `<span class="pill ${job.processing_status}">${job.processing_status}</span>` : ''}
      <button class="btn sm danger del" title="Delete room">&times;</button>
    </header>

    <div class="row">
      <div class="field"><label>Name</label><input class="f-label" type="text" value="${esc(room.label)}"></div>
      <div class="field"><label>Size (m&sup2;)</label>
        <input class="f-size" type="number" step="0.1" min="0" value="${room.dimensions_m2 ?? ''}"></div>
      <div class="field"><label title="Rotates the doorway arrows if the panorama's north is off">Heading offset (&deg;)</label>
        <input class="f-heading" type="number" step="5" value="${room.heading_offset ?? 0}"></div>
    </div>

    <div class="field">
      <label>Room video ${job ? '(replaces the current one)' : ''}</label>
      <input class="f-video" type="file" accept="video/*">
    </div>

    <div class="job"></div>
  `;

  const jobBox = node.querySelector('.job');
  if (job?.processing_status === 'failed') {
    jobBox.innerHTML = `<div class="banner err" style="margin:0"><p><strong>Stitching failed.</strong></p>
      <p class="muted">${esc(job.error_message || 'No reason recorded.')}</p>
      <p class="muted">Usually this means too little overlap between frames. Re-record with a slower,
      steadier pan of 20&ndash;30 seconds and upload again.</p></div>`;
  } else if (job?.processing_status === 'queued') {
    jobBox.innerHTML = `<p class="muted">Waiting for a stitching worker. Start one locally with
      <span class="mono">worker/run_local.ps1</span>, or wait for the scheduled cloud run.</p>`;
  } else if (job?.processing_status === 'processing') {
    jobBox.innerHTML = `<p class="muted">Stitching now. This takes a few minutes per room.</p>`;
  }

  if (room.panorama_url) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.src = db.publicUrl(BUCKETS.panoramas, room.panorama_url);
    img.alt = `Panorama of ${room.label}`;
    jobBox.append(img);
  }

  // --- field handlers
  const label = node.querySelector('.f-label');
  const size = node.querySelector('.f-size');
  const heading = node.querySelector('.f-heading');

  label.onchange = guard(async () => {
    Object.assign(room, await db.updateRoom(room.id, { label: label.value.trim() }));
    renderPlan(); renderRooms();
  });
  size.onchange = guard(async () => {
    const v = size.value === '' ? null : parseFloat(size.value);
    Object.assign(room, await db.updateRoom(room.id, { dimensions_m2: v }));
    renderPlan();
  });
  heading.onchange = guard(async () => {
    Object.assign(room, await db.updateRoom(room.id, { heading_offset: parseInt(heading.value, 10) || 0 }));
  });

  node.querySelector('.del').onclick = guard(async () => {
    if (!confirm(`Delete room "${room.label}"?`)) return;
    await db.deleteRoom(room.id);
    rooms = rooms.filter((r) => r.id !== room.id);
    renderPlan(); renderRooms();
  });

  node.querySelector('.f-video').onchange = guard((ev) => uploadVideo(room, ev.target));

  return node;
}

/* ------------------------------------------------------------------ upload */

async function uploadVideo(room, input) {
  const file = input.files[0];
  if (!file) return;

  if (file.size > LIMITS.maxVideoBytes) {
    input.value = '';
    throw new Error(
      `That clip is ${(file.size / 1048576).toFixed(0)} MB. Keep room videos under ` +
      `${LIMITS.maxVideoBytes / 1048576} MB - record at 1080p rather than 4K.`
    );
  }

  const duration = await videoDuration(file).catch(() => null);
  if (duration != null && duration < LIMITS.minVideoSeconds) {
    input.value = '';
    throw new Error(
      `That clip is only ${duration.toFixed(0)}s. A pan shorter than ${LIMITS.minVideoSeconds}s rarely ` +
      `has enough overlap to stitch. Re-record a slower full turn of 20-30 seconds.`
    );
  }

  flash(`Uploading "${file.name}"...`);
  const path = await db.uploadRoomVideo(property.id, room.id, file);
  await db.enqueueVideo(room.id, path, { durationSeconds: duration, sizeBytes: file.size });
  input.value = '';
  await reload();
  flash(`Queued "${room.label}" for stitching.`, 'ok');
}

/** Read a clip's duration without uploading it, so we can reject hopeless ones early. */
function videoDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(v.duration); };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
    v.src = url;
  });
}

/* ------------------------------------------------------------------- utils */

function banner(el, html, kind = '') {
  el.className = `banner ${kind}`;
  el.innerHTML = html;
  el.classList.remove('hidden');
}

let flashTimer = null;
function flash(text, kind = '') {
  banner(els.flash, `<p>${esc(text)}</p>`, kind);
  clearTimeout(flashTimer);
  if (kind === 'ok') flashTimer = setTimeout(() => els.flash.classList.add('hidden'), 3500);
}

/** Wrap an async handler so a rejected promise becomes a visible message, not a silent console error. */
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(err);
      flash(db ? db.humanError(err) : err.message, 'err');
    }
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
