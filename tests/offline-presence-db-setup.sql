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
  data jsonb not null default '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}',
  updated_at timestamptz not null default now()
);
create table public.online_orders (
  id integer generated always as identity primary key,
  business_id uuid not null references auth.users (id),
  payment_method text not null default 'pix'
);
