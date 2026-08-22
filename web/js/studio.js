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
  sharebar: $('sharebar'), shareState: $('share-state'),
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
  if (busy) pollTimer = setTimeout(() => reload().catch(console.error), 5000);
}

/**
 * A ticking "42s" next to each in-flight job. Without it a five-second poll that
 * finds no change is indistinguishable from a page that has silently given up,
 * which is exactly how the studio felt before.
 */
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll('.ago[data-since]')) {
    const secs = Math.max(0, Math.round((now - Date.parse(el.dataset.since)) / 1000));
    el.textContent = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`;
  }
}, 1000);

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
  const live = !!property.is_published;
  els.shareUrl.textContent = url;
  els.shareOpen.href = url;
  els.shareState.textContent = live ? 'live' : 'draft';
  els.shareState.className = `pill ${live ? 'done' : 'queued'}`;
  els.sharebar.classList.toggle('draft', !live);
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
      <label>Panorama photo &mdash; best quality, ready in seconds</label>
      <div class="filepick">
        <label class="btn sm primary">
          <input class="f-photo" type="file" accept="image/*" hidden>
          ${room.panorama_url ? 'Replace panorama' : 'Choose panorama'}
        </label>
        <span class="fname muted">Your phone's Panorama mode. Nothing to stitch, no waiting.</span>
      </div>
      <p class="muted" style="margin:.35rem 0 0;font-size:.78rem">
        Stand in the middle, hold the phone <strong>upright</strong>, and sweep a full circle
        following the on-screen guide.
      </p>
    </div>

    <div class="field">
      <label>&hellip;or a room video (slower, and harder to get right)</label>
      <div class="filepick">
        <label class="btn sm">
          <input class="f-video" type="file" accept="video/*" hidden>
          ${room.panorama_url ? 'Replace video' : 'Choose video'}
        </label>
        <span class="fname muted"></span>
      </div>
      <p class="muted" style="margin:.35rem 0 0;font-size:.78rem">
        Phone <strong>upright</strong> and held <strong>close to your chest</strong> &mdash; the phone
        must spin, not orbit. Stand in the middle of the room and turn slowly on the spot,
        <strong>one</strong> full turn in 20&ndash;30 s.
      </p>
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
    jobBox.innerHTML = `<div class="progress indeterminate"><i></i></div>
      <p class="muted">Waiting for a stitching worker
        &mdash; <span class="ago" data-since="${job.created_at}"></span>.
        A worker picks this up within about 5 minutes, or immediately if you are running
        <span class="mono">worker/run_local.ps1</span>. You can close this page; it keeps going.</p>`;
  } else if (job?.processing_status === 'processing') {
    jobBox.innerHTML = `<div class="progress indeterminate"><i></i></div>
      <p class="muted">Stitching &mdash; <span class="ago" data-since="${job.claimed_at || job.created_at}"></span>
        so far. Typically about a minute.</p>`;
  }

  if (room.panorama_url) {
    const done = document.createElement('div');
    // Cache-bust: re-stitching a room overwrites the same storage key, so without
    // this the studio keeps showing the previous panorama from the browser cache.
    const src = `${db.publicUrl(BUCKETS.panoramas, room.panorama_url)}?t=${
      job?.finished_at ? Date.parse(job.finished_at) : ''
    }`;
    done.innerHTML = `
      <img class="thumb" loading="lazy" src="${src}" alt="Panorama of ${esc(room.label)}">
      <div style="margin-top:.5rem">
        <a class="btn sm primary" target="_blank" rel="noopener"
           href="tour.html?t=${encodeURIComponent(property.share_slug)}">Open the tour</a>
        <a class="btn sm" target="_blank" rel="noopener"
           href="tour.html?pano=${encodeURIComponent(src)}">Just this room</a>
      </div>`;
    jobBox.append(done);
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
  node.querySelector('.f-photo').onchange = guard((ev) => uploadPanorama(room, ev.target));

  return node;
}

/* ------------------------------------------------------------------ upload */

async function uploadVideo(room, input) {
  const file = input.files[0];
  const name = input.closest('.filepick')?.querySelector('.fname');
  if (!file) return;
  if (name) name.textContent = `${file.name} (${(file.size / 1048576).toFixed(0)} MB)`;

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

  // Show the bar in the room's own card rather than the page-level flash, so it
  // is obvious which room is uploading when several are on the go.
  const jobBox = input.closest('.room-item').querySelector('.job');
  jobBox.innerHTML = `<div class="progress"><i></i></div><p class="muted">Starting upload&hellip;</p>`;
  const bar = jobBox.querySelector('.progress > i');
  const note = jobBox.querySelector('p');
  const mb = file.size / 1048576;

  try {
    const path = await db.uploadRoomVideo(property.id, room.id, file, (frac) => {
      const pct = Math.round(frac * 100);
      bar.style.width = `${pct}%`;
      note.textContent = `Uploading ${mb.toFixed(0)} MB — ${pct}%`;
    });
    note.textContent = 'Upload complete. Queueing…';
    await db.enqueueVideo(room.id, path, { durationSeconds: duration, sizeBytes: file.size });
  } finally {
    input.value = '';
  }

  await reload();
  flash(`"${room.label}" is queued. You can keep adding rooms, or close this page.`, 'ok');
}

/**
 * A panorama photo needs no worker. The phone already did the stitching - far
 * better than we could offline, because it had the gyroscope and live feedback -
 * so all that is left is a projection conversion, which happens right here and
 * cannot fail. The room is finished by the time this returns.
 */
async function uploadPanorama(room, input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > LIMITS.maxPanoramaBytes) {
    input.value = '';
    throw new Error(
      `That image is ${(file.size / 1048576).toFixed(0)} MB. Panoramas over ` +
      `${LIMITS.maxPanoramaBytes / 1048576} MB are usually a mistake - export it smaller.`
    );
  }

  const jobBox = input.closest('.room-item').querySelector('.job');
  jobBox.innerHTML = `<div class="progress indeterminate"><i></i></div><p class="muted">Reading panorama&hellip;</p>`;
  const note = jobBox.querySelector('p');

  try {
    const { preparePanorama } = await import('./pano.js');
    const pano = await preparePanorama(file);

    if (pano.vaov < 25) {
      throw new Error(
        'That looks like an ordinary photo rather than a panorama. Use your phone camera in ' +
        'Panorama mode and sweep a full circle.'
      );
    }

    note.textContent =
      pano.source === 'photosphere'
        ? `Photo Sphere, ${Math.round(pano.haov)}° wide. Uploading…`
        : `Converted to equirectangular, ${Math.round(pano.vaov)}° tall. Uploading…`;

    jobBox.querySelector('.progress').classList.remove('indeterminate');
    const bar = jobBox.querySelector('.progress > i');

    const path = await db.uploadRoomPanorama(property.id, room.id, pano.blob, (frac) => {
      bar.style.width = `${Math.round(frac * 100)}%`;
    });

    Object.assign(room, await db.updateRoom(room.id, {
      panorama_url: path,
      haov: pano.haov,
      vaov: pano.vaov,
      v_offset: pano.vOffset,
    }));
  } finally {
    input.value = '';
  }

  await reload();
  flash(`"${room.label}" is ready. No stitching needed.`, 'ok');
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
