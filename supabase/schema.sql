-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query).

create table if not exists public.cases (
  id          uuid primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  serial      text,
  model       text,
  firmware    text,
  profile     text,
  verdict     text,
  fails       int  not null default 0,
  warns       int  not null default 0,
  tech        text,
  outcome     text not null default '',
  symptoms    text[] not null default '{}',
  notes       text not null default '',
  resolution  text not null default '',
  summary     jsonb not null default '[]',
  report      jsonb
);

create index if not exists cases_serial_idx on public.cases (serial);
create index if not exists cases_created_idx on public.cases (created_at desc);

alter table public.cases enable row level security;

-- Only signed-in team members can read, add and edit cases. There is no delete policy,
-- so cases cannot be deleted from the web page.
create policy "team can read"   on public.cases for select to authenticated using (true);
create policy "team can add"    on public.cases for insert to authenticated with check (true);
create policy "team can update" on public.cases for update to authenticated using (true) with check (true);
