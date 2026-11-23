-- Experimental only. Requires experimental-sync.sql and experimental-presence.sql.
-- A quote is not a close and must not be used to authorize one by itself.
-- Do not apply to production.
create table if not exists public.experimental_online_cash_quotes (
  business_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  expected_revision bigint not null check (expected_revision >= 0),
  session_id text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (business_id, operation_id)
);
alter table public.experimental_online_cash_quotes enable row level security;
revoke all on public.experimental_online_cash_quotes from public, anon, authenticated;

create or replace function public.experimental_quote_online_cash_close(
  p_credential text, p_operation_id uuid, p_session_id text, p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := auth.uid();
  v_previous public.experimental_online_cash_quotes%rowtype;
  v_snapshot jsonb;
  v_revision bigint;
  v_count bigint;
  v_orders jsonb;
  v_result jsonb;
  v_now timestamptz;
begin
  if v_business_id is null then raise exception 'Authentication required'; end if;
  if p_credential is null or p_credential !~ '^[0-9a-f]{64}$'
    or p_operation_id is null or p_session_id is null or length(btrim(p_session_id)) = 0
    or length(p_session_id) > 200 or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid online cash quote input';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Online cash quote requires read committed isolation';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business_id::text, 512483));
  if not exists (select 1 from public.offline_store_presence
    where business_id = v_business_id
      and credential_hash = pg_catalog.sha256(pg_catalog.convert_to(p_credential, 'UTF8'))) then
    raise exception 'Invalid device credential';
  end if;
  select * into v_previous from public.experimental_online_cash_quotes
  where business_id = v_business_id and operation_id = p_operation_id;
  if found then
    if v_previous.expected_revision <> p_expected_revision or v_previous.session_id <> p_session_id then
      raise exception 'Cash quote operation already used with different data';
    end if;
    return v_previous.result;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business_id::text, 846219));
  select data, sync_revision into v_snapshot, v_revision
  from public.business_data where user_id = v_business_id for share;
  if not found then raise exception 'Business data not found'; end if;
  if v_revision <> p_expected_revision then
    v_result := pg_catalog.jsonb_build_object('status', 'conflict', 'operationId', p_operation_id, 'revision', v_revision);
  elsif coalesce(pg_catalog.jsonb_typeof(v_snapshot -> 'cashSessions'), '') <> 'array' then
    raise exception 'Invalid cash sessions';
  elsif (select count(*) from pg_catalog.jsonb_array_elements(v_snapshot -> 'cashSessions') s
      where coalesce(s ->> 'closedAt', '') = '') <> 1
    or (select count(*) from pg_catalog.jsonb_array_elements(v_snapshot -> 'cashSessions') s
      where s ->> 'id' = p_session_id and coalesce(s ->> 'closedAt', '') = '') <> 1
    or (select count(*) from pg_catalog.jsonb_array_elements(v_snapshot -> 'cashSessions') s
      where s ->> 'id' = p_session_id) <> 1
    or exists (select 1 from pg_catalog.jsonb_array_elements(v_snapshot -> 'cashSessions') s
      where s ->> 'offlineClosureStatus' = 'provisional') then
    v_result := pg_catalog.jsonb_build_object('status', 'invalid-session', 'operationId', p_operation_id, 'revision', v_revision);
  else
    select count(*), coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', id::text, 'paymentMethod', order_data ->> 'paymentMethod',
      'paymentStatus', payment_status, 'status', status, 'total', total,
      'createdAt', created_at, 'paidAt', paid_at,
      'paymentIdHash', case when payment_id is null then null
        else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payment_id::text, 'UTF8')), 'hex') end
    ) order by id), '[]'::jsonb) into v_count, v_orders
    from (select id, order_data, payment_status, status, total, created_at, paid_at, payment_id
      from public.online_orders where business_id = v_business_id order by id limit 10001) orders;
    if v_count > 10000 then raise exception 'Too many orders for online cash quote'; end if;
    v_now := pg_catalog.clock_timestamp();
    v_result := pg_catalog.jsonb_build_object('status', 'ready', 'operationId', p_operation_id,
      'sessionId', p_session_id, 'revision', v_revision, 'quotedAt', v_now,
      'snapshot', v_snapshot, 'orders', v_orders);
  end if;
  insert into public.experimental_online_cash_quotes
    (business_id, operation_id, expected_revision, session_id, result)
  values (v_business_id, p_operation_id, p_expected_revision, p_session_id, v_result);
  return v_result;
end;
$$;

revoke all on function public.experimental_quote_online_cash_close(text, uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.experimental_quote_online_cash_close(text, uuid, text, bigint) to authenticated;
