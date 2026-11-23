alter table public.online_orders add column order_data jsonb not null default '{}';
alter table public.online_orders add column payment_status text not null default 'pending';
alter table public.online_orders add column status text not null default 'Aguardando Pix';
alter table public.online_orders add column total numeric(10,2) not null default 10;
alter table public.online_orders add column created_at timestamptz not null default now();
alter table public.online_orders add column paid_at timestamptz;
alter table public.online_orders add column payment_id text;

insert into auth.users values ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
insert into public.online_orders (business_id, payment_method, order_data, payment_status, status, total, paid_at)
values ('11111111-1111-1111-1111-111111111111', 'pix', '{"paymentMethod":"pix","customerEmail":"private@example.test"}', 'approved', 'Recebido', 25.50, now()),
       ('11111111-1111-1111-1111-111111111111', 'pix', '{"paymentMethod":"pix"}', 'pending', 'Aguardando Pix', 12, null),
       ('22222222-2222-2222-2222-222222222222', 'pix', '{"paymentMethod":"pix"}', 'approved', 'Recebido', 20, now());

update public.online_orders set payment_status = 'refunded' where business_id = '11111111-1111-1111-1111-111111111111'
  and payment_status = 'approved';
update public.online_orders set status = 'Concluído' where business_id = '11111111-1111-1111-1111-111111111111'
  and payment_status = 'refunded';
do $$
begin
  begin
    update public.online_orders set payment_status = 'cancelled'
      where business_id = '11111111-1111-1111-1111-111111111111' and payment_status = 'pending';
    raise exception 'rollback test';
  exception when raise_exception then
    if sqlerrm <> 'rollback test' then raise; end if;
  end;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.experimental_enable_store_presence(repeat('a',64));
do $$
declare review jsonb;
begin
  begin
    perform public.experimental_cash_review(repeat('b',64));
    raise exception 'Wrong credential accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
  review := public.experimental_cash_review(repeat('a',64));
  if jsonb_array_length(review -> 'orders') <> 2 then raise exception 'Orders missing or other store leaked'; end if;
  if jsonb_array_length(review -> 'events') <> 3 then raise exception 'Payment events missing, duplicated or leaked: %', review; end if;
  if not exists (select 1 from jsonb_array_elements(review -> 'events') item
    where item ->> 'operation' = 'update' and item -> 'before' ->> 'paymentStatus' = 'approved'
      and item -> 'after' ->> 'paymentStatus' = 'refunded') then
    raise exception 'Refund not recorded';
  end if;
  if review::text like '%private@example.test%' then raise exception 'Customer data exposed'; end if;
  if not exists (select 1 from jsonb_array_elements(review -> 'orders') item
    where item ->> 'paymentStatus' = 'pending' and item ->> 'paymentMethod' = 'pix') then
    raise exception 'Pending Pix missing';
  end if;
  begin
    perform * from public.experimental_payment_events;
    raise exception 'Event table was readable';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
do $$
begin
  begin
    perform public.experimental_cash_review(repeat('a',64));
    raise exception 'Other store credential accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
end $$;
reset role;
set role anon;
do $$
begin
  begin
    perform public.experimental_cash_review(repeat('a',64));
    raise exception 'Anonymous review accepted';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

update public.online_orders set payment_status = 'approved', paid_at = now(), payment_id = 'late-payment'
where business_id = '11111111-1111-1111-1111-111111111111' and payment_status = 'pending';
delete from public.online_orders
where business_id = '11111111-1111-1111-1111-111111111111' and payment_status = 'refunded';
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $$
declare review jsonb := public.experimental_cash_review(repeat('a',64));
begin
  if jsonb_array_length(review -> 'orders') <> 1 or jsonb_array_length(review -> 'events') <> 5 then
    raise exception 'Late payment or deletion event was lost';
  end if;
  if not exists (select 1 from jsonb_array_elements(review -> 'events') item
    where item -> 'before' ->> 'paymentStatus' = 'pending'
      and item -> 'after' ->> 'paymentStatus' = 'approved') then
    raise exception 'Late payment event not found';
  end if;
  if not exists (select 1 from jsonb_array_elements(review -> 'events') item
    where item ->> 'operation' = 'delete' and item -> 'before' ->> 'paymentStatus' = 'refunded') then
    raise exception 'Deleted order event not found';
  end if;
  if review::text like '%late-payment%' then raise exception 'Provider payment ID exposed'; end if;
end $$;
reset role;

insert into public.online_orders (business_id, payment_method)
select '22222222-2222-2222-2222-222222222222', 'cash'
from generate_series(1, 10000);
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.experimental_enable_store_presence(repeat('b',64));
do $$
begin
  begin
    perform public.experimental_cash_review(repeat('b',64));
    raise exception 'Partial review accepted';
  exception when raise_exception then
    if sqlerrm <> 'Too many orders for experimental cash review' then raise; end if;
  end;
end $$;
reset role;

do $$
begin
  for i in 1..10001 loop
    update public.online_orders
    set payment_status = case when payment_status = 'approved' then 'pending' else 'approved' end
    where business_id = '11111111-1111-1111-1111-111111111111';
  end loop;
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $$
begin
  begin
    perform public.experimental_cash_review(repeat('a',64));
    raise exception 'Partial event history accepted';
  exception when raise_exception then
    if sqlerrm <> 'Too many payment events for experimental cash review' then raise; end if;
  end;
end $$;
