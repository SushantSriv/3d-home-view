/**
 * Public tour viewer.
 *
 *   tour.html?t=<slug>   a real tour from Supabase
 *   tour.html?demo=1     the browser-generated demo tour (no backend at all)
 *   tour.html?pano=<url> a single panorama, for eyeballing stitcher output
 *
 * No login, ever. This is the URL that goes in a finn.no listing.
 */

import { renderFloorPlan, bearingBetween } from './floorplan.js';
import { BUCKETS } from './config.js';

const params = new URLSearchParams(location.search);
const els = {
  pano: document.getElementById('pano'),
  tag: document.getElementById('tag'),
  dock: document.getElementById('dock'),
  plan: document.getElementById('plan'),
  msg: document.getElementById('msg'),
  msgInner: document.getElementById('msg-inner'),
  actions: document.getElementById('actions'),
  copy: document.getElementById('copy'),
  next: document.getElementById('next'),
};

let tour = null;
let viewer = null;
let currentId = null;
let demo = null; // demo module, imported only when needed

/** Rooms that can actually be entered. A room with no panorama yet is still on the plan. */
const viewable = () => (tour?.rooms || []).filter((r) => r.panorama_url || tour.is_demo);

/**
 * The database stores STORAGE PATHS, not URLs, so that the project can be renamed
 * without rewriting every row. Turn them into CDN URLs once, here, rather than at
 * each use site - forgetting one is how the viewer ended up asking GitHub Pages
 * for a panorama that lives in Supabase.
 *
 * publicUrl() passes absolute URLs through untouched and returns null for empty
 * input, so this is safe to run over data the demo tour never touches.
 */
function resolveStorageUrls(db, t) {
  t.floor_plan_url = db.publicUrl(BUCKETS.floorPlans, t.floor_plan_url);
  for (const room of t.rooms || []) {
    room.panorama_url = db.publicUrl(BUCKETS.panoramas, room.panorama_url);
  }
}

function showMessage(title, bodyHtml) {
  els.msgInner.innerHTML = `<h1>${title}</h1>${bodyHtml}`;
  els.msg.classList.remove('hidden');
}

const hideMessage = () => els.msg.classList.add('hidden');

/* ------------------------------------------------------------------ boot */

(async function boot() {
  try {
    if (params.get('demo') !== null) {
      demo = await import('./demo.js');
      tour = demo.getDemoTour();
    } else if (params.get('pano')) {
      return showSinglePanorama(params.get('pano'));
    } else if (params.get('t')) {
      const db = await import('./db.js');
      try {
        tour = await db.getTourBySlug(params.get('t'));
      } catch (err) {
        return showMessage('Could not load this tour', `<p class="muted">${db.humanError(err)}</p>`);
      }
      if (!tour) {
        return showMessage(
          'Tour not found',
          `<p class="muted">This link does not match any property. It may have been unpublished or the address mistyped.</p>
           <p><a class="btn" href="tour.html?demo=1">See the demo tour instead</a></p>`
        );
      }
      if (!tour.is_published) {
        return showMessage(
          'This tour is not published yet',
          `<p class="muted">The owner has not finished it. Ask them to press <em>Publish</em> in the studio.</p>`
        );
      }
      resolveStorageUrls(db, tour);
    } else {
      return showMessage(
        '360&deg; Home Tour',
        `<p class="muted">Open a tour with a share link, or take a look at the demo.</p>
         <p><a class="btn primary" href="tour.html?demo=1">Open the demo tour</a>
            <a class="btn" href="index.html">Home</a></p>`
      );
    }

    document.title = `${tour.name} - 360 Tour`;

    const rooms = viewable();
    if (!rooms.length) {
      return showMessage(
        'No rooms ready yet',
        `<p class="muted">This property has no finished panoramas. If videos were just uploaded, stitching may still be running.</p>`
      );
    }

    els.actions.classList.remove('hidden');
    els.copy.onclick = copyLink;
    els.next.onclick = () => {
      const list = viewable();
      const i = list.findIndex((r) => r.id === currentId);
      enterRoom(list[(i + 1) % list.length].id);
    };

    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowRight' || ev.key === 'n') els.next.click();
    });

    await enterRoom(rooms[0].id);
  } catch (err) {
    console.error(err);
    showMessage('Something went wrong', `<p class="muted">${err.message}</p>`);
  }
})();

/* ------------------------------------------------------------- navigation */

/**
 * Doorway hotspots point at the two nearest other rooms on the floor plan. More
 * than that turns a small room into a wall of arrows.
 */
