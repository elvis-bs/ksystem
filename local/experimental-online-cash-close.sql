-- Experimental only. Requires experimental-sync.sql, experimental-presence.sql,
-- experimental-payment-events.sql, experimental-cash-adjustments.sql and
-- experimental-online-cash-quote.sql. Do not apply to production.
create table if not exists public.experimental_online_cash_closes (
  business_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  session_id text not null,
  expected_revision bigint not null,
  counted numeric not null,
  notes text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (business_id, operation_id)
);
alter table public.experimental_online_cash_closes enable row level security;
revoke all on public.experimental_online_cash_closes from public, anon, authenticated;

create or replace function public.experimental_cash_money(p_value jsonb)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v_text text; v_amount numeric;
begin
  if pg_catalog.jsonb_typeof(p_value) not in ('number', 'string') then
    raise exception 'Invalid cash amount';
  end if;
  v_text := p_value #>> '{}';
  if v_text is null or v_text !~ '^[0-9]+([.][0-9]+)?$' then raise exception 'Invalid cash amount'; end if;
  v_amount := v_text::numeric;
  if v_amount > 90071992547409.91 or v_amount <> pg_catalog.round(v_amount, 2) then
    raise exception 'Invalid cash amount';
  end if;
  return v_amount;
end;
$$;

create or replace function public.experimental_cash_session_for_receipt(
  p_sessions jsonb, p_session_id text, p_date text, p_close_id text, p_closed_at timestamptz
)
returns text language plpgsql stable set search_path = '' as $$
declare v_session jsonb; v_found text; v_count integer := 0; v_at timestamptz;
  v_open timestamptz; v_close timestamptz;
begin
  if p_session_id is not null and p_session_id <> '' then
    select count(*) into v_count from pg_catalog.jsonb_array_elements(p_sessions) s where s ->> 'id' = p_session_id;
    if v_count <> 1 then raise exception 'Unknown or duplicate cash session'; end if;
    return p_session_id;
  end if;
  if p_date is null or p_date = '' then raise exception 'Missing receipt date'; end if;
  v_at := p_date::timestamptz;
  if not pg_catalog.isfinite(v_at) or v_at > p_closed_at then raise exception 'Invalid receipt date'; end if;
  for v_session in select value from pg_catalog.jsonb_array_elements(p_sessions) loop
    v_open := (v_session ->> 'openedAt')::timestamptz;
    v_close := case when v_session ->> 'id' = p_close_id then p_closed_at
      else (v_session ->> 'closedAt')::timestamptz end;
    if v_open is null or v_close is null or not pg_catalog.isfinite(v_open)
      or not pg_catalog.isfinite(v_close) or v_close < v_open then raise exception 'Invalid cash session dates'; end if;
    if v_at between v_open and v_close then
      v_found := v_session ->> 'id';
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count <> 1 then raise exception 'Unassigned or ambiguous receipt'; end if;
  return v_found;
end;
$$;

create or replace function public.experimental_cash_add_receipt(p_totals jsonb, p_method text, p_amount numeric)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_method text; v_total numeric;
begin
  if p_method is null or length(btrim(p_method)) = 0 or length(p_method) > 200 then
    raise exception 'Invalid payment method';
  end if;
  v_method := case when p_method = 'Pix online' then 'Pix'
    when p_method in ('Dinheiro na entrega', 'Dinheiro na retirada') then 'Dinheiro' else p_method end;
  v_total := coalesce((p_totals ->> v_method)::numeric, 0) + p_amount;
  if v_total > 90071992547409.91 then raise exception 'Cash total too large'; end if;
  return pg_catalog.jsonb_set(p_totals, array[v_method], pg_catalog.to_jsonb(v_total), true);
end;
$$;

revoke all on function public.experimental_cash_money(jsonb),
  public.experimental_cash_session_for_receipt(jsonb,text,text,text,timestamptz),
  public.experimental_cash_add_receipt(jsonb,text,numeric) from public, anon, authenticated;

