insert into auth.users values ('44444444-4444-4444-4444-444444444444'),
  ('55555555-5555-5555-5555-555555555555');
insert into public.business_data (user_id, data) values
('44444444-4444-4444-4444-444444444444',
  '{"products":[],"ingredients":[],"sales":[
    {"id":"sale","paid":true,"payment":"Dinheiro","total":25,"cashSessionId":"cash"},
    {"id":"credit","paid":true,"payment":"Crediário","total":50,"cashSessionId":"cash"}],
    "financeEntries":[{"kind":"receivable","saleId":"credit","payments":[{"amount":20,"method":"Pix","cashSessionId":"cash"}]},
      {"kind":"receivable","payments":[{"amount":7,"method":"Dinheiro","cashSessionId":"cash"}]}],
    "onlineOrderPayments":[{"onlineOrderId":"cccccccc-cccc-cccc-cccc-cccccccccccc","method":"Cartão de crédito","cashSessionId":"cash"}],
    "cashSessions":[{"id":"cash","openedAt":"2026-01-01T10:00:00Z","openingAmount":10,
      "cashMovements":[{"type":"addition","amount":5},{"type":"withdrawal","amount":3}]}]}'),
('55555555-5555-5555-5555-555555555555',
  '{"products":[],"ingredients":[],"sales":[],"financeEntries":[],"onlineOrderPayments":[],
    "cashSessions":[{"id":"cash","openedAt":"2026-01-01T10:00:00Z","openingAmount":0}]}');
insert into public.online_orders (id,business_id,order_data,total,payment_status,paid_at,payment_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','44444444-4444-4444-4444-444444444444',
  '{"paymentMethod":"pix"}', 12.50, 'approved', '2026-01-01T11:00:00Z', 'provider-id'),
('cccccccc-cccc-cccc-cccc-cccccccccccc','44444444-4444-4444-4444-444444444444',
  '{"paymentMethod":"card_on_delivery"}', 8, 'pending', null, null),
('dddddddd-dddd-dddd-dddd-dddddddddddd','55555555-5555-5555-5555-555555555555',
  '{"paymentMethod":"pix"}', 1, 'pending', null, null);
