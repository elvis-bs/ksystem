-- Experimental only. Do not apply to production until device ownership,
-- recovery, local service and all client surfaces are integrated.
create table if not exists public.offline_store_presence (
  business_id uuid primary key references auth.users (id) on delete cascade,
  credential_hash bytea not null check (octet_length(credential_hash) = 32),
  last_seen_at timestamptz,
  seen_revision bigint
);
alter table public.offline_store_presence
  add column if not exists seen_revision bigint;

alter table public.offline_store_presence enable row level security;
revoke all on public.offline_store_presence from public, anon, authenticated;

create or replace function public.experimental_enable_store_presence(p_credential text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := auth.uid();
begin
  if v_business_id is null then raise exception 'Authentication required'; end if;
  if p_credential is null or p_credential !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid device credential';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business_id::text, 512483));
  insert into public.offline_store_presence (business_id, credential_hash)
  values (v_business_id, pg_catalog.sha256(pg_catalog.convert_to(p_credential, 'UTF8')));
end;
$$;

drop function if exists public.experimental_store_heartbeat(text);
create or replace function public.experimental_store_heartbeat(p_credential text, p_expected_revision bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := auth.uid();
  v_revision bigint;
begin
  if v_business_id is null then raise exception 'Authentication required'; end if;
  if p_credential is null or p_credential !~ '^[0-9a-f]{64}$'
    or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid device credential';
  end if;
  select sync_revision into v_revision from public.business_data
  where user_id = v_business_id for share;
  if not found or v_revision <> p_expected_revision then
    raise exception 'Business revision differs';
  end if;
  update public.offline_store_presence
  set last_seen_at = pg_catalog.clock_timestamp(), seen_revision = v_revision
  where business_id = v_business_id
    and credential_hash = pg_catalog.sha256(pg_catalog.convert_to(p_credential, 'UTF8'));
  if not found then raise exception 'Invalid device credential'; end if;
end;
$$;

create or replace function public.experimental_store_is_present(p_business_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select coalesce((
    select last_seen_at is not null
      and last_seen_at > pg_catalog.clock_timestamp() - interval '90 seconds'
      and last_seen_at <= pg_catalog.clock_timestamp()
      and exists (select 1 from public.business_data
        where user_id = p_business_id and sync_revision = seen_revision)
    from public.offline_store_presence where business_id = p_business_id
  ), true)
$$;

create or replace function public.experimental_guard_online_order_presence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.business_id::text, 512483));
  if not public.experimental_store_is_present(new.business_id) then
    raise exception using errcode = 'P0001', message = 'STORE_OFFLINE';
  end if;
  return new;
end;
$$;

drop trigger if exists experimental_online_order_presence on public.online_orders;
create trigger experimental_online_order_presence
before insert on public.online_orders
for each row execute function public.experimental_guard_online_order_presence();

revoke all on function public.experimental_enable_store_presence(text) from public, anon;
revoke all on function public.experimental_store_heartbeat(text, bigint) from public, anon;
revoke all on function public.experimental_store_is_present(uuid) from public, anon, authenticated;
grant execute on function public.experimental_enable_store_presence(text) to authenticated;
grant execute on function public.experimental_store_heartbeat(text, bigint) to authenticated;
grant execute on function public.experimental_store_is_present(uuid) to service_role;
