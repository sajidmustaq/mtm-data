-- MTM Data — Supabase PostgreSQL Schema & Strict Row-Level Security (RLS)
-- Project: https://pgmzlnwowwjlgwwkcfhr.supabase.co

-- Non-exposed schema for SECURITY DEFINER RLS helpers (not reachable via PostgREST Data API)
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, postgres, service_role;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(username) between 3 and 30),
  username_key text not null unique,
  role text not null check (role in ('admin', 'user')),
  active boolean not null default true,
  assignments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.records (
  id text primary key,
  code text not null,
  name text not null default '',
  father text not null default '',
  duty text not null default '',
  district text not null default '',
  division text not null default '',
  province text not null,
  assigned_to uuid[] not null default '{}',
  source_key text not null unique,
  updated_at text not null default '',
  updated_at_ms bigint not null default 0
);

create index if not exists idx_records_assigned_to on public.records using gin (assigned_to);
create index if not exists idx_records_province on public.records (province);
create index if not exists idx_records_updated_at_ms on public.records (updated_at_ms);

-- Admin-only private columns (branch, off_min, grade, ijara_min) — never exposed to regular users
create table if not exists public.records_private (
  record_id text primary key references public.records(id) on delete cascade,
  branch text not null default '',
  off_min text not null default '',
  grade text not null default '',
  ijara_min text not null default ''
);

create table if not exists public.entries (
  id text primary key,
  record_id text not null references public.records(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  hifz text not null default '' check (hifz in ('', 'جی ہاں', 'جی نہیں')),
  nazra text not null default '' check (nazra in ('', 'جی ہاں', 'جی نہیں')),
  submitted boolean not null default false,
  submitted_at text not null default '',
  updated_by text not null default '',
  updated_at text not null default '',
  unique (record_id, user_id)
);

create index if not exists idx_entries_user_id on public.entries (user_id);

create table if not exists public.logs (
  id bigserial primary key,
  uid uuid not null references public.users(id) on delete cascade,
  username text not null check (char_length(username) <= 50),
  action text not null check (char_length(action) <= 100),
  detail text not null default '' check (char_length(detail) <= 500),
  time text not null default '',
  created_at timestamptz not null default now(),
  province text not null default '',
  division text not null default '',
  district text not null default '',
  device text not null default ''
);

create index if not exists idx_logs_uid on public.logs (uid);
create index if not exists idx_logs_created_at on public.logs (created_at desc);

-- Helper functions in non-exposed `private` schema (fixed search_path, avoids RLS recursion)
create or replace function private.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users
    where id = (select auth.uid()) and active = true
  );
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users
    where id = (select auth.uid()) and active = true and role = 'admin'
  );
$$;

create or replace function private.user_matches_record(u_assignments jsonb, rec_province text, rec_division text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(coalesce(u_assignments, '[]'::jsonb)) as a
    where (a->>'province') = rec_province
      and (
        pg_catalog.jsonb_array_length(coalesce(a->'divisions', '[]'::jsonb)) = 0
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(coalesce(a->'divisions', '[]'::jsonb)) as d(val)
          where d.val = rec_division
        )
      )
  );
$$;

