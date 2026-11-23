-- Experimental diagnostic only. This snapshot cannot authorize a final close.
-- Requires experimental-presence.sql and experimental-payment-events.sql.
-- Do not apply to a production project.
create or replace function public.experimental_cash_review(p_credential text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := auth.uid();
  v_count bigint;
  v_orders jsonb;
  v_event_count bigint;
  v_events jsonb;
begin
  if v_business_id is null then raise exception 'Authentication required'; end if;
  if p_credential is null or p_credential !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid device credential';
  end if;
  if not exists (
    select 1 from public.offline_store_presence
    where business_id = v_business_id
      and credential_hash = pg_catalog.sha256(pg_catalog.convert_to(p_credential, 'UTF8'))
  ) then
    raise exception 'Invalid device credential';
  end if;

  select orders.total, orders.items, events.total, events.items
  into v_count, v_orders, v_event_count, v_events
  from (
    select count(*) as total, coalesce(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', id, 'paymentMethod', order_data ->> 'paymentMethod',
        'paymentStatus', payment_status, 'status', status, 'total', total,
        'createdAt', created_at, 'paidAt', paid_at
      ) order by id), '[]'::jsonb) as items
    from (
      select id, order_data, payment_status, status, total, created_at, paid_at
      from public.online_orders where business_id = v_business_id
      order by id limit 10001
    ) selected_orders
  ) orders
  cross join (
    select count(*) as total, coalesce(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'orderId', order_id, 'operation', operation, 'before', before_payment,
        'after', after_payment, 'observedAt', observed_at
      ) order by id), '[]'::jsonb) as items
    from (
      select id, order_id, operation, before_payment, after_payment, observed_at
      from public.experimental_payment_events where business_id = v_business_id
      order by id limit 10001
    ) selected_events
  ) events;

  if v_count > 10000 then raise exception 'Too many orders for experimental cash review'; end if;
  if v_event_count > 10000 then raise exception 'Too many payment events for experimental cash review'; end if;
  return pg_catalog.jsonb_build_object('orders', v_orders, 'events', v_events);
end;
$$;

revoke all on function public.experimental_cash_review(text) from public, anon, authenticated;
grant execute on function public.experimental_cash_review(text) to authenticated;
