create role anon;
create role authenticated;
create role service_role;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create table public.business_data (
  user_id uuid primary key references auth.users (id),
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table public.public_menus (
  user_id uuid primary key references auth.users (id),
  menu jsonb not null
);
create table public.online_orders (
  id integer generated always as identity primary key,
  business_id uuid not null references auth.users (id)
);
grant usage on schema auth to authenticated;
grant select, insert, update, delete on public.business_data, public.public_menus to authenticated;
alter table public.business_data enable row level security;
alter table public.public_menus enable row level security;
create policy own_business on public.business_data for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy own_menu on public.public_menus for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