create or replace function public.sync_user_assignments(target_uid uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  u_rec record;
  c1 integer := 0;
  c2 integer := 0;
begin
  if current_user in ('anon', 'authenticated') and not private.is_admin() then
    raise exception 'Only active admins can sync assignments';
  end if;

  select id, role, active, assignments into u_rec from public.users where id = target_uid;

  if not found or not u_rec.active or u_rec.role <> 'user' then
    update public.records
    set assigned_to = pg_catalog.array_remove(assigned_to, target_uid),
        updated_at_ms = (extract(epoch from now()) * 1000)::bigint
    where target_uid = any(assigned_to);
    get diagnostics c1 = row_count;
    return c1;
  end if;

  update public.records
  set assigned_to = pg_catalog.array_remove(assigned_to, target_uid),
      updated_at_ms = (extract(epoch from now()) * 1000)::bigint
  where target_uid = any(assigned_to)
    and not private.user_matches_record(u_rec.assignments, province, division);
  get diagnostics c1 = row_count;

  update public.records
  set assigned_to = pg_catalog.array_append(assigned_to, target_uid),
      updated_at_ms = (extract(epoch from now()) * 1000)::bigint
  where not (target_uid = any(assigned_to))
    and private.user_matches_record(u_rec.assignments, province, division);
  get diagnostics c2 = row_count;

  return c1 + c2;
end;
$$;

-- Minimal explicit grants
revoke all on public.users, public.records, public.records_private, public.entries, public.logs from anon, public;
grant select, insert, update, delete on public.users, public.records, public.records_private, public.entries to authenticated, service_role;
grant select, insert on public.logs to authenticated, service_role;
grant usage, select on sequence public.logs_id_seq to authenticated, service_role;

revoke all on function private.is_active_user() from public, anon;
revoke all on function private.is_admin() from public, anon;
revoke all on function private.user_matches_record(jsonb, text, text) from public, anon;
revoke all on function public.sync_user_assignments(uuid) from public, anon;
grant execute on function private.is_active_user() to authenticated, service_role;
grant execute on function private.is_admin() to authenticated, service_role;
grant execute on function private.user_matches_record(jsonb, text, text) to authenticated, service_role;
grant execute on function public.sync_user_assignments(uuid) to authenticated, service_role;

-- Enable RLS
alter table public.users enable row level security;
alter table public.records enable row level security;
alter table public.records_private enable row level security;
alter table public.entries enable row level security;
alter table public.logs enable row level security;

-- Users policies (1 policy per command, all scoped to authenticated, wrapped in (select ...))
drop policy if exists "users_select" on public.users;
create policy "users_select" on public.users for select
to authenticated
using ((select private.is_admin()) or id = (select auth.uid()));

drop policy if exists "users_insert" on public.users;
create policy "users_insert" on public.users for insert
to authenticated
with check ((select private.is_admin()));

drop policy if exists "users_update" on public.users;
create policy "users_update" on public.users for update
to authenticated
using ((select private.is_admin()))
with check (
  (select private.is_admin())
  and (id <> (select auth.uid()) or (role = 'admin' and active = true))
);

drop policy if exists "users_delete" on public.users;
create policy "users_delete" on public.users for delete
to authenticated
using ((select private.is_admin()) and id <> (select auth.uid()));

-- Records policies (no overlapping FOR ALL; separate commands for clarity & single-policy-per-action)
drop policy if exists "records_admin_write" on public.records;
drop policy if exists "records_select" on public.records;
create policy "records_select" on public.records for select
to authenticated
using ((select private.is_admin()) or ((select private.is_active_user()) and (select auth.uid()) = any(assigned_to)));

drop policy if exists "records_insert" on public.records;
create policy "records_insert" on public.records for insert
to authenticated
with check ((select private.is_admin()));

drop policy if exists "records_update" on public.records;
create policy "records_update" on public.records for update
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

drop policy if exists "records_delete" on public.records;
create policy "records_delete" on public.records for delete
to authenticated
using ((select private.is_admin()));

-- Private columns (branch, off_min, grade, ijara_min) strictly admin-only
drop policy if exists "records_private_admin_only" on public.records_private;
create policy "records_private_admin_only" on public.records_private for all
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

-- Entries policies (user reads/creates own entry once; locked after submit; admin full control)
drop policy if exists "entries_select" on public.entries;
create policy "entries_select" on public.entries for select
to authenticated
using ((select private.is_admin()) or ((select private.is_active_user()) and user_id = (select auth.uid())));

drop policy if exists "entries_insert" on public.entries;
create policy "entries_insert" on public.entries for insert
to authenticated
with check (
  (select private.is_admin())
  or (
    (select private.is_active_user())
    and user_id = (select auth.uid())
    and id = record_id || '__' || (select auth.uid())::text
    and submitted = true
    and hifz in ('جی ہاں', 'جی نہیں')
    and nazra in ('جی ہاں', 'جی نہیں')
    and exists (
      select 1 from public.records r
      where r.id = record_id and (select auth.uid()) = any(r.assigned_to)
    )
  )
);

drop policy if exists "entries_update" on public.entries;
create policy "entries_update" on public.entries for update
to authenticated
using (
  (select private.is_admin())
  or (
    (select private.is_active_user())
    and user_id = (select auth.uid())
    and submitted = false
    and hifz = ''
    and nazra = ''
  )
)
with check (
  (select private.is_admin())
  or (
    (select private.is_active_user())
    and user_id = (select auth.uid())
    and id = record_id || '__' || (select auth.uid())::text
    and submitted = true
    and hifz in ('جی ہاں', 'جی نہیں')
    and nazra in ('جی ہاں', 'جی نہیں')
    and exists (
      select 1 from public.records r
      where r.id = record_id and (select auth.uid()) = any(r.assigned_to)
    )
  )
);

drop policy if exists "entries_delete" on public.entries;
create policy "entries_delete" on public.entries for delete
to authenticated
using ((select private.is_admin()));

-- Logs policies (admin reads; any active user can log their own actions)
drop policy if exists "logs_select" on public.logs;
create policy "logs_select" on public.logs for select
to authenticated
using ((select private.is_admin()));

drop policy if exists "logs_insert" on public.logs;
create policy "logs_insert" on public.logs for insert
to authenticated
with check ((select private.is_active_user()) and uid = (select auth.uid()));

-- Clean up any legacy helpers in public schema from earlier setup
drop function if exists public.is_active_user();
drop function if exists public.is_admin();
drop function if exists public.user_matches_record(jsonb, text, text);

-- Realtime sync for live entry/user/log updates (idempotent: checks before adding)
do $$
declare
  tbl text;
begin
  for tbl in select unnest(array['users', 'entries', 'logs']) loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = tbl
    ) then
      execute format('alter publication supabase_realtime add table public.%I', tbl);
    end if;
  end loop;
end $$;

alter table public.users replica identity full;
alter table public.entries replica identity full;
