insert into auth.users values ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
insert into public.business_data (user_id)
values ('11111111-1111-1111-1111-111111111111'),
       ('22222222-2222-2222-2222-222222222222');

-- An existing business that has not opted in retains its previous behavior.
insert into public.online_orders (business_id, payment_method)
values ('11111111-1111-1111-1111-111111111111', 'cash');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.experimental_enable_store_presence(repeat('a', 64));
do $$
begin
  begin
    perform public.experimental_enable_store_presence(repeat('b', 64));
    raise exception 'Second device was provisioned';
  exception when unique_violation then null;
  end;
  begin
    perform public.experimental_store_heartbeat(repeat('b', 64), 0);
    raise exception 'Wrong credential accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
  begin
    perform * from public.offline_store_presence;
    raise exception 'Credentials exposed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
begin
  if public.experimental_store_is_present('11111111-1111-1111-1111-111111111111') then
    raise exception 'Unseen device must be closed';
  end if;
  begin
    insert into public.online_orders (business_id, payment_method)
    values ('11111111-1111-1111-1111-111111111111', 'pix');
    raise exception 'Order accepted before heartbeat';
  exception when raise_exception then
    if sqlerrm <> 'STORE_OFFLINE' then raise; end if;
  end;
end $$;

set role authenticated;
select public.experimental_store_heartbeat(repeat('a', 64), 0);
reset role;
insert into public.online_orders (business_id, payment_method)
values ('11111111-1111-1111-1111-111111111111', 'cash'),
       ('11111111-1111-1111-1111-111111111111', 'pix');

set role authenticated;
do $$
declare answer jsonb;
begin
  answer := public.apply_offline_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '{"products":[],"ingredients":[],"sales":[{"id":"offline"}],"cashSessions":[]}', 0);
  if answer <> '{"status":"applied","revision":1}'::jsonb then
    raise exception 'Unexpected sync result: %', answer;
  end if;
end $$;
reset role;
do $$
begin
  if public.experimental_store_is_present('11111111-1111-1111-1111-111111111111') then
    raise exception 'Changed remote revision must close availability';
  end if;
  begin
    insert into public.online_orders (business_id, payment_method)
    values ('11111111-1111-1111-1111-111111111111', 'pix');
    raise exception 'Order accepted after remote revision changed';
  exception when raise_exception then
    if sqlerrm <> 'STORE_OFFLINE' then raise; end if;
  end;
end $$;
set role authenticated;
do $$
begin
  begin
    perform public.experimental_store_heartbeat(repeat('a', 64), 0);
    raise exception 'Stale heartbeat accepted';
  exception when raise_exception then
    if sqlerrm <> 'Business revision differs' then raise; end if;
  end;
end $$;
select public.experimental_store_heartbeat(repeat('a', 64), 1);
reset role;

update public.offline_store_presence set last_seen_at = clock_timestamp() - interval '91 seconds'
where business_id = '11111111-1111-1111-1111-111111111111';
do $$
begin
  if public.experimental_store_is_present('11111111-1111-1111-1111-111111111111') then
    raise exception 'Expired device must be closed';
  end if;
  begin
    insert into public.online_orders (business_id, payment_method)
    values ('11111111-1111-1111-1111-111111111111', 'cash');
    raise exception 'Cash order accepted while offline';
  exception when raise_exception then
    if sqlerrm <> 'STORE_OFFLINE' then raise; end if;
  end;
end $$;
update public.offline_store_presence set last_seen_at = clock_timestamp() + interval '1 minute'
where business_id = '11111111-1111-1111-1111-111111111111';
do $$
begin
  if public.experimental_store_is_present('11111111-1111-1111-1111-111111111111') then
    raise exception 'Future heartbeat must be closed';
  end if;
end $$;
set role authenticated;
select public.experimental_store_heartbeat(repeat('a', 64), 1);
reset role;
insert into public.online_orders (business_id, payment_method)
values ('11111111-1111-1111-1111-111111111111', 'pix');

set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
do $$
begin
  begin
    perform public.experimental_store_heartbeat(repeat('a', 64), 0);
    raise exception 'Credential usable across stores';
  exception when raise_exception then
    if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claim.sub', '', false);
do $$
begin
  begin
    perform public.experimental_store_heartbeat(repeat('a', 64), 0);
    raise exception 'Anonymous heartbeat accepted';
  exception when raise_exception then
    if sqlerrm <> 'Authentication required' then raise; end if;
  end;
end $$;