function neighboursOf(room) {
  return viewable()
    .filter((r) => r.id !== room.id && r.pin_x != null && r.pin_y != null)
    .map((r) => ({ room: r, dist: Math.hypot(r.pin_x - room.pin_x, r.pin_y - room.pin_y) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 2)
    .map((n) => n.room);
}

async function enterRoom(roomId) {
  const room = tour.rooms.find((r) => r.id === roomId);
  if (!room) return;
  currentId = roomId;
  hideMessage();

  const neighbours = room.pin_x == null ? [] : neighboursOf(room);
  const bearings = neighbours.map((n) => ({
    room: n,
    yaw: bearingBetween(room, n, room.heading_offset || 0),
  }));

  let panoramaUrl = room.panorama_url;
  if (tour.is_demo) {
    els.tag.innerHTML = `<div class="rm">${escapeHtml(room.label)}</div><div class="sz">painting panorama...</div>`;
    await nextFrame(); // let the tag render before the synchronous paint blocks
    panoramaUrl = demo.getDemoPanorama(room.id, bearings[0]?.yaw);
  }

  renderTag(room);
  renderDock();

  mountViewer(panoramaUrl, {
    // A panorama photo covers a band, not a sphere. Telling Pannellum the real
    // angles makes it show clean empty space above and below instead of stretching
    // an 86-degree-tall image over a full 180.
    haov: room.haov ?? 360,
    vaov: room.vaov ?? 180,
    vOffset: room.v_offset ?? 0,
    hotSpots: bearings.map(({ room: target, yaw }) => ({
      pitch: -3,
      yaw,
      cssClass: 'hs-door',
      createTooltipFunc: (div) => {
        div.title = target.dimensions_m2
          ? `Go to ${target.label} (${target.dimensions_m2} m2)`
          : `Go to ${target.label}`;
      },
      clickHandlerFunc: () => enterRoom(target.id),
    })),
  });
}

function renderTag(room) {
  const list = viewable();
  const parts = [];
  if (room.dimensions_m2) parts.push(`${room.dimensions_m2} m&sup2;`);
  parts.push(`room ${list.findIndex((r) => r.id === room.id) + 1} of ${list.length}`);
  els.tag.innerHTML =
    `<div class="rm">${escapeHtml(room.label)}</div>` +
    `<div class="sz">${parts.join(' &middot; ')}</div>`;
  els.tag.classList.remove('hidden');
}

function renderDock() {
  if (!tour.floor_plan_url) return els.dock.classList.add('hidden');
  els.dock.classList.remove('hidden');
  els.dock.querySelector('.label').textContent = tour.name;
  renderFloorPlan(els.plan, {
    imageUrl: tour.floor_plan_url,
    rooms: tour.rooms,
    activeId: currentId,
    onPinClick: (room) => {
      if (!room.panorama_url && !tour.is_demo) {
        alert(`"${room.label}" has no panorama yet - its video is still being processed.`);
        return;
      }
      enterRoom(room.id);
    },
  });
}

/* ---------------------------------------------------------------- viewer */

function mountViewer(panoramaUrl, extra = {}) {
  viewer?.destroy();
  const config = {
    type: 'equirectangular',
    panorama: panoramaUrl,
    autoLoad: true,
    showZoomCtrl: true,
    showFullscreenCtrl: true,
    keyboardZoom: true,
    hfov: 100,
    minHfov: 50,
    maxHfov: 120,
    friction: 0.15,
    backgroundColor: [0.07, 0.07, 0.09],
    ...extra,
  };
  // Pannellum only accepts these together and rejects a full sphere declared
  // partially, so drop them when the image really is 360x180.
  if (config.haov >= 359.9 && config.vaov >= 179.9) {
    delete config.haov;
    delete config.vaov;
    delete config.vOffset;
  }
  // Only meaningful for remote images; setting it on a data: URL is pointless noise.
  if (/^https?:/i.test(panoramaUrl)) config.crossOrigin = 'anonymous';

  viewer = window.pannellum.viewer(els.pano, config);
  viewer.on('error', (e) =>
    showMessage(
      'This panorama would not load',
      `<p class="muted">${escapeHtml(String(e))}</p>
       <p class="muted">If it was just stitched, the file may still be uploading.</p>`
    )
  );
}

function showSinglePanorama(url) {
  document.title = 'Panorama preview';
  els.dock.classList.add('hidden');
  els.tag.innerHTML = `<div class="rm">Panorama preview</div><div class="sz mono">${escapeHtml(url)}</div>`;
  mountViewer(url);
}

/* ------------------------------------------------------------------ utils */

async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    els.copy.textContent = 'Copied';
  } catch {
    els.copy.textContent = location.href;
  }
  setTimeout(() => (els.copy.textContent = 'Copy link'), 1800);
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
