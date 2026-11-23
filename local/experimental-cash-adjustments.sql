-- Experimental observation checkpoints only. They do not finalize a cash session.
-- Requires experimental-presence.sql and experimental-payment-events.sql.
-- Do not apply to production.
create table if not exists public.experimental_cash_checkpoints (
  business_id uuid not null references auth.users (id) on delete cascade,
  checkpoint_id uuid not null,
  session_id text not null check (length(session_id) between 1 and 200),
  closed_at timestamptz not null,
  orders jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (business_id, checkpoint_id)
);

create table if not exists public.experimental_cash_adjustment_candidates (
  business_id uuid not null,
  checkpoint_id uuid not null,
  event_id bigint not null references public.experimental_payment_events (id) on delete cascade,
  primary key (business_id, checkpoint_id, event_id),
  foreign key (business_id, checkpoint_id)
    references public.experimental_cash_checkpoints (business_id, checkpoint_id) on delete cascade
);
create table if not exists public.experimental_cash_adjustment_decisions (
  sequence_id bigint generated always as identity primary key,
  business_id uuid not null,
  operation_id uuid not null,
  checkpoint_id uuid not null,
  event_id bigint not null,
  expected_decision_id uuid,
  classification text not null check (classification in ('this-session', 'other-session', 'unresolved')),
  notes text not null check (length(btrim(notes)) between 1 and 1000),
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (business_id, operation_id),
  foreign key (business_id, checkpoint_id, event_id)
    references public.experimental_cash_adjustment_candidates (business_id, checkpoint_id, event_id)
    on delete cascade
);
create index if not exists experimental_cash_decisions_head_idx
  on public.experimental_cash_adjustment_decisions (business_id, checkpoint_id, event_id, sequence_id desc)
  where result ->> 'status' = 'recorded';
alter table public.experimental_cash_checkpoints enable row level security;
alter table public.experimental_cash_adjustment_candidates enable row level security;
alter table public.experimental_cash_adjustment_decisions enable row level security;
revoke all on public.experimental_cash_checkpoints, public.experimental_cash_adjustment_candidates,
  public.experimental_cash_adjustment_decisions
  from public, anon, authenticated;

create or replace function public.experimental_record_cash_adjustment_candidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.experimental_cash_adjustment_candidates (business_id, checkpoint_id, event_id)
  select new.business_id, checkpoint_id, new.id
  from public.experimental_cash_checkpoints
  where business_id = new.business_id;
  return new;
end;
$$;
revoke all on function public.experimental_record_cash_adjustment_candidate() from public, anon, authenticated;
drop trigger if exists experimental_cash_adjustment_candidate on public.experimental_payment_events;
create trigger experimental_cash_adjustment_candidate
after insert on public.experimental_payment_events
for each row execute function public.experimental_record_cash_adjustment_candidate();

create or replace function public.experimental_create_cash_checkpoint(
  p_credential text, p_checkpoint_id uuid, p_session_id text, p_closed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := auth.uid();
  v_previous public.experimental_cash_checkpoints%rowtype;
  v_count bigint;
  v_orders jsonb;
begin
  if v_business_id is null then raise exception 'Authentication required'; end if;
  if p_credential is null or p_credential !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from public.offline_store_presence
    where business_id = v_business_id
      and credential_hash = pg_catalog.sha256(pg_catalog.convert_to(p_credential, 'UTF8'))
  ) then raise exception 'Invalid device credential'; end if;
  if p_checkpoint_id is null or p_session_id is null or length(btrim(p_session_id)) = 0
    or length(p_session_id) > 200 or p_closed_at is null or not isfinite(p_closed_at) then
    raise exception 'Invalid cash checkpoint input';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Cash checkpoint requires read committed isolation';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business_id::text, 846219));
  select * into v_previous from public.experimental_cash_checkpoints
  where business_id = v_business_id and checkpoint_id = p_checkpoint_id;
  if found then
    if v_previous.session_id <> p_session_id or v_previous.closed_at <> p_closed_at then
      raise exception 'Cash checkpoint already used with different data';
    end if;
    return pg_catalog.jsonb_build_object('checkpointId', p_checkpoint_id, 'orders', v_previous.orders);
  end if;
  if (select count(*) from public.experimental_cash_checkpoints where business_id = v_business_id) >= 100 then
    raise exception 'Too many experimental cash checkpoints';
  end if;
  select count(*), coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', id, 'paymentMethod', order_data ->> 'paymentMethod',
    'paymentStatus', payment_status, 'status', status, 'total', total,
    'createdAt', created_at, 'paidAt', paid_at
  ) order by id), '[]'::jsonb) into v_count, v_orders
  from (select id, order_data, payment_status, status, total, created_at, paid_at
    from public.online_orders where business_id = v_business_id order by id limit 10001) selected_orders;
  if v_count > 10000 then raise exception 'Too many orders for experimental cash checkpoint'; end if;
  insert into public.experimental_cash_checkpoints (business_id, checkpoint_id, session_id, closed_at, orders)
  values (v_business_id, p_checkpoint_id, p_session_id, p_closed_at, v_orders);
  return pg_catalog.jsonb_build_object('checkpointId', p_checkpoint_id, 'orders', v_orders);
end;
$$;

