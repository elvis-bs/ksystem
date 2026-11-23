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

create table if not exists public.public_menus (
  user_id uuid primary key references auth.users (id) on delete cascade,
  menu jsonb not null,
  delivery_fee numeric(10, 2) not null default 0 check (delivery_fee >= 0),
  pickup_enabled boolean not null default false,
  published boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.public_menus enable row level security;

drop policy if exists "Anyone can read published menus" on public.public_menus;
create policy "Anyone can read published menus"
  on public.public_menus
  for select
  to anon, authenticated
  using (published or (select auth.uid()) = user_id);

drop policy if exists "Users can create their own public menu" on public.public_menus;
create policy "Users can create their own public menu"
  on public.public_menus
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own public menu" on public.public_menus;
create policy "Users can update their own public menu"
  on public.public_menus
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.public_menus from anon;
grant select on public.public_menus to anon, authenticated;
grant insert, update on public.public_menus to authenticated;
grant select on public.public_menus to service_role;

create table if not exists public.online_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references auth.users (id) on delete cascade,
  payment_id text unique,
  payment_status text not null default 'pending'
    check (payment_status in ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'failed')),
  status text not null default 'Aguardando Pix'
    check (status in ('Aguardando Pix', 'Recebido', 'Em preparo', 'Saiu para entrega', 'Concluído', 'Cancelado')),
  order_data jsonb not null,
  total numeric(10, 2) not null check (total > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists online_orders_business_created_idx
  on public.online_orders (business_id, created_at desc);

create table if not exists public.delivery_drivers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  business_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 80),
  email text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists delivery_drivers_business_idx
  on public.delivery_drivers (business_id, created_at desc);

alter table public.delivery_drivers enable row level security;

drop policy if exists "Businesses can read their delivery drivers" on public.delivery_drivers;
create policy "Businesses can read their delivery drivers"
  on public.delivery_drivers
  for select
  to authenticated
  using ((select auth.uid()) = business_id);

drop policy if exists "Drivers can read their own profile" on public.delivery_drivers;
create policy "Drivers can read their own profile"
  on public.delivery_drivers
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Businesses can update their delivery drivers" on public.delivery_drivers;
create policy "Businesses can update their delivery drivers"
  on public.delivery_drivers
  for update
  to authenticated
  using ((select auth.uid()) = business_id)
  with check ((select auth.uid()) = business_id);

revoke all on public.delivery_drivers from public, anon, authenticated;
grant select on public.delivery_drivers to authenticated;
grant update (active) on public.delivery_drivers to authenticated;
grant select, insert, update, delete on public.delivery_drivers to service_role;

alter table public.online_orders enable row level security;

drop policy if exists "Users can read their own online orders" on public.online_orders;
create policy "Users can read their own online orders"
  on public.online_orders
  for select
  to authenticated
  using ((select auth.uid()) = business_id);

alter table public.online_orders
  add column if not exists delivery_driver_id uuid references auth.users (id) on delete set null;

create index if not exists online_orders_delivery_driver_idx
  on public.online_orders (delivery_driver_id, created_at desc)
  where delivery_driver_id is not null;

drop policy if exists "Delivery drivers can read available and assigned orders" on public.online_orders;
create policy "Delivery drivers can read available and assigned orders"
  on public.online_orders
  for select
  to authenticated
  using (
    order_data ->> 'fulfillment' = 'delivery'
    and exists (
      select 1
      from public.delivery_drivers as driver
      where driver.user_id = (select auth.uid())
        and driver.business_id = online_orders.business_id
        and driver.active
    )
    and (
      delivery_driver_id = (select auth.uid())
      or (delivery_driver_id is null and status = 'Saiu para entrega')
    )
  );

drop policy if exists "Users can update status of their own online orders" on public.online_orders;
create policy "Users can update status of their own online orders"
  on public.online_orders
  for update
  to authenticated
  using ((select auth.uid()) = business_id)
  with check ((select auth.uid()) = business_id);

drop policy if exists "Delivery drivers can finish their assigned orders" on public.online_orders;
create policy "Delivery drivers can finish their assigned orders"
  on public.online_orders
  for update
  to authenticated
  using (
    delivery_driver_id = (select auth.uid())
    and status = 'Saiu para entrega'
    and exists (
      select 1
      from public.delivery_drivers as driver
      where driver.user_id = (select auth.uid())
        and driver.business_id = online_orders.business_id
        and driver.active
    )
  )
  with check (
    delivery_driver_id = (select auth.uid())
    and status = 'Concluído'
    and exists (
      select 1
      from public.delivery_drivers as driver
      where driver.user_id = (select auth.uid())
        and driver.business_id = online_orders.business_id
        and driver.active
    )
  );

revoke all on public.online_orders from anon, authenticated;
grant select on public.online_orders to authenticated;
grant update (status) on public.online_orders to authenticated;
grant select, insert, update on public.online_orders to service_role;

create or replace function public.claim_delivery_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1
    from public.delivery_drivers as driver
    where driver.user_id = auth.uid()
      and driver.active
  ) then
    raise exception 'Active delivery driver required';
  end if;

  update public.online_orders
  set delivery_driver_id = auth.uid(),
      updated_at = clock_timestamp()
  where id = p_order_id
    and delivery_driver_id is null
    and status = 'Saiu para entrega'
    and order_data ->> 'fulfillment' = 'delivery'
    and (
      order_data ->> 'paymentMethod' <> 'pix'
      or payment_status = 'approved'
    )
    and exists (
      select 1
      from public.delivery_drivers as driver
      where driver.user_id = auth.uid()
        and driver.business_id = online_orders.business_id
        and driver.active
    );

  return found;
end;
$$;

revoke all on function public.claim_delivery_order(uuid) from public, anon;
grant execute on function public.claim_delivery_order(uuid) to authenticated;

create table if not exists public.mercadopago_connections (
  business_id uuid primary key references auth.users (id) on delete cascade,
  mp_user_id text not null,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  refresh_lock_until timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mercadopago_connections enable row level security;
revoke all on public.mercadopago_connections from public, anon, authenticated;
grant select, insert, update, delete on public.mercadopago_connections to service_role;

create table if not exists public.mercadopago_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  business_id uuid not null references auth.users (id) on delete cascade,
  code_verifier text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.mercadopago_oauth_states enable row level security;
revoke all on public.mercadopago_oauth_states from public, anon, authenticated;
grant select, insert, delete on public.mercadopago_oauth_states to service_role;

create table if not exists public.online_order_rate_limits (
  bucket_key text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0
);

alter table public.online_order_rate_limits enable row level security;
revoke all on public.online_order_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.online_order_rate_limits to service_role;

create or replace function public.consume_online_order_slot(p_bucket_key text, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_count integer;
begin
  if p_bucket_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid rate-limit key';
  end if;

  insert into public.online_order_rate_limits as limits (bucket_key, window_started_at, request_count)
  values (p_bucket_key, clock_timestamp(), 1)
  on conflict (bucket_key) do update
  set window_started_at = case
        when limits.window_started_at <= clock_timestamp() - interval '1 minute' then clock_timestamp()
        else limits.window_started_at
      end,
      request_count = case
        when limits.window_started_at <= clock_timestamp() - interval '1 minute' then 1
        else limits.request_count + 1
      end
  returning request_count into current_count;

  return current_count <= least(greatest(p_limit, 1), 20);
end;
$$;

revoke all on function public.consume_online_order_slot(text, integer) from public, anon, authenticated;
grant execute on function public.consume_online_order_slot(text, integer) to service_role;
