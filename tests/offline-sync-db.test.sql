insert into auth.users values ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
insert into public.business_data (user_id, data)
values ('11111111-1111-1111-1111-111111111111',
        '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}'),
       ('22222222-2222-2222-2222-222222222222',
        '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $$
declare
  payload jsonb := '{"products":[],"ingredients":[],"sales":[{"id":"one"}],"cashSessions":[]}';
  answer jsonb;
begin
  answer := public.apply_offline_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', payload, 0);
  if answer <> '{"status":"applied","revision":1}'::jsonb then raise exception 'First apply: %', answer; end if;
  answer := public.apply_offline_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', payload, 0);
  if answer <> '{"status":"applied","revision":1}'::jsonb then raise exception 'Replay: %', answer; end if;
  answer := public.apply_offline_snapshot('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', payload, 0);
  if answer <> '{"status":"conflict","revision":1}'::jsonb then raise exception 'Conflict: %', answer; end if;
  begin
    perform public.apply_offline_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 0);
    raise exception 'Changed operation was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Sync operation already used with different data' then raise; end if;
  end;
  begin
    perform public.apply_offline_snapshot('cccccccc-cccc-cccc-cccc-cccccccccccc', '{}', 1);
    raise exception 'Invalid data was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid sync input' then raise; end if;
  end;
  begin
    perform public.apply_offline_snapshot('cccccccc-cccc-cccc-cccc-cccccccccccc',
      '{"products":[],"ingredients":[],"sales":[],"cashSessions":[{"offlineClosureStatus":"provisional"}]}', 1);
    raise exception 'Provisional closure was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Provisional cash closure requires online reconciliation' then raise; end if;
  end;
end $$;
reset role;
do $$
begin
  if (select sync_revision from public.business_data where user_id = '11111111-1111-1111-1111-111111111111') <> 1
  then raise exception 'Rejected provisional closure changed the revision'; end if;
end $$;

create extension dblink;
insert into auth.users values ('33333333-3333-3333-3333-333333333333');
insert into public.business_data (user_id, data)
values ('33333333-3333-3333-3333-333333333333',
        '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}');
select dblink_connect('first', 'dbname=postgres');
select dblink_connect('second', 'dbname=postgres');
select dblink_exec('first', $sql$set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333'$sql$);
select dblink_exec('second', $sql$set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333'$sql$);
select dblink_send_query('first', $sql$
  select public.apply_offline_snapshot('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    '{"products":[],"ingredients":[],"sales":[{"id":"first"}],"cashSessions":[]}', 0)
$sql$);
select dblink_send_query('second', $sql$
  select public.apply_offline_snapshot('ffffffff-ffff-ffff-ffff-ffffffffffff',
    '{"products":[],"ingredients":[],"sales":[{"id":"second"}],"cashSessions":[]}', 0)
$sql$);
create temporary table concurrent_results (answer jsonb);
insert into concurrent_results select answer from dblink_get_result('first') as result(answer jsonb);
insert into concurrent_results select answer from dblink_get_result('second') as result(answer jsonb);
do $$
begin
  if (select count(*) from concurrent_results where answer = '{"status":"applied","revision":1}'::jsonb) <> 1
    or (select count(*) from concurrent_results where answer = '{"status":"conflict","revision":1}'::jsonb) <> 1
  then raise exception 'Concurrent sends did not yield one success and one conflict'; end if;
  if (select sync_revision from public.business_data where user_id = '33333333-3333-3333-3333-333333333333') <> 1
  then raise exception 'Concurrent sends modified the snapshot more than once'; end if;
end $$;
select dblink_disconnect('first');
select dblink_disconnect('second');
reset role;

update public.business_data set data = '{"legacy":"write"}'
where user_id = '11111111-1111-1111-1111-111111111111';
set role authenticated;
do $$
declare answer jsonb;
begin
  answer := public.apply_offline_snapshot('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 1);
  if answer <> '{"status":"conflict","revision":2}'::jsonb then raise exception 'Legacy update: %', answer; end if;
  begin
    perform * from public.offline_sync_operations;
    raise exception 'Operation log was readable';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
do $$
declare answer jsonb;
begin
  answer := public.apply_offline_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 0);
  if answer <> '{"status":"applied","revision":1}'::jsonb then raise exception 'Isolated user: %', answer; end if;
end $$;
select set_config('request.jwt.claim.sub', '', false);
do $$
begin
  begin
    perform public.apply_offline_snapshot('dddddddd-dddd-dddd-dddd-dddddddddddd',
      '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}', 0);
    raise exception 'Unauthenticated call was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Authentication required' then raise; end if;
  end;
end $$;
