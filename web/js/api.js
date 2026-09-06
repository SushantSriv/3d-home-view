/**
 * A very small Supabase client, written here rather than imported.
 *
 * Why not the real one: db.js only ever used supabase-js for PostgREST queries,
 * one public-URL string concat and one storage delete. Uploads already go
 * through raw XHR, because supabase-js cannot report upload progress. Paying
 * 186 kB across 14 cross-origin modules from esm.sh for that is a poor trade on
 * its own — but the real cost was structural:
 *
 *   - it was a `await import('https://esm.sh/...')` at module top level, so
 *     db.js did not resolve until the whole remote graph did, and every
 *     published listing link hard-depended on a third-party CDN staying up.
 *     esm.sh having a bad day meant a buyer opening a finn.no listing saw
 *     "Failed to fetch dynamically imported module".
 *   - it put ~1 s of serial cross-origin fetches in front of the buyer's first
 *     paint, before the tour query could even start.
 *
 * The surface below is deliberately shaped like supabase-js so that the rest of
 * db.js reads the same. It implements only what this app calls, and it throws
 * on anything it does not understand rather than silently returning nothing.
 */

/** PostgREST returns errors as JSON; keep the status so callers can branch on it. */
class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code;
    this.details = body?.details;
    this.hint = body?.hint;
  }
}

/**
 * One table query. Mirrors the fluent shape of supabase-js closely enough that
 * call sites are identical, and resolves to { data, error } for the same reason.
 */
class Query {
  constructor(base, headers, table) {
    this._url = `${base}/rest/v1/${table}`;
    this._headers = headers;
    this._params = new URLSearchParams();
    this._method = 'GET';
    this._body = null;
    this._single = null; // 'one' | 'maybe'
    this._wantsReturn = false;
  }

  select(columns = '*') {
    this._params.set('select', columns);
    if (this._method !== 'GET') this._wantsReturn = true;
    return this;
  }

  eq(column, value) {
    this._params.append(column, `eq.${value}`);
    return this;
  }

  order(column, { ascending = true } = {}) {
    const existing = this._params.get('order');
    const clause = `${column}.${ascending ? 'asc' : 'desc'}`;
    this._params.set('order', existing ? `${existing},${clause}` : clause);
    return this;
  }

  limit(n) {
    this._params.set('limit', String(n));
    return this;
  }

  insert(row) {
    this._method = 'POST';
    this._body = row;
    return this;
  }

  update(patch) {
    this._method = 'PATCH';
    this._body = patch;
    return this;
  }

  delete() {
    this._method = 'DELETE';
    return this;
  }

  /** Exactly one row, and an error when that is not what came back. */
  single() {
    this._single = 'one';
    return this;
  }

  /** One row or null. */
  maybeSingle() {
    this._single = 'maybe';
    return this;
  }

  // Thenable, so `await query` works without an explicit .execute().
  then(resolve, reject) {
    return this._run().then(resolve, reject);
  }

  async _run() {
    const headers = { ...this._headers };
    if (this._body) headers['Content-Type'] = 'application/json';

    // PostgREST only returns rows when asked to, and only one when told so.
    const prefer = [];
    if (this._method !== 'GET' && this._wantsReturn) prefer.push('return=representation');
    else if (this._method !== 'GET') prefer.push('return=minimal');
    if (this._single) headers.Accept = 'application/vnd.pgrst.object+json';
    if (prefer.length) headers.Prefer = prefer.join(',');

    const qs = this._params.toString();
    let res;
    try {
      res = await fetch(qs ? `${this._url}?${qs}` : this._url, {
        method: this._method,
        headers,
        body: this._body ? JSON.stringify(this._body) : undefined,
      });
    } catch (cause) {
      // A network failure is not a database error, and saying so matters: the
      // free tier sleeps, phones lose signal, and "failed to fetch" is not a
      // sentence anyone can act on.
      return { data: null, error: new ApiError('offline', 0, { code: 'network' }) };
    }

    // 406 from the object accept-header means "no rows"; for maybeSingle that
    // is a legitimate answer rather than a failure.
    if (res.status === 406 && this._single === 'maybe') return { data: null, error: null };
    if (res.status === 204) return { data: null, error: null };

    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null; // an HTML error page from a proxy, say
      }
    }

    if (!res.ok) {
      const message = body?.message || `${res.status} ${res.statusText}`;
      return { data: null, error: new ApiError(message, res.status, body) };
    }
    return { data: body, error: null };
  }
}

class Bucket {
  constructor(base, headers, name) {
    this._base = base;
    this._headers = headers;
    this._name = name;
  }

  getPublicUrl(path) {
    const encoded = String(path).split('/').map(encodeURIComponent).join('/');
    return { data: { publicUrl: `${this._base}/storage/v1/object/public/${this._name}/${encoded}` } };
  }

  async remove(paths) {
    try {
      const res = await fetch(`${this._base}/storage/v1/object/${this._name}`, {
        method: 'DELETE',
        headers: { ...this._headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        return { data: null, error: new ApiError(body?.message || `${res.status}`, res.status, body) };
      }
      return { data: await res.json().catch(() => null), error: null };
    } catch {
      return { data: null, error: new ApiError('offline', 0, { code: 'network' }) };
    }
  }
}

export function createClient(url, anonKey) {
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  return {
    url: base,
    anonKey,
    from: (table) => new Query(base, headers, table),
    storage: { from: (name) => new Bucket(base, headers, name) },
  };
}

export { ApiError };
