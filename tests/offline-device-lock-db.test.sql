insert into auth.users values ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
insert into public.business_data (user_id, data)
values ('11111111-1111-1111-1111-111111111111', '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}'),
       ('22222222-2222-2222-2222-222222222222', '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}');
insert into public.public_menus values ('11111111-1111-1111-1111-111111111111', '{}');
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
update public.business_data set data = '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}'
where user_id = '11111111-1111-1111-1111-111111111111';
select public.experimental_enable_store_presence(repeat('a',64));

do $$
declare result jsonb;
begin
  begin
    update public.business_data set data = '{"legacy":"overwrite"}'
    where user_id = '11111111-1111-1111-1111-111111111111';
    raise exception 'Legacy update accepted';
  exception when raise_exception then if sqlerrm <> 'STORE_DEVICE_LOCKED' then raise; end if;
  end;
  begin
    insert into public.business_data (user_id, data)
    values ('11111111-1111-1111-1111-111111111111', '{}')
    on conflict (user_id) do update set data = excluded.data;
    raise exception 'Legacy upsert accepted';
  exception when raise_exception then if sqlerrm <> 'STORE_DEVICE_LOCKED' then raise; end if;
  end;
  begin
    update public.public_menus set menu = '{"enabled":true}'
    where user_id = '11111111-1111-1111-1111-111111111111';
    raise exception 'Legacy menu update accepted';
  exception when raise_exception then if sqlerrm <> 'STORE_DEVICE_LOCKED' then raise; end if;
  end;
  begin
    delete from public.public_menus where user_id = '11111111-1111-1111-1111-111111111111';
    raise exception 'Legacy menu delete accepted';
  exception when raise_exception then if sqlerrm <> 'STORE_DEVICE_LOCKED' then raise; end if;
  end;
  begin
    perform public.apply_offline_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 1);
    raise exception 'Unprotected sync accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.experimental_apply_owned_snapshot(repeat('b',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 1);
    raise exception 'Wrong device accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
  result := public.experimental_apply_owned_snapshot(repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '{"products":[],"ingredients":[],"sales":[{"id":"sale"}],"cashSessions":[]}', 1);
  if result <> '{"status":"applied","revision":2}'::jsonb then raise exception 'Sync failed: %', result; end if;
  result := public.experimental_owned_operation_status(repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '{"products":[],"ingredients":[],"sales":[{"id":"sale"}],"cashSessions":[]}', 1);
  if result <> '{"status":"applied","revision":2}'::jsonb then raise exception 'Status missing: %', result; end if;
  result := public.experimental_owned_operation_status(repeat('a',64), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 1);
  if result <> '{"status":"unknown"}'::jsonb then raise exception 'Unknown status: %', result; end if;
  begin
    perform public.experimental_owned_operation_status(repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 1);
    raise exception 'Mismatched status accepted';
  exception when raise_exception then
    if sqlerrm <> 'Sync operation already used with different data' then raise; end if;
  end;
  begin
    perform public.experimental_owned_operation_status(repeat('b',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '{"products":[],"ingredients":[],"sales":[{"id":"sale"}],"cashSessions":[]}', 1);
    raise exception 'Wrong device status accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
  result := public.experimental_apply_owned_snapshot(repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '{"products":[],"ingredients":[],"sales":[{"id":"sale"}],"cashSessions":[]}', 1);
  if result <> '{"status":"applied","revision":2}'::jsonb then raise exception 'Replay failed: %', result; end if;
  result := public.experimental_apply_owned_snapshot(repeat('a',64), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 1);
  if result <> '{"status":"conflict","revision":2}'::jsonb then raise exception 'Conflict missed: %', result; end if;
  if (select data -> 'sales' from public.business_data where user_id = '11111111-1111-1111-1111-111111111111')
      <> '[{"id":"sale"}]'::jsonb then
    raise exception 'Conflict overwrote data';
  end if;
  begin
    perform public.experimental_apply_owned_snapshot(repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 1);
    raise exception 'Changed replay accepted';
  exception when raise_exception then
    if sqlerrm <> 'Sync operation already used with different data' then raise; end if;
  end;
  if not public.experimental_device_lock_exists('22222222-2222-2222-2222-222222222222') then
    raise exception 'Other account exposed';
  end if;
end $$;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
update public.business_data set data = '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}'
where user_id = '22222222-2222-2222-2222-222222222222';
insert into public.public_menus values ('22222222-2222-2222-2222-222222222222', '{}');
do $$
begin
  begin
    perform public.experimental_apply_owned_snapshot(repeat('a',64), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 1);
    raise exception 'Another store credential accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
  begin
    perform public.experimental_owned_operation_status(repeat('a',64), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '{"products":[],"ingredients":[],"sales":[{"id":"sale"}],"cashSessions":[]}', 1);
    raise exception 'Another store status accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid device credential' then raise; end if;
  end;
end $$;
