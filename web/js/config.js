/**
 * Public runtime configuration.
 *
 * The anon key is DESIGNED to be public - it ships to every browser that loads the
 * site and is safe to commit. What protects the data is Supabase row-level security
 * (see ../../supabase/schema.sql), not secrecy of this key.
 *
 * The SERVICE ROLE key is a completely different thing: it bypasses row-level
 * security entirely. It must never appear in this directory. It lives in a local
 * .env file and in GitHub Actions secrets, and is used only by worker/worker.py.
 */

export const SUPABASE_URL = 'https://ikuovilpewamyareelqm.supabase.co';

export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlrdW92aWxwZXdhbXlhcmVlbHFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNzM5MjAsImV4cCI6MjEwMjk0OTkyMH0.Z8Z8rX4TOuOoN7ZyZGeJG6fXFYigsFPsu9mEXyTF1-U';

/** Storage bucket names. Must match supabase/schema.sql. */
export const BUCKETS = {
  floorPlans: 'floor-plans',
  panoramas: 'panoramas',
  rawVideos: 'raw-videos',
};

/** Client-side upload guards. Supabase free tier gives 1 GB of storage in total. */
export const LIMITS = {
  /** Reject room videos larger than this before wasting the user's upload bandwidth. */
  maxVideoBytes: 200 * 1024 * 1024,
  /** Floor plans are images; anything bigger is a photo of a screen, not a plan. */
  maxImageBytes: 15 * 1024 * 1024,
  /** Videos shorter than this almost never have enough overlap to stitch. */
  minVideoSeconds: 12,
  /** A panorama photo is wide but should still not be a 60 MB raw export. */
  maxPanoramaBytes: 40 * 1024 * 1024,
};

/** True once the placeholders above have been replaced with a real project. */
export const isConfigured = () =>
  SUPABASE_URL.startsWith('https://') &&
  !SUPABASE_URL.includes('YOUR-PROJECT') &&
  SUPABASE_ANON_KEY.length > 40;
