create table if not exists public.business_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.business_data enable row level security;

drop policy if exists "Users can read their own business data" on public.business_data;
create policy "Users can read their own business data"
  on public.business_data
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own business data" on public.business_data;
create policy "Users can create their own business data"
  on public.business_data
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own business data" on public.business_data;
create policy "Users can update their own business data"
  on public.business_data
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.business_data from anon;
grant select, insert, update on public.business_data to authenticated;
