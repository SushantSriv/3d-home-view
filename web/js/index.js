/** Landing page: list whatever tours are published, degrade gracefully if not set up. */

import { isConfigured } from './config.js';

const box = document.getElementById('tours');

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

(async function () {
  if (!isConfigured()) {
    box.innerHTML = `<div class="banner">
      <p><strong>Supabase is not configured yet.</strong></p>
      <p class="muted">Fill in <span class="mono">web/js/config.js</span> and run
      <span class="mono">supabase/schema.sql</span> &mdash; see <span class="mono">supabase/README.md</span>.
      The <a href="tour.html?demo=1">demo tour</a> works without any of that.</p>
    </div>`;
    return;
  }

  let db;
  try {
    db = await import('./db.js');
    const props = await db.listPublishedProperties();

    if (!props.length) {
      box.innerHTML = `<p class="muted">Nothing published yet.
        <a href="studio.html">Build the first tour</a>, or try the
        <a href="tour.html?demo=1">demo</a>.</p>`;
      return;
    }

    box.innerHTML = props
      .map(
        (p) => `<div class="room-item">
          <header>
            <strong>${esc(p.name)}</strong>
            <a class="btn sm primary" href="tour.html?t=${encodeURIComponent(p.share_slug)}">Open tour</a>
          </header>
          ${p.address ? `<div class="muted">${esc(p.address)}</div>` : ''}
          <div class="mono muted">/tour/${esc(p.share_slug)}</div>
        </div>`
      )
      .join('');
  } catch (err) {
    // db may itself have failed to load (offline, CDN blocked), so fall back to the raw message.
    const text = db ? db.humanError(err) : `Could not load the data layer: ${err.message}`;
    box.innerHTML = `<div class="banner err"><p>${esc(text)}</p></div>`;
  }
})();
