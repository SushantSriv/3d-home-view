/**
 * Data layer. Everything that talks to Supabase lives here so the pages stay dumb.
 *
 * This module is loaded lazily (dynamic import) by the pages that need it, so that
 * the demo tour keeps working with no network and no Supabase project at all.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, BUCKETS } from './config.js';

const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.58.0');

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

export { BUCKETS };

/** Public CDN URL for an object in a public bucket. */
export function publicUrl(bucket, path) {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path; // already absolute
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

/** Unambiguous alphabet: no 0/O/1/I/l, so a slug survives being read aloud. */
const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

function randomSlug(len = 7) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('');
}

/* ------------------------------------------------------------------ properties */

export async function listProperties() {
  const { data, error } = await sb
    .from('properties')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function listPublishedProperties() {
  const { data, error } = await sb
    .from('properties')
    .select('*')
    .eq('is_published', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getProperty(id) {
  const { data, error } = await sb.from('properties').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

/** The public read used by tour.html. One round trip for the property and its rooms. */
export async function getTourBySlug(slug) {
  const { data, error } = await sb
    .from('properties')
    .select('*, rooms(*)')
    .eq('share_slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  data.rooms = (data.rooms || []).sort((a, b) => a.sort_order - b.sort_order);
  return data;
}

export async function createProperty({ name, address }) {
  // Slugs are random, so a collision is vanishingly unlikely - but the column is
  // UNIQUE, so retry rather than hand the user a raw constraint violation.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await sb
      .from('properties')
      .insert({ name, address: address || null, share_slug: randomSlug() })
      .select()
      .single();
    if (!error) return data;
    if (error.code !== '23505') throw error;
  }
  throw new Error('Could not allocate a unique share link. Try again.');
}

export async function updateProperty(id, patch) {
  const { data, error } = await sb.from('properties').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteProperty(id) {
  const { error } = await sb.from('properties').delete().eq('id', id);
  if (error) throw error;
}

/* ----------------------------------------------------------------------- rooms */

export async function listRooms(propertyId) {
  const { data, error } = await sb
    .from('rooms')
    .select('*')
    .eq('property_id', propertyId)
    .order('sort_order');
  if (error) throw error;
  return data;
}

export async function createRoom(propertyId, { label, pin_x, pin_y, dimensions_m2, sort_order }) {
  const { data, error } = await sb
    .from('rooms')
    .insert({
      property_id: propertyId,
      label,
      pin_x,
      pin_y,
      dimensions_m2: dimensions_m2 ?? null,
      sort_order: sort_order ?? 0,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateRoom(id, patch) {
  const { data, error } = await sb.from('rooms').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteRoom(id) {
  const { error } = await sb.from('rooms').delete().eq('id', id);
  if (error) throw error;
}

/* ---------------------------------------------------------------- room_videos */

export async function listRoomVideos(propertyId) {
  const { data, error } = await sb
    .from('room_videos')
    .select('*, rooms!inner(property_id)')
    .eq('rooms.property_id', propertyId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/** Enqueue a stitching job. The worker picks it up via claim_next_job(). */
export async function enqueueVideo(roomId, storagePath, meta = {}) {
  const { data, error } = await sb
    .from('room_videos')
    .insert({
      room_id: roomId,
      raw_video_path: storagePath,
      processing_status: 'queued',
      duration_seconds: meta.durationSeconds ?? null,
      size_bytes: meta.sizeBytes ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/* --------------------------------------------------------------------- storage */

/**
 * Every path we generate is timestamped, so nothing here ever needs to overwrite.
 * That matters: `upsert` makes storage treat the write as INSERT *or UPDATE*, and
 * the raw-videos bucket is deliberately a write-only drop box with an INSERT-only
 * policy. Sending upsert there fails with a row-level-security violation.
 */
/**
 * Uploaded via raw XHR rather than supabase-js, purely to get upload progress:
 * the client library returns a promise with no progress events, and a seller
 * pushing 30 MB over a phone connection deserves better than a frozen button.
 * The endpoint and headers are exactly what supabase-js would have sent.
 */
function upload(bucket, path, file, onProgress, contentType, upsert = false) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Authorization', `Bearer ${SUPABASE_ANON_KEY}`);
    xhr.setRequestHeader('Content-Type', contentType || contentTypeOf(file));
    xhr.setRequestHeader('Cache-Control', '3600');
    // Only panoramas overwrite: they use a fixed per-room key so re-doing a room
    // replaces it. raw-videos must never set this - its policy is INSERT only.
    if (upsert) xhr.setRequestHeader('x-upsert', 'true');

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress?.(ev.loaded / ev.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        return resolve(path);
      }
      // Storage reports failures as a JSON body; surface its message, not "400".
      let message = `Upload failed (HTTP ${xhr.status})`;
      try {
        const body = JSON.parse(xhr.responseText);
        message = body.message || body.error || message;
      } catch { /* non-JSON body; keep the status message */ }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('Failed to fetch'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(file);
  });
}

/**
 * Each bucket has a MIME allow-list, and browsers do not always fill in `file.type`
 * - an iPhone .mov picked from Files often arrives blank. Falling back to
 * application/octet-stream would be rejected, so infer from the extension instead.
 */
const MIME_BY_EXT = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime',
  webm: 'video/webm', mkv: 'video/x-matroska',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', svg: 'image/svg+xml',
};

function contentTypeOf(file) {
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  return MIME_BY_EXT[extOf(file, '')] || 'application/octet-stream';
}

/** Keep the original extension so the worker can pick the right decoder. */
function extOf(file, fallback) {
  const m = /\.([a-z0-9]+)$/i.exec(file.name || '');
  return (m ? m[1] : fallback).toLowerCase();
}

export async function uploadFloorPlan(propertyId, file, onProgress) {
  const path = `${propertyId}/plan-${Date.now()}.${extOf(file, 'png')}`;
  await upload(BUCKETS.floorPlans, path, file, onProgress);
  return path;
}

/**
 * A panorama prepared in the browser goes straight into the public bucket - there
 * is nothing for the worker to do, so the room is finished the moment this returns.
 */
export async function uploadRoomPanorama(propertyId, roomId, blob, onProgress) {
  const path = `${propertyId}/${roomId}.jpg`;
  await upload(BUCKETS.panoramas, path, blob, onProgress, 'image/jpeg', true);
  return path;
}

export async function uploadRoomVideo(propertyId, roomId, file, onProgress) {
  const path = `${propertyId}/${roomId}/${Date.now()}.${extOf(file, 'mp4')}`;
  await upload(BUCKETS.rawVideos, path, file, onProgress);
  return path;
}

/* ----------------------------------------------------------------------- misc */

/** Absolute, shareable URL for a tour - works on Pages, on a custom domain, and locally. */
export function shareUrl(slug) {
  const base = location.href.replace(/\/[^/]*$/, '/');
  return `${new URL('tour.html', base).href}?t=${encodeURIComponent(slug)}`;
}

/**
 * Supabase errors are objects, not Errors, and their `message` is often a Postgres
 * string that means nothing to a seller. Translate the ones we can predict.
 */
export function humanError(err) {
  const msg = err?.message || String(err);
  if (/Failed to fetch|NetworkError/i.test(msg)) {
    return 'Cannot reach the database. Check your connection - or the Supabase project may be paused (free projects pause after 7 days idle; open the dashboard and press Resume).';
  }
  if (/row-level security|violates row-level/i.test(msg)) {
    return 'The database rejected that write. The security policies in supabase/schema.sql may not have been applied yet.';
  }
  if (/Bucket not found/i.test(msg)) {
    return 'A storage bucket is missing. Create floor-plans, panoramas and raw-videos in the Supabase dashboard (see supabase/README.md).';
  }
  if (/column .* does not exist|Could not find the .* column/i.test(msg)) {
    return 'The database is missing a newer column. Re-run supabase/schema.sql in the Supabase SQL editor - it is safe to run again and will not touch your data.';
  }
  if (/relation .* does not exist/i.test(msg)) {
    return 'The database tables are missing. Run supabase/schema.sql in the Supabase SQL editor.';
  }
  if (/mime type .* is not supported|InvalidMimeType/i.test(msg)) {
    return 'That file type is not accepted. Room videos must be MP4, MOV, WebM or MKV; floor plans must be PNG, JPG, WebP or SVG.';
  }
  if (/exceeded the maximum allowed size|Payload too large/i.test(msg)) {
    return 'That file is larger than the Supabase upload limit. Trim the video or lower its resolution before uploading.';
  }
  return msg;
}
