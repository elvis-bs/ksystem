-- Experimental only. Requires experimental-sync.sql and experimental-presence.sql.
-- This does not yet cover online-order mutations, storage, recovery, or service-role writes.
create or replace function public.experimental_device_lock_exists(p_business_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select case when auth.uid() is distinct from p_business_id then true
    else exists (select 1 from public.offline_store_presence where business_id = p_business_id) end
$$;

create or replace function public.experimental_guard_legacy_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_business_id uuid;
begin
  v_business_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if current_user = 'authenticated' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business_id::text, 512483));
    if public.experimental_device_lock_exists(v_business_id) then
      raise exception using errcode = 'P0001', message = 'STORE_DEVICE_LOCKED';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.experimental_lock_legacy_statement()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and auth.uid() is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 512483));
  end if;
  return null;
end;
$$;

drop trigger if exists experimental_lock_business_statement on public.business_data;
create trigger experimental_lock_business_statement
before insert or update or delete on public.business_data
for each statement execute function public.experimental_lock_legacy_statement();

drop trigger if exists experimental_guard_business_write on public.business_data;
create trigger experimental_guard_business_write
before insert or update or delete on public.business_data
for each row execute function public.experimental_guard_legacy_write();

drop trigger if exists experimental_lock_menu_statement on public.public_menus;
create trigger experimental_lock_menu_statement
before insert or update or delete on public.public_menus
for each statement execute function public.experimental_lock_legacy_statement();

drop trigger if exists experimental_guard_menu_write on public.public_menus;
create trigger experimental_guard_menu_write
before insert or update or delete on public.public_menus
for each row execute function public.experimental_guard_legacy_write();

revoke all on function public.apply_offline_snapshot(uuid, jsonb, bigint) from public, anon, authenticated;

create or replace function public.experimental_apply_owned_snapshot(
  p_credential text, p_operation_id uuid, p_snapshot jsonb, p_expected_revision bigint
)
returns jsonb
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
  if not exists (
    select 1 from public.offline_store_presence
    where business_id = v_business_id
      and credential_hash = pg_catalog.sha256(pg_catalog.convert_to(p_credential, 'UTF8'))
  ) then
    raise exception 'Invalid device credential';
  end if;
  return public.apply_offline_snapshot(p_operation_id, p_snapshot, p_expected_revision);
end;
$$;

revoke all on function public.experimental_device_lock_exists(uuid) from public, anon, authenticated;
grant execute on function public.experimental_device_lock_exists(uuid) to authenticated;
revoke all on function public.experimental_apply_owned_snapshot(text, uuid, jsonb, bigint) from public, anon;
grant execute on function public.experimental_apply_owned_snapshot(text, uuid, jsonb, bigint) to authenticated;

-- A missing operation is not proof of failure: an earlier request may still be in flight.
create or replace function public.experimental_owned_operation_status(
  p_credential text, p_operation_id uuid, p_snapshot jsonb, p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := auth.uid();
  v_operation public.offline_sync_operations%rowtype;
begin
  if v_business_id is null then raise exception 'Authentication required'; end if;
  if p_credential is null or p_credential !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid device credential';
  end if;
  if p_operation_id is null or p_snapshot is null or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid sync input';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business_id::text, 512483));
  if not exists (
    select 1 from public.offline_store_presence
    where business_id = v_business_id
      and credential_hash = pg_catalog.sha256(pg_catalog.convert_to(p_credential, 'UTF8'))
  ) then raise exception 'Invalid device credential'; end if;
  select * into v_operation from public.offline_sync_operations
  where business_id = v_business_id and operation_id = p_operation_id;
  if not found then return pg_catalog.jsonb_build_object('status', 'unknown'); end if;
  if v_operation.expected_revision <> p_expected_revision or v_operation.snapshot <> p_snapshot then
    raise exception 'Sync operation already used with different data';
  end if;
  return pg_catalog.jsonb_build_object('status', 'applied', 'revision', v_operation.applied_revision);
end;
$$;

revoke all on function public.experimental_owned_operation_status(text, uuid, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.experimental_owned_operation_status(text, uuid, jsonb, bigint) to authenticated;