set role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',false);
select public.experimental_enable_store_presence(repeat('a',64));
do $$
declare q jsonb; r jsonb; replay jsonb; session jsonb;
begin
  q := public.experimental_quote_online_cash_close(repeat('a',64),
    '44444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0);
  if q ->> 'status' <> 'ready' then raise exception 'Missing quote'; end if;
  begin
    perform public.experimental_close_online_cash(repeat('a',64),
      '44444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb','cash',0,100,'Conferido');
    raise exception 'Close without quote accepted';
  exception when raise_exception then if sqlerrm <> 'Matching ready cash quote required' then raise; end if;
  end;
  r := public.experimental_close_online_cash(repeat('a',64),
    '44444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,100,'Conferido');
  session := r -> 'snapshot' -> 'cashSessions' -> 0;
  if r ->> 'status' <> 'closed' or (r ->> 'revision')::int <> 1
    or (session ->> 'receivedTotalAtClose')::numeric <> 72.50
    or (session ->> 'expectedCash')::numeric <> 84.50
    or (session ->> 'difference')::numeric <> 15.50
    or session ->> 'closeNotes' <> 'Conferido'
    or not (session -> 'receivedByMethodAtClose' @> '[{"payment":"Dinheiro","amount":32},{"payment":"Pix","amount":32.50},{"payment":"Cartão de crédito","amount":8}]'::jsonb) then
    raise exception 'Incorrect close: %', r;
  end if;
  replay := public.experimental_close_online_cash(repeat('a',64),
    '44444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,100,'Conferido');
  if replay is distinct from r then raise exception 'Close replay changed'; end if;
  begin
    perform public.experimental_close_online_cash(repeat('a',64),
      '44444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,101,'Conferido');
    raise exception 'Different replay accepted';
  exception when raise_exception then if sqlerrm <> 'Cash close operation already used with different data' then raise; end if;
  end;
  begin
    perform public.experimental_close_online_cash(repeat('b',64),
      '44444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,100,'Conferido');
    raise exception 'Wrong credential accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
  begin
    perform * from public.experimental_online_cash_closes;
    raise exception 'Close table exposed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set role anon;
do $$ begin
  begin
    perform public.experimental_close_online_cash(repeat('a',64), gen_random_uuid(), 'cash', 0, 0, '');
    raise exception 'Anonymous close accepted';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

insert into auth.users values ('33333333-3333-3333-3333-333333333333');
insert into public.business_data (user_id,data) values ('33333333-3333-3333-3333-333333333333',
  '{"products":[],"ingredients":[],"sales":[{"id":"credit","paid":false}],
    "financeEntries":[{"kind":"receivable","saleId":"credit"},{"kind":"receivable","saleId":"credit"}],
    "onlineOrderPayments":[],"cashSessions":[{"id":"cash","openedAt":"2026-01-01T10:00:00Z","openingAmount":0}]}');
set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false);
select public.experimental_enable_store_presence(repeat('c',64));
select public.experimental_quote_online_cash_close(repeat('c',64),
  '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0);
do $$ begin
  begin
    perform public.experimental_close_online_cash(repeat('c',64),
      '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,0,'');
    raise exception 'Duplicate receivables accepted';
  exception when raise_exception then if sqlerrm <> 'Duplicate sale receivable' then raise; end if;
  end;
end $$;
reset role;
update public.business_data set data = jsonb_set(data, '{financeEntries}', '[]')
where user_id = '33333333-3333-3333-3333-333333333333';
set role authenticated;
do $$
declare r jsonb;
begin
  r := public.experimental_close_online_cash(repeat('c',64),
    '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,0,'');
  if r ->> 'status' <> 'conflict' or r ->> 'reason' <> 'snapshot-changed' or (r ->> 'revision')::int <> 1 then
    raise exception 'Snapshot conflict not detected: %', r;
  end if;
end $$;
reset role;
update public.online_orders set payment_status = 'refunded'
where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
do $$ begin
  if (select count(*) from public.experimental_cash_adjustment_candidates
    where business_id = '44444444-4444-4444-4444-444444444444'
      and checkpoint_id = '44444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa') <> 1 then
    raise exception 'Late payment change was not captured';
  end if;
  if (select data -> 'cashSessions' -> 0 ->> 'expectedCash' from public.business_data
      where user_id = '44444444-4444-4444-4444-444444444444') <> '84.50' then
    raise exception 'Late payment changed original close';
  end if;
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',false);
do $$ begin
  if public.experimental_close_online_cash(repeat('a',64),
    '44444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,100,'Conferido')
    -> 'snapshot' -> 'cashSessions' -> 0 ->> 'expectedCash' <> '84.50' then
    raise exception 'Replay after refund changed';
  end if;
end $$;
begin isolation level repeatable read;
do $$ begin
  begin
    perform public.experimental_close_online_cash(repeat('a',64),
      '44444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,100,'Conferido');
    raise exception 'Repeatable read close accepted';
  exception when raise_exception then if sqlerrm <> 'Online cash close requires read committed isolation' then raise; end if;
  end;
end $$;
rollback;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','55555555-5555-5555-5555-555555555555',false);
select public.experimental_enable_store_presence(repeat('b',64));
select public.experimental_quote_online_cash_close(repeat('b',64),
  '55555555-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0);
do $$ begin
  begin
    perform public.experimental_close_online_cash(repeat('b',64),
      '55555555-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,0,'');
    raise exception 'Pending Pix accepted';
  exception when raise_exception then if sqlerrm <> 'Pending Pix requires review' then raise; end if;
  end;
end $$;
reset role;
update public.online_orders set payment_status = 'approved', paid_at = '2026-01-01T11:00:00Z'
where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
set role authenticated;
do $$
declare r jsonb;
begin
  r := public.experimental_close_online_cash(repeat('b',64),
    '55555555-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,0,'');
  if r ->> 'status' <> 'conflict' or r ->> 'reason' <> 'payments-changed' then
    raise exception 'Payment conflict not detected: %', r;
  end if;
  if public.experimental_close_online_cash(repeat('b',64),
    '55555555-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0,0,'') is distinct from r then
    raise exception 'Conflict replay changed';
  end if;
end $$;
select public.experimental_quote_online_cash_close(repeat('b',64),
  '55555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb','cash',0);
reset role;
create function public.test_fail_cash_close() returns trigger language plpgsql as $$
begin raise exception 'forced failure'; end $$;
create trigger test_fail_cash_close before insert on public.experimental_online_cash_closes
for each row execute function public.test_fail_cash_close();
set role authenticated;
do $$ begin
  begin
    perform public.experimental_close_online_cash(repeat('b',64),
      '55555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb','cash',0,1,'');
    raise exception 'Forced failure not raised';
  exception when raise_exception then if sqlerrm <> 'forced failure' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if (select sync_revision from public.business_data where user_id = '55555555-5555-5555-5555-555555555555') <> 0
    or exists (select 1 from public.experimental_cash_checkpoints where checkpoint_id = '55555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    or (select data -> 'cashSessions' -> 0 ? 'closedAt' from public.business_data where user_id = '55555555-5555-5555-5555-555555555555') then
    raise exception 'Failed close was not rolled back';
  end if;
end $$;
drop trigger test_fail_cash_close on public.experimental_online_cash_closes;
set role authenticated;
do $$ begin
  if public.experimental_close_online_cash(repeat('b',64),
    '55555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb','cash',0,1,'') ->> 'status' <> 'closed' then
    raise exception 'Close failed after rollback';
  end if;
end $$;
reset role;