create or replace function public.experimental_close_online_cash(
  p_credential text, p_operation_id uuid, p_session_id text, p_expected_revision bigint,
  p_counted numeric, p_notes text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_business uuid := auth.uid();
  v_previous public.experimental_online_cash_closes%rowtype;
  v_quote public.experimental_online_cash_quotes%rowtype;
  v_snapshot jsonb; v_sessions jsonb; v_session jsonb; v_orders jsonb; v_order jsonb;
  v_sale jsonb; v_entry jsonb; v_payment jsonb; v_movement jsonb; v_manual jsonb;
  v_revision bigint; v_count bigint; v_close timestamptz; v_index integer;
  v_totals jsonb := '{}'::jsonb; v_methods jsonb; v_received numeric; v_expected numeric;
  v_movement_total numeric := 0; v_amount numeric; v_session_id text; v_result jsonb;
begin
  if v_business is null then raise exception 'Authentication required'; end if;
  if p_credential is null or p_credential !~ '^[0-9a-f]{64}$' or p_operation_id is null
    or p_session_id is null or length(btrim(p_session_id)) = 0 or length(p_session_id) > 200
    or p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991 or p_counted is null
    or p_counted::text = 'NaN' or p_counted < 0 or p_counted > 90071992547409.91
    or p_counted <> pg_catalog.round(p_counted, 2) or p_notes is null
    or p_notes <> btrim(p_notes) or length(p_notes) > 1000 then raise exception 'Invalid online cash close input'; end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Online cash close requires read committed isolation';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business::text, 512483));
  if not exists (select 1 from public.offline_store_presence
    where business_id = v_business and credential_hash = pg_catalog.sha256(pg_catalog.convert_to(p_credential, 'UTF8'))) then
    raise exception 'Invalid device credential';
  end if;
  select * into v_previous from public.experimental_online_cash_closes
    where business_id = v_business and operation_id = p_operation_id;
  if found then
    if v_previous.session_id <> p_session_id or v_previous.expected_revision <> p_expected_revision
      or v_previous.counted <> p_counted or v_previous.notes <> p_notes then
      raise exception 'Cash close operation already used with different data';
    end if;
    return v_previous.result;
  end if;
  select * into v_quote from public.experimental_online_cash_quotes
    where business_id = v_business and operation_id = p_operation_id;
  if not found or v_quote.session_id <> p_session_id or v_quote.expected_revision <> p_expected_revision
    or v_quote.result ->> 'status' <> 'ready' then raise exception 'Matching ready cash quote required'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business::text, 846219));
  select data, sync_revision into v_snapshot, v_revision from public.business_data
    where user_id = v_business for update;
  if not found then raise exception 'Business data not found'; end if;
  if v_revision <> p_expected_revision or v_snapshot is distinct from v_quote.result -> 'snapshot' then
    v_result := pg_catalog.jsonb_build_object('status', 'conflict', 'reason', 'snapshot-changed',
      'operationId', p_operation_id, 'revision', v_revision);
  else
    select count(*), coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', id::text, 'paymentMethod', order_data ->> 'paymentMethod', 'paymentStatus', payment_status,
      'status', status, 'total', total, 'createdAt', created_at, 'paidAt', paid_at,
      'paymentIdHash', case when payment_id is null then null
        else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payment_id::text, 'UTF8')), 'hex') end
    ) order by id), '[]'::jsonb) into v_count, v_orders
    from (select id, order_data, payment_status, status, total, created_at, paid_at, payment_id
      from public.online_orders where business_id = v_business order by id limit 10001) orders;
    if v_count > 10000 then raise exception 'Too many orders for online cash close'; end if;
    if v_orders is distinct from v_quote.result -> 'orders' then
      v_result := pg_catalog.jsonb_build_object('status', 'conflict', 'reason', 'payments-changed',
        'operationId', p_operation_id, 'revision', v_revision);
    end if;
  end if;
  if v_result is not null then
    insert into public.experimental_online_cash_closes
      (business_id, operation_id, session_id, expected_revision, counted, notes, result)
    values (v_business, p_operation_id, p_session_id, p_expected_revision, p_counted, p_notes, v_result);
    return v_result;
  end if;

  if coalesce(pg_catalog.jsonb_typeof(v_snapshot -> 'sales'), '') <> 'array'
    or coalesce(pg_catalog.jsonb_typeof(v_snapshot -> 'financeEntries'), '') <> 'array'
    or coalesce(pg_catalog.jsonb_typeof(v_snapshot -> 'onlineOrderPayments'), '') <> 'array'
    or coalesce(pg_catalog.jsonb_typeof(v_snapshot -> 'cashSessions'), '') <> 'array' then
    raise exception 'Incomplete cash data';
  end if;
  v_sessions := v_snapshot -> 'cashSessions';
  select value, (ordinality - 1)::integer into v_session, v_index
    from pg_catalog.jsonb_array_elements(v_sessions) with ordinality
    where value ->> 'id' = p_session_id;
  if (select count(*) from pg_catalog.jsonb_array_elements(v_sessions) s
      where s ->> 'id' = p_session_id) <> 1
    or (select count(*) from pg_catalog.jsonb_array_elements(v_sessions) s
      where coalesce(s ->> 'closedAt', '') = '') <> 1
    or coalesce(v_session ->> 'closedAt', '') <> ''
    or exists (select 1 from pg_catalog.jsonb_array_elements(v_sessions) s
      where s ->> 'offlineClosureStatus' = 'provisional')
    or v_session ?| array['closedAt','expectedCash','countedCash','difference','receivedTotalAtClose','receivedByMethodAtClose','closeNotes'] then
    raise exception 'Invalid open cash session';
  end if;
  v_close := pg_catalog.clock_timestamp();
  if (v_session ->> 'openedAt')::timestamptz > v_close
    or (v_session ->> 'openedAt')::timestamptz is null
    or not pg_catalog.isfinite((v_session ->> 'openedAt')::timestamptz) then raise exception 'Invalid cash opening date'; end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(v_sessions) s group by s ->> 'id'
    having s ->> 'id' is null or s ->> 'id' = '' or count(*) > 1) then raise exception 'Invalid cash session IDs'; end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(v_snapshot -> 'sales') s group by s ->> 'id'
    having s ->> 'id' is null or s ->> 'id' = '' or count(*) > 1) then raise exception 'Invalid sales IDs'; end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(v_snapshot -> 'onlineOrderPayments') p
    group by p ->> 'onlineOrderId' having p ->> 'onlineOrderId' is null or p ->> 'onlineOrderId' = '' or count(*) > 1)
    then raise exception 'Invalid online payment IDs'; end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(v_snapshot -> 'financeEntries') e
    where e ->> 'kind' = 'receivable' and coalesce(e ->> 'saleId', '') <> ''
    group by e ->> 'saleId' having count(*) > 1) then raise exception 'Duplicate sale receivable'; end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(v_snapshot -> 'financeEntries') e
    cross join lateral pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(e -> 'payments') = 'array' then e -> 'payments' else '[]'::jsonb end) p
    where e ->> 'kind' = 'receivable' and coalesce(p ->> 'id', '') <> ''
    group by p ->> 'id' having count(*) > 1
  ) then raise exception 'Duplicate receivable payment'; end if;

  for v_sale in select value from pg_catalog.jsonb_array_elements(v_snapshot -> 'sales') loop
    if v_sale ? 'paid' and pg_catalog.jsonb_typeof(v_sale -> 'paid') <> 'boolean' then
      raise exception 'Invalid sale payment status';
    end if;
    if v_sale ->> 'paid' = 'true' and not exists (
      select 1 from pg_catalog.jsonb_array_elements(v_snapshot -> 'financeEntries') e
      where e ->> 'kind' = 'receivable' and e ->> 'saleId' = v_sale ->> 'id') then
      v_session_id := public.experimental_cash_session_for_receipt(v_sessions, v_sale ->> 'cashSessionId',
        coalesce(nullif(v_sale ->> 'paidAt',''), v_sale ->> 'createdAt'), p_session_id, v_close);
      if v_session_id = p_session_id then
        v_totals := public.experimental_cash_add_receipt(v_totals, coalesce(nullif(v_sale ->> 'payment',''), 'A combinar'),
          public.experimental_cash_money(v_sale -> 'total'));
      end if;
    end if;
  end loop;
  for v_entry in select value from pg_catalog.jsonb_array_elements(v_snapshot -> 'financeEntries') loop
    if coalesce(v_entry ->> 'kind', '') not in ('receivable', 'payable', 'expense') then
      raise exception 'Invalid finance entry';
    end if;
    if v_entry ->> 'kind' <> 'receivable' then continue; end if;
    if v_entry ? 'payments' and pg_catalog.jsonb_typeof(v_entry -> 'payments') <> 'array' then
      raise exception 'Invalid receivable payments';
    end if;
    for v_payment in select value from pg_catalog.jsonb_array_elements(coalesce(v_entry -> 'payments', '[]'::jsonb)) loop
      if coalesce(v_payment ->> 'cashSessionId','') = '' and coalesce(v_entry ->> 'saleId','') = '' then continue; end if;
      v_session_id := public.experimental_cash_session_for_receipt(v_sessions, v_payment ->> 'cashSessionId',
        v_payment ->> 'date', p_session_id, v_close);
      if v_session_id = p_session_id then
        v_totals := public.experimental_cash_add_receipt(v_totals, coalesce(nullif(v_payment ->> 'method',''), 'A combinar'),
          public.experimental_cash_money(v_payment -> 'amount'));
      end if;
    end loop;
  end loop;
  for v_payment in select value from pg_catalog.jsonb_array_elements(v_snapshot -> 'onlineOrderPayments') loop
    if not exists (select 1 from pg_catalog.jsonb_array_elements(v_orders) o where o ->> 'id' = v_payment ->> 'onlineOrderId') then
      raise exception 'Online payment has no matching order';
    end if;
  end loop;
  for v_order in select value from pg_catalog.jsonb_array_elements(v_orders) loop
    if coalesce(v_order ->> 'paymentMethod','') not in ('pix','cash_on_delivery','cash_on_pickup','card_on_delivery','card_on_pickup')
      or coalesce(v_order ->> 'paymentStatus','') not in ('pending','approved','rejected','cancelled','refunded','failed') then
      raise exception 'Invalid online order payment';
    end if;
    if v_order ->> 'paymentMethod' = 'pix' and v_order ->> 'paymentStatus' = 'pending' then
      raise exception 'Pending Pix requires review';
    end if;
    if v_order ->> 'paymentStatus' = 'refunded' then raise exception 'Refund requires review'; end if;
    select value into v_manual from pg_catalog.jsonb_array_elements(v_snapshot -> 'onlineOrderPayments')
      where value ->> 'onlineOrderId' = v_order ->> 'id';
    if v_manual is not null and v_order ->> 'paymentMethod' = 'pix' and v_order ->> 'paymentStatus' = 'approved' then
      raise exception 'Duplicate Pix and manual payment';
    end if;
    if v_manual is null and not (v_order ->> 'paymentMethod' = 'pix' and v_order ->> 'paymentStatus' = 'approved') then
      continue;
    end if;
    if exists (select 1 from pg_catalog.jsonb_array_elements(v_snapshot -> 'sales') s
      where s ->> 'id' = 'online-' || (v_order ->> 'id'))
      or exists (select 1 from pg_catalog.jsonb_array_elements(v_snapshot -> 'financeEntries') e
        where e ->> 'kind' = 'receivable' and e ->> 'saleId' = 'online-' || (v_order ->> 'id')) then
      raise exception 'Ambiguous online order receipt';
    end if;
    v_session_id := public.experimental_cash_session_for_receipt(v_sessions, v_manual ->> 'cashSessionId',
      coalesce(nullif(v_manual ->> 'paidAt',''), v_order ->> 'paidAt'), p_session_id, v_close);
    if v_session_id = p_session_id then
      v_totals := public.experimental_cash_add_receipt(v_totals,
        case when v_manual is null then 'Pix' else v_manual ->> 'method' end,
        public.experimental_cash_money(v_order -> 'total'));
    end if;
  end loop;
  if v_session ? 'cashMovements' and pg_catalog.jsonb_typeof(v_session -> 'cashMovements') <> 'array' then
    raise exception 'Invalid cash movements';
  end if;
  for v_movement in select value from pg_catalog.jsonb_array_elements(coalesce(v_session -> 'cashMovements', '[]'::jsonb)) loop
    if v_movement ->> 'type' not in ('addition','withdrawal') or v_movement ->> 'type' is null then
      raise exception 'Invalid cash movement';
    end if;
    v_amount := public.experimental_cash_money(v_movement -> 'amount');
    v_movement_total := v_movement_total + case when v_movement ->> 'type' = 'addition' then v_amount else -v_amount end;
  end loop;
  select coalesce(sum(value::numeric), 0),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('payment', key, 'amount', value::numeric) order by key), '[]'::jsonb)
    into v_received, v_methods from pg_catalog.jsonb_each_text(v_totals);
  v_expected := public.experimental_cash_money(v_session -> 'openingAmount') + v_received + v_movement_total;
  if abs(v_expected) > 90071992547409.91 or v_received > 90071992547409.91
    or abs(p_counted - v_expected) > 90071992547409.91 then raise exception 'Cash total too large'; end if;
  v_session := v_session || pg_catalog.jsonb_build_object('closedAt', v_close,
    'expectedCash', v_expected, 'countedCash', p_counted, 'difference', p_counted - v_expected,
    'receivedTotalAtClose', v_received, 'receivedByMethodAtClose', v_methods, 'closeNotes', p_notes);
  v_snapshot := pg_catalog.jsonb_set(v_snapshot, array['cashSessions', v_index::text], v_session);
  if (select count(*) from public.experimental_cash_checkpoints where business_id = v_business) >= 100 then
    raise exception 'Too many experimental cash checkpoints';
  end if;
  insert into public.experimental_cash_checkpoints (business_id, checkpoint_id, session_id, closed_at, orders)
  values (v_business, p_operation_id, p_session_id, v_close, v_orders);
  update public.business_data set data = v_snapshot, updated_at = v_close
    where user_id = v_business returning sync_revision into v_revision;
  v_result := pg_catalog.jsonb_build_object('status', 'closed', 'operationId', p_operation_id,
    'sessionId', p_session_id, 'revision', v_revision, 'snapshot', v_snapshot);
  insert into public.experimental_online_cash_closes
    (business_id, operation_id, session_id, expected_revision, counted, notes, result)
  values (v_business, p_operation_id, p_session_id, p_expected_revision, p_counted, p_notes, v_result);
  return v_result;
end;
$$;
revoke all on function public.experimental_close_online_cash(text,uuid,text,bigint,numeric,text)
  from public, anon, authenticated;
grant execute on function public.experimental_close_online_cash(text,uuid,text,bigint,numeric,text) to authenticated;
