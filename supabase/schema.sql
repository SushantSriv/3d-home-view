-- ============================================================================
--  360 Home Tour -- Supabase schema
--
--  Paste this whole file into the Supabase SQL editor and run it. It is
--  idempotent: running it again is safe and will not destroy data.
--
--  Project: ikuovilpewamyareelqm
--  Walkthrough: supabase/README.md
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables ---

create table if not exists public.properties (
  id               uuid primary key default gen_random_uuid(),
  name             text        not null,
  address          text,
  -- Storage path inside the floor-plans bucket, not a full URL. The client turns
  -- it into a CDN URL, so the project can be renamed without rewriting rows.
  floor_plan_url   text,
  share_slug       text        not null unique,
  is_published     boolean     not null default false,
  created_at       timestamptz not null default now()
);

create table if not exists public.rooms (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid        not null references public.properties(id) on delete cascade,
  label            text        not null,
  dimensions_m2    numeric(6,1),
  -- Normalised 0..1 position on the floor plan image, so pins survive any resize.
  pin_x            real        check (pin_x between 0 and 1),
  pin_y            real        check (pin_y between 0 and 1),
  -- Degrees to rotate doorway arrows by. We cannot know which way the phone was
  -- pointing when recording started, so this is a manual dial in the studio.
  heading_offset   integer     not null default 0,
  panorama_url     text,
  sort_order       integer     not null default 0,
  created_at       timestamptz not null default now()
);

create table if not exists public.room_videos (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid        not null references public.rooms(id) on delete cascade,
  raw_video_path    text        not null,
  processing_status text        not null default 'queued'
                      check (processing_status in ('queued','processing','done','failed')),
  error_message     text,
  duration_seconds  numeric(8,2),
  size_bytes        bigint,
  claimed_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists rooms_property_idx        on public.rooms(property_id, sort_order);
create index if not exists room_videos_room_idx      on public.room_videos(room_id);
create index if not exists room_videos_queue_idx     on public.room_videos(processing_status, created_at);
create index if not exists properties_published_idx  on public.properties(is_published, created_at desc);

-- Columns added after the first release; harmless on a fresh database.
alter table public.rooms       add column if not exists heading_offset integer not null default 0;
-- Panorama geometry. A phone panorama photo is not a full sphere: it covers some
-- horizontal sweep and a limited vertical band, and the viewer has to be told
-- which, or it stretches the image over the whole sphere. 360/180/0 is a
-- complete equirectangular panorama, which is what the video pipeline produces.
alter table public.rooms       add column if not exists haov     real not null default 360;
alter table public.rooms       add column if not exists vaov     real not null default 180;
alter table public.rooms       add column if not exists v_offset real not null default 0;
alter table public.room_videos add column if not exists duration_seconds numeric(8,2);
alter table public.room_videos add column if not exists size_bytes bigint;
alter table public.room_videos add column if not exists finished_at timestamptz;

-- ------------------------------------------------------------------ RLS ---
--
--  This app has NO LOGIN by design (see risk R1 in PROGRESS.md), so the anon
--  role is granted full access. What that means in practice: anyone who finds
--  the studio URL can create and delete tours. Accepted deliberately for a pet
--  project. When that stops being acceptable, replace the anon write policies
--  below with owner-scoped ones keyed on auth.uid().
--
--  The service_role key used by the worker bypasses RLS entirely and is not
--  affected by any of this.

alter table public.properties  enable row level security;
alter table public.rooms       enable row level security;
alter table public.room_videos enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['properties','rooms','room_videos'] loop
    execute format('drop policy if exists %I on public.%I', t || '_anon_all', t);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
      t || '_anon_all', t
    );
  end loop;
end $$;

