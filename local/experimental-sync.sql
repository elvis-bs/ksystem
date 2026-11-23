-- Experimental only: do not apply to a production project before the local
-- service, device authorization and recovery flow are complete.
alter table public.business_data
  add column if not exists sync_revision bigint not null default 0
  check (sync_revision >= 0);

create table if not exists public.offline_sync_operations (
  business_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  expected_revision bigint not null check (expected_revision >= 0),
  applied_revision bigint not null check (applied_revision > 0),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (business_id, operation_id)
);

alter table public.offline_sync_operations enable row level security;
revoke all on public.offline_sync_operations from public, anon, authenticated;

create or replace function public.bump_business_sync_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.sync_revision := old.sync_revision + 1;
  return new;
end;
$$;

drop trigger if exists business_sync_revision on public.business_data;
create trigger business_sync_revision
before update on public.business_data
for each row execute function public.bump_business_sync_revision();

create or replace function public.apply_offline_snapshot(
  p_operation_id uuid, p_snapshot jsonb, p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := auth.uid();
  current_revision bigint;
  previous_operation public.offline_sync_operations%rowtype;
begin
  if v_business_id is null then
    raise exception 'Authentication required';
  end if;
  if p_operation_id is null or p_expected_revision is null or p_expected_revision < 0
    or p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object'
    or coalesce(jsonb_typeof(p_snapshot -> 'products'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'ingredients'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'sales'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'cashSessions'), '') <> 'array'
  then
    raise exception 'Invalid sync input';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_snapshot -> 'cashSessions') as session
    where session ->> 'offlineClosureStatus' = 'provisional'
  ) then
    raise exception 'Provisional cash closure requires online reconciliation';
  end if;

  select sync_revision into current_revision
  from public.business_data
  where user_id = v_business_id
  for update;
  if not found then
    raise exception 'Business data not found';
  end if;

  select * into previous_operation
  from public.offline_sync_operations
  where offline_sync_operations.business_id = v_business_id
    and operation_id = p_operation_id;
  if found then
    if previous_operation.expected_revision <> p_expected_revision
      or previous_operation.snapshot <> p_snapshot then
      raise exception 'Sync operation already used with different data';
    end if;
    return jsonb_build_object('status', 'applied', 'revision', previous_operation.applied_revision);
  end if;

  if current_revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'revision', current_revision);
  end if;

  update public.business_data
  set data = p_snapshot, updated_at = clock_timestamp()
  where user_id = v_business_id
  returning sync_revision into current_revision;
  insert into public.offline_sync_operations
    (business_id, operation_id, expected_revision, applied_revision, snapshot)
  values (v_business_id, p_operation_id, p_expected_revision, current_revision, p_snapshot);
  return jsonb_build_object('status', 'applied', 'revision', current_revision);
end;
$$;

revoke all on function public.apply_offline_snapshot(uuid, jsonb, bigint) from public, anon, authenticated;
do $$
begin
  if pg_catalog.to_regprocedure('public.experimental_apply_owned_snapshot(text,uuid,jsonb,bigint)') is null then
    grant execute on function public.apply_offline_snapshot(uuid, jsonb, bigint) to authenticated;
  end if;
end;
$$;
