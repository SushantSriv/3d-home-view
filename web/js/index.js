/**
 * Landing page: the "Published tours" panel.
 *
 * Four states and all of them are real ones. index.html paints the skeleton
 * itself, before this module has even been fetched, so the panel is never an
 * empty hole; this file replaces it with the list, a genuine empty state, or a
 * sentence a person can act on.
 */

import { isConfigured } from './config.js';

const box = document.getElementById('tours');

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Replace the panel and clear the busy flag the skeleton markup set. */
function show(html) {
  box.innerHTML = html;
  box.removeAttribute('aria-busy');
}

/* Two ways forward that exist whether or not the database answers. `.none` keeps
   the buttons at their own width inside `.row` instead of stretching them. */
const WAYS_ON = `
  <div class="row">
    <a class="btn primary none" href="studio.html">Build a tour</a>
    <a class="btn none" href="tour.html?demo=1">Open the demo</a>
  </div>`;

/** The whole card is the link - a small "open" button beside it is a second target
    for the same thing, and on a phone it is the harder one to hit. */
function card(db, p) {
  const name = esc(p.name || 'Untitled tour');
  const href = esc(db.shareUrl(p.share_slug));
  return `<a href="${href}" aria-label="Open the tour of ${name}">
      <div class="nm">${name}</div>
      ${p.address ? `<div class="ad">${esc(p.address)}</div>` : ''}
    </a>`;
}

(async function () {
  if (!isConfigured()) {
    show(`<div class="banner">
      <p><strong>Supabase is not configured yet.</strong></p>
      <p class="muted">Fill in <span class="mono">web/js/config.js</span> and run
      <span class="mono">supabase/schema.sql</span> &mdash; see <span class="mono">supabase/README.md</span>.
      The <a href="tour.html?demo=1">demo tour</a> works without any of that.</p>
    </div>`);
    return;
  }

  let db;
  try {
    db = await import('./db.js');
    const props = await db.listPublishedProperties();

    // PostgREST answers an empty table with [], but a null here would otherwise
    // throw inside the try and surface as a database error rather than as "none yet".
    if (!props || !props.length) {
      show(`<div class="stack">
        <p class="muted">Nothing is published yet. The first tour takes about ten minutes:
        one panorama per room, a floor plan, and a pin for each room.</p>
        ${WAYS_ON}
      </div>`);
      return;
    }

    show(`<div class="tourlist">${props.map((p) => card(db, p)).join('')}</div>`);
  } catch (err) {
    // db.js may itself have failed to load, in which case there is no humanError
    // to call and the raw message is the most honest thing available.
    const text = !db ? `Could not load the data layer: ${err.message}` : db.humanError(err);
    show(`<div class="stack">
      <div class="banner err">
        <p><strong>The list of published tours could not be loaded.</strong></p>
        <p>${esc(text)}</p>
      </div>
      ${WAYS_ON}
    </div>`);
  }
})();