-- -------------------------------------------------------------- storage ---

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('floor-plans', 'floor-plans', true,   15 * 1024 * 1024, array['image/png','image/jpeg','image/webp','image/svg+xml']),
  ('panoramas',   'panoramas',   true,   30 * 1024 * 1024, array['image/jpeg','image/png','image/webp']),
  -- Raw videos stay private: only the worker's service key can read them, and
  -- they are deleted once a stitch succeeds to protect the 1 GB free tier.
  ('raw-videos',  'raw-videos',  false, 200 * 1024 * 1024, array['video/mp4','video/quicktime','video/webm','video/x-matroska'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- If this block fails with "must be owner of table objects", create the same
-- policies through Dashboard -> Storage -> Policies instead. See supabase/README.md.
do $$
begin
  drop policy if exists "tour_public_read"   on storage.objects;
  drop policy if exists "tour_anon_write"    on storage.objects;
  drop policy if exists "tour_video_upload"  on storage.objects;

  create policy "tour_public_read" on storage.objects
    for select to anon, authenticated
    using (bucket_id in ('floor-plans', 'panoramas'));

  create policy "tour_anon_write" on storage.objects
    for all to anon, authenticated
    using (bucket_id in ('floor-plans', 'panoramas'))
    with check (bucket_id in ('floor-plans', 'panoramas'));

  -- Write-only drop box: the browser may upload a video but never list or read one.
  -- INSERT only, deliberately. The client must therefore upload videos WITHOUT
  -- upsert: upsert asks storage for INSERT-or-UPDATE and this policy denies the
  -- UPDATE half. Video paths are timestamped, so nothing ever needs overwriting.
  create policy "tour_video_upload" on storage.objects
    for insert to anon, authenticated
    with check (bucket_id = 'raw-videos');
exception
  when insufficient_privilege then
    raise notice 'Skipped storage policies (insufficient privilege) -- create them in the dashboard, see supabase/README.md';
end $$;

-- ------------------------------------------------------- worker job queue ---
--
--  The worker never writes these tables directly. It calls these three
--  functions so that claiming is atomic and a crashed worker cannot wedge a job
--  in 'processing' forever.

-- Anything claimed but not finished within this window is considered abandoned.
-- The OUT parameters are prefixed because a RETURNS TABLE column named `id` or
-- `room_id` would shadow the real columns inside the body and make every
-- unqualified reference ambiguous.
create or replace function public.claim_next_job(stale_after interval default '30 minutes')
returns table (
  j_video_id      uuid,
  j_room_id       uuid,
  j_property_id   uuid,
  j_room_label    text,
  j_video_path    text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select v.id
    from public.room_videos v
    where v.processing_status = 'queued'
       or (v.processing_status = 'processing' and v.claimed_at < now() - stale_after)
    order by v.created_at
    for update skip locked
    limit 1
  )
  update public.room_videos v
     set processing_status = 'processing',
         claimed_at        = now(),
         error_message     = null
    from picked, public.rooms r
   where v.id = picked.id
     and r.id = v.room_id
  returning v.id, v.room_id, r.property_id, r.label, v.raw_video_path;
end;
$$;

create or replace function public.complete_job(job_id uuid, panorama_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rooms r
     set panorama_url = panorama_path
    from public.room_videos v
   where v.id = job_id and r.id = v.room_id;

  update public.room_videos
     set processing_status = 'done',
         finished_at       = now(),
         error_message     = null
   where id = job_id;
end;
$$;

create or replace function public.fail_job(job_id uuid, reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.room_videos
     set processing_status = 'failed',
         finished_at       = now(),
         error_message     = left(reason, 2000)
   where id = job_id;
end;
$$;

-- These are worker-only. The browser must never be able to move jobs around.
revoke all on function public.claim_next_job(interval) from public, anon, authenticated;
revoke all on function public.complete_job(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_job(uuid, text)     from public, anon, authenticated;
grant execute on function public.claim_next_job(interval) to service_role;
grant execute on function public.complete_job(uuid, text) to service_role;
grant execute on function public.fail_job(uuid, text)     to service_role;

-- --------------------------------------------------------------- checks ---

do $$
begin
  raise notice 'Schema applied. Buckets: %',
    (select string_agg(id, ', ' order by id) from storage.buckets
      where id in ('floor-plans','panoramas','raw-videos'));
end $$;