create or replace function public.experimental_cash_checkpoint_candidates(
  p_credential text, p_checkpoint_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := auth.uid();
  v_count bigint;
  v_events jsonb;
begin
  if v_business_id is null then raise exception 'Authentication required'; end if;
  if p_credential is null or p_credential !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from public.offline_store_presence
    where business_id = v_business_id
      and credential_hash = pg_catalog.sha256(pg_catalog.convert_to(p_credential, 'UTF8'))
  ) then raise exception 'Invalid device credential'; end if;
  if p_checkpoint_id is null or not exists (
    select 1 from public.experimental_cash_checkpoints
    where business_id = v_business_id and checkpoint_id = p_checkpoint_id
  ) then raise exception 'Cash checkpoint not found'; end if;
  select count(*), coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'eventId', id::text, 'orderId', order_id, 'operation', operation, 'before', before_payment,
    'after', after_payment, 'observedAt', observed_at, 'decision', decision
  ) order by id), '[]'::jsonb) into v_count, v_events
  from (
    select event.id, event.order_id, event.operation, event.before_payment, event.after_payment, event.observed_at,
      (select pg_catalog.jsonb_build_object('decisionId', d.operation_id, 'classification', d.classification,
        'notes', d.notes, 'recordedAt', d.created_at)
       from public.experimental_cash_adjustment_decisions d
       where d.business_id = candidate.business_id and d.checkpoint_id = candidate.checkpoint_id
         and d.event_id = candidate.event_id and d.result ->> 'status' = 'recorded'
       order by d.sequence_id desc limit 1) as decision
    from public.experimental_cash_adjustment_candidates candidate
    join public.experimental_payment_events event on event.id = candidate.event_id
    where candidate.business_id = v_business_id and candidate.checkpoint_id = p_checkpoint_id
    order by event.id limit 10001
  ) selected_events;
  if v_count > 10000 then raise exception 'Too many cash adjustment candidates'; end if;
  return pg_catalog.jsonb_build_object('events', v_events);
end;
$$;

create or replace function public.experimental_decide_cash_adjustment(
  p_credential text, p_checkpoint_id uuid, p_event_id text, p_operation_id uuid,
  p_expected_decision_id uuid, p_classification text, p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := auth.uid();
  v_event_id bigint;
  v_previous public.experimental_cash_adjustment_decisions%rowtype;
  v_head uuid;
  v_result jsonb;
begin
  if v_business_id is null then raise exception 'Authentication required'; end if;
  if p_credential is null or p_credential !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from public.offline_store_presence
    where business_id = v_business_id
      and credential_hash = pg_catalog.sha256(pg_catalog.convert_to(p_credential, 'UTF8'))
  ) then raise exception 'Invalid device credential'; end if;
  if p_checkpoint_id is null or p_operation_id is null or p_event_id is null
    or p_event_id !~ '^[1-9][0-9]{0,18}$'
    or p_classification is null or p_classification not in ('this-session', 'other-session', 'unresolved')
    or p_notes is null or length(btrim(p_notes)) not between 1 and 1000
    or p_notes <> btrim(p_notes) then
    raise exception 'Invalid cash adjustment decision';
  end if;
  if p_event_id::numeric > 9223372036854775807 then raise exception 'Invalid cash adjustment decision'; end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Cash decision requires read committed isolation';
  end if;
  v_event_id := p_event_id::bigint;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business_id::text, 846219));
  select * into v_previous from public.experimental_cash_adjustment_decisions
  where business_id = v_business_id and operation_id = p_operation_id;
  if found then
    if v_previous.checkpoint_id <> p_checkpoint_id or v_previous.event_id <> v_event_id
      or v_previous.expected_decision_id is distinct from p_expected_decision_id
      or v_previous.classification <> p_classification or v_previous.notes <> p_notes then
      raise exception 'Cash decision operation already used with different data';
    end if;
    return v_previous.result;
  end if;
  if not exists (select 1 from public.experimental_cash_adjustment_candidates
    where business_id = v_business_id and checkpoint_id = p_checkpoint_id and event_id = v_event_id) then
    raise exception 'Cash adjustment candidate not found';
  end if;
  select operation_id into v_head from public.experimental_cash_adjustment_decisions
  where business_id = v_business_id and checkpoint_id = p_checkpoint_id and event_id = v_event_id
    and result ->> 'status' = 'recorded'
  order by sequence_id desc limit 1;
  v_result := pg_catalog.jsonb_build_object(
    'status', case when v_head is not distinct from p_expected_decision_id then 'recorded' else 'conflict' end,
    'operationId', p_operation_id, 'eventId', p_event_id);
  insert into public.experimental_cash_adjustment_decisions
    (business_id, operation_id, checkpoint_id, event_id, expected_decision_id, classification, notes, result)
  values (v_business_id, p_operation_id, p_checkpoint_id, v_event_id, p_expected_decision_id, p_classification, p_notes, v_result);
  return v_result;
end;
$$;

revoke all on function public.experimental_create_cash_checkpoint(text, uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.experimental_cash_checkpoint_candidates(text, uuid)
  from public, anon, authenticated;
grant execute on function public.experimental_create_cash_checkpoint(text, uuid, text, timestamptz) to authenticated;
grant execute on function public.experimental_cash_checkpoint_candidates(text, uuid) to authenticated;
revoke all on function public.experimental_decide_cash_adjustment(text, uuid, text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.experimental_decide_cash_adjustment(text, uuid, text, uuid, uuid, text, text) to authenticated;
