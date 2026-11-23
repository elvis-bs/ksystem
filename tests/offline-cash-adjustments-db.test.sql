alter table public.online_orders add column order_data jsonb not null default '{}';
alter table public.online_orders add column payment_status text not null default 'pending';
alter table public.online_orders add column status text not null default 'Aguardando Pix';
alter table public.online_orders add column total numeric(10,2) not null default 10;
alter table public.online_orders add column created_at timestamptz not null default now();
alter table public.online_orders add column paid_at timestamptz;
alter table public.online_orders add column payment_id text;
insert into auth.users values ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
insert into public.online_orders (business_id, payment_method, order_data)
values ('11111111-1111-1111-1111-111111111111', 'pix', '{"paymentMethod":"pix","customerEmail":"private@example.test"}'),
       ('22222222-2222-2222-2222-222222222222', 'pix', '{"paymentMethod":"pix"}');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.experimental_enable_store_presence(repeat('a',64));
do $$
declare checkpoint jsonb; candidates jsonb;
begin
  checkpoint := public.experimental_create_cash_checkpoint(repeat('a',64),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cash-1', '2026-01-01T12:00:00Z');
  if jsonb_array_length(checkpoint -> 'orders') <> 1
    or checkpoint::text like '%private@example.test%' then raise exception 'Incorrect checkpoint'; end if;
  candidates := public.experimental_cash_checkpoint_candidates(repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  if jsonb_array_length(candidates -> 'events') <> 0 then raise exception 'Existing event became candidate'; end if;
  begin
    perform public.experimental_create_cash_checkpoint(repeat('a',64),
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'other', '2026-01-01T12:00:00Z');
    raise exception 'Changed checkpoint accepted';
  exception when raise_exception then
    if sqlerrm <> 'Cash checkpoint already used with different data' then raise; end if;
  end;
  begin
    perform * from public.experimental_cash_adjustment_candidates;
    raise exception 'Candidate table exposed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.experimental_create_cash_checkpoint(repeat('b',64),
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cash-1', '2026-01-01T12:00:00Z');
    raise exception 'Wrong credential accepted for checkpoint';
  exception when raise_exception then if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
end $$;
reset role;

update public.online_orders set payment_status = 'approved', paid_at = '2026-01-01T11:00:00Z'
where business_id = '11111111-1111-1111-1111-111111111111';
do $$
begin
  begin
    update public.online_orders set payment_status = 'refunded'
    where business_id = '11111111-1111-1111-1111-111111111111';
    raise exception 'rollback';
  exception when raise_exception then if sqlerrm <> 'rollback' then raise; end if;
  end;
end $$;
update public.online_orders set payment_status = 'refunded'
where business_id = '11111111-1111-1111-1111-111111111111';
update public.online_orders set payment_status = 'approved'
where business_id = '22222222-2222-2222-2222-222222222222';

set role authenticated;
do $$
declare checkpoint jsonb; candidates jsonb; event_id text; decision jsonb;
begin
  checkpoint := public.experimental_create_cash_checkpoint(repeat('a',64),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cash-1', '2026-01-01T12:00:00Z');
  if checkpoint -> 'orders' -> 0 ->> 'paymentStatus' <> 'pending'
  then raise exception 'Checkpoint changed on retry'; end if;
  candidates := public.experimental_cash_checkpoint_candidates(repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  if jsonb_array_length(candidates -> 'events') <> 2
    or jsonb_typeof(candidates -> 'events' -> 0 -> 'eventId') is distinct from 'string'
    or jsonb_typeof(candidates -> 'events' -> 1 -> 'eventId') is distinct from 'string'
    or coalesce((candidates -> 'events' -> 0 ->> 'eventId') !~ '^[1-9][0-9]*$', true)
    or coalesce((candidates -> 'events' -> 1 ->> 'eventId') !~ '^[1-9][0-9]*$', true)
    or candidates -> 'events' -> 0 ->> 'eventId' = candidates -> 'events' -> 1 ->> 'eventId'
    or candidates -> 'events' -> 0 -> 'after' ->> 'paymentStatus' <> 'approved'
    or candidates -> 'events' -> 1 -> 'after' ->> 'paymentStatus' <> 'refunded'
  then raise exception 'Late payment or refund missing: %', candidates; end if;
  if candidates is distinct from public.experimental_cash_checkpoint_candidates(
    repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') then
    raise exception 'Candidate identifiers or data changed on retry';
  end if;
  event_id := candidates -> 'events' -> 0 ->> 'eventId';
  decision := public.experimental_decide_cash_adjustment(repeat('a',64),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', event_id, '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    null, 'this-session', 'Conferido');
  if decision ->> 'status' <> 'recorded' then raise exception 'Decision not recorded'; end if;
  if decision is distinct from public.experimental_decide_cash_adjustment(repeat('a',64),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', event_id, '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    null, 'this-session', 'Conferido') then raise exception 'Decision retry differs'; end if;
  begin
    perform public.experimental_decide_cash_adjustment(repeat('a',64),
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', event_id, '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      null, 'other-session', 'Conferido');
    raise exception 'Changed decision accepted';
  exception when raise_exception then
    if sqlerrm <> 'Cash decision operation already used with different data' then raise; end if;
  end;
  decision := public.experimental_decide_cash_adjustment(repeat('a',64),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', event_id, '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    null, 'other-session', 'Concorrente');
  if decision ->> 'status' <> 'conflict' then raise exception 'Stale decision accepted'; end if;
  decision := public.experimental_decide_cash_adjustment(repeat('a',64),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', event_id, '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'unresolved', 'Reavaliar');
  if decision ->> 'status' <> 'recorded' then raise exception 'Correction not recorded'; end if;
  candidates := public.experimental_cash_checkpoint_candidates(repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  if candidates -> 'events' -> 0 -> 'decision' ->> 'decisionId' <> '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    or candidates -> 'events' -> 0 -> 'decision' ->> 'classification' <> 'unresolved'
    or candidates -> 'events' -> 1 -> 'decision' <> 'null'::jsonb then
    raise exception 'Wrong decision head: %', candidates;
  end if;
  begin
    perform * from public.experimental_cash_adjustment_decisions;
    raise exception 'Decisions table exposed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.experimental_decide_cash_adjustment(repeat('a',64),
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '9223372036854775808', gen_random_uuid(),
      null, 'unresolved', 'Conferir');
    raise exception 'Invalid event accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid cash adjustment decision' then raise; end if;
  end;
  begin
    perform public.experimental_decide_cash_adjustment(repeat('b',64),
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', event_id, gen_random_uuid(),
      null, 'unresolved', 'Conferir');
    raise exception 'Wrong decision credential accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
  begin
    perform public.experimental_decide_cash_adjustment(repeat('a',64),
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', event_id, gen_random_uuid(),
      null, 'unresolved', ' ');
    raise exception 'Empty decision justification accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid cash adjustment decision' then raise; end if;
  end;
  begin
    perform public.experimental_cash_checkpoint_candidates(repeat('b',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    raise exception 'Wrong credential accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
end $$;
begin isolation level repeatable read;
do $$
begin
  begin
    perform public.experimental_create_cash_checkpoint(repeat('a',64),
      'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cash-2', '2026-01-01T12:00:00Z');
    raise exception 'Repeatable read checkpoint accepted';
  exception when raise_exception then
    if sqlerrm <> 'Cash checkpoint requires read committed isolation' then raise; end if;
  end;
end $$;
rollback;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.experimental_enable_store_presence(repeat('b',64));
do $$
begin
  begin
    perform public.experimental_cash_checkpoint_candidates(repeat('b',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    raise exception 'Another store checkpoint accepted';
  exception when raise_exception then if sqlerrm <> 'Cash checkpoint not found' then raise; end if;
  end;
  begin
    perform public.experimental_decide_cash_adjustment(repeat('b',64),
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1', gen_random_uuid(),
      null, 'unresolved', 'Conferir');
    raise exception 'Another store decision accepted';
  exception when raise_exception then if sqlerrm <> 'Cash adjustment candidate not found' then raise; end if;
  end;
end $$;
reset role;
set role anon;
do $$
begin
  begin
    perform public.experimental_cash_checkpoint_candidates(repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    raise exception 'Anonymous access accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.experimental_decide_cash_adjustment(repeat('a',64),
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1', gen_random_uuid(),
      null, 'unresolved', 'Conferir');
    raise exception 'Anonymous decision accepted';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
