insert into auth.users values ('77777777-7777-7777-7777-777777777777'),
  ('88888888-8888-8888-8888-888888888888');
insert into public.business_data (user_id, data)
values ('77777777-7777-7777-7777-777777777777',
  '{"products":[],"ingredients":[],"sales":[],"cashSessions":[{"id":"cash","openedAt":"2026-01-01T10:00:00Z"}]}'),
  ('88888888-8888-8888-8888-888888888888',
  '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}');
insert into public.online_orders (business_id, order_data, payment_id, total)
values ('77777777-7777-7777-7777-777777777777',
  '{"paymentMethod":"pix","customerEmail":"private@example.test"}', 'private-payment-id', 10),
  ('88888888-8888-8888-8888-888888888888', '{"paymentMethod":"pix"}', null, 10);

set role authenticated;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', false);
select public.experimental_enable_store_presence(repeat('e',64));
do $$
declare q jsonb; replay jsonb; conflict jsonb;
begin
  q := public.experimental_quote_online_cash_close(repeat('e',64),
    '77777777-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cash', 0);
  if q ->> 'status' <> 'ready' or q ->> 'sessionId' <> 'cash'
    or (q ->> 'revision')::int <> 0 or jsonb_array_length(q -> 'orders') <> 1
    or q::text like '%private@example.test%' or q::text like '%private-payment-id%'
    or length(q -> 'orders' -> 0 ->> 'paymentIdHash') <> 64
    or q -> 'snapshot' -> 'cashSessions' -> 0 ->> 'id' <> 'cash' then
    raise exception 'Incorrect quote: %', q;
  end if;
  replay := public.experimental_quote_online_cash_close(repeat('e',64),
    '77777777-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cash', 0);
  if replay is distinct from q then raise exception 'Quote retry changed'; end if;
  begin
    perform public.experimental_quote_online_cash_close(repeat('e',64),
      '77777777-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'other', 0);
    raise exception 'Changed quote accepted';
  exception when raise_exception then
    if sqlerrm <> 'Cash quote operation already used with different data' then raise; end if;
  end;
  conflict := public.experimental_quote_online_cash_close(repeat('e',64),
    '77777777-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cash', 1);
  if conflict ->> 'status' <> 'conflict' then raise exception 'Revision conflict missing'; end if;
  if public.experimental_quote_online_cash_close(repeat('e',64),
    '77777777-cccc-cccc-cccc-cccccccccccc', 'other', 0) ->> 'status' <> 'invalid-session' then
    raise exception 'Invalid session accepted';
  end if;
  begin
    perform * from public.experimental_online_cash_quotes;
    raise exception 'Quote table exposed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.experimental_quote_online_cash_close(repeat('f',64), gen_random_uuid(), 'cash', 0);
    raise exception 'Wrong credential accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
end $$;
reset role;
update public.online_orders set payment_status = 'approved', paid_at = '2026-01-01T11:00:00Z'
where business_id = '77777777-7777-7777-7777-777777777777';
update public.business_data set data = jsonb_set(data, '{extra}', '"changed"')
where user_id = '77777777-7777-7777-7777-777777777777';
set role authenticated;
do $$
declare q jsonb;
begin
  q := public.experimental_quote_online_cash_close(repeat('e',64),
    '77777777-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cash', 0);
  if q -> 'orders' -> 0 ->> 'paymentStatus' <> 'pending'
    or q -> 'snapshot' ? 'extra' then raise exception 'Quote changed after capture'; end if;
  q := public.experimental_quote_online_cash_close(repeat('e',64),
    '77777777-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cash', 1);
  if q ->> 'status' <> 'conflict' then raise exception 'Conflict did not survive retry'; end if;
  q := public.experimental_quote_online_cash_close(repeat('e',64),
    '77777777-dddd-dddd-dddd-dddddddddddd', 'cash', 1);
  if q ->> 'status' <> 'ready' or q -> 'orders' -> 0 ->> 'paymentStatus' <> 'approved'
    or q -> 'snapshot' ->> 'extra' <> 'changed' then raise exception 'Fresh quote incorrect'; end if;
end $$;
begin isolation level repeatable read;
do $$
begin
  begin
    perform public.experimental_quote_online_cash_close(repeat('e',64), gen_random_uuid(), 'cash', 1);
    raise exception 'Repeatable read accepted';
  exception when raise_exception then
    if sqlerrm <> 'Online cash quote requires read committed isolation' then raise; end if;
  end;
end $$;
rollback;
reset role;
set role anon;
do $$
begin
  begin
    perform public.experimental_quote_online_cash_close(repeat('e',64), gen_random_uuid(), 'cash', 1);
    raise exception 'Anonymous quote accepted';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
