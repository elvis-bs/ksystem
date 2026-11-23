-- Experimental audit trail only; not a finalization or synchronization lock.
-- Install before experimental-cash-review.sql in an isolated database only.
create table if not exists public.experimental_payment_events (
  id bigint generated always as identity primary key,
  business_id uuid not null references auth.users (id) on delete cascade,
  order_id text not null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  before_payment jsonb,
  after_payment jsonb,
  observed_at timestamptz not null default clock_timestamp()
);

create index if not exists experimental_payment_events_business_id_idx
  on public.experimental_payment_events (business_id, id);
alter table public.experimental_payment_events enable row level security;
revoke all on public.experimental_payment_events from public, anon, authenticated;

create or replace function public.experimental_record_payment_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
  v_after jsonb;
begin
  if tg_op = 'UPDATE' and old.business_id is distinct from new.business_id then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(least(old.business_id, new.business_id)::text, 846219));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(greatest(old.business_id, new.business_id)::text, 846219));
  else
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      (case when tg_op = 'DELETE' then old.business_id else new.business_id end)::text, 846219));
  end if;
  if tg_op <> 'INSERT' then
    v_before := pg_catalog.jsonb_build_object(
      'paymentStatus', old.payment_status, 'paidAt', old.paid_at,
      'hasPaymentId', old.payment_id is not null, 'paymentMethod', old.order_data ->> 'paymentMethod', 'total', old.total);
  end if;
  if tg_op <> 'DELETE' then
    v_after := pg_catalog.jsonb_build_object(
      'paymentStatus', new.payment_status, 'paidAt', new.paid_at,
      'hasPaymentId', new.payment_id is not null, 'paymentMethod', new.order_data ->> 'paymentMethod', 'total', new.total);
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from auth.users where id = old.business_id) then
    return old;
  end if;
  if tg_op = 'UPDATE' and (old.business_id is distinct from new.business_id or old.id is distinct from new.id) then
    insert into public.experimental_payment_events (business_id, order_id, operation, before_payment)
    values (old.business_id, old.id::text, 'delete', v_before);
    insert into public.experimental_payment_events (business_id, order_id, operation, after_payment)
    values (new.business_id, new.id::text, 'insert', v_after);
  elsif tg_op <> 'UPDATE' then
    insert into public.experimental_payment_events (business_id, order_id, operation, before_payment, after_payment)
    values (case when tg_op = 'DELETE' then old.business_id else new.business_id end,
      case when tg_op = 'DELETE' then old.id::text else new.id::text end,
      pg_catalog.lower(tg_op), v_before, v_after);
  elsif v_before is distinct from v_after or old.payment_id is distinct from new.payment_id then
    insert into public.experimental_payment_events (business_id, order_id, operation, before_payment, after_payment)
    values (new.business_id, new.id::text, 'update', v_before, v_after);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.experimental_record_payment_event() from public, anon, authenticated;
drop trigger if exists experimental_record_payment_event on public.online_orders;
create trigger experimental_record_payment_event
after insert or update or delete on public.online_orders
for each row execute function public.experimental_record_payment_event();
