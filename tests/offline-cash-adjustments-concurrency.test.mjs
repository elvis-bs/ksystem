import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const container = process.env.OFFLINE_TEST_PG_CONTAINER;
const business = "33333333-3333-3333-3333-333333333333";
const credential = "c".repeat(64);
const otherBusiness = "44444444-4444-4444-4444-444444444444";

function sql(query) {
  const result = spawnSync("docker", [
    "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres"
  ], { input: query, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function session(t, name, query) {
  const child = spawn("docker", [
    "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres"
  ], { stdio: "pipe" });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", data => { output += data; });
  child.stderr.setEncoding("utf8").on("data", data => { errors += data; });
  const finished = once(child, "close").then(([code]) => ({ code, output, errors }));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdin.write(`set application_name = '${name}';\n${query}\n`);
  return { child, finished, output: () => output };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

test("payment writes on either side of a checkpoint are captured without a gap", { skip: !container, timeout: 30000 }, async t => {
  sql(`insert into auth.users values ('${business}'), ('${otherBusiness}');
    insert into public.online_orders (business_id,payment_method,order_data)
    values ('${business}','pix','{"paymentMethod":"pix"}'),
      ('${otherBusiness}','pix','{"paymentMethod":"pix"}');
    set role authenticated;
    select set_config('request.jwt.claim.sub','${business}',false);
    select public.experimental_enable_store_presence('${credential}');`);
  const writer = session(t, "cash_payment_before", `begin;
    update public.online_orders set payment_status = 'approved' where business_id = '${business}';
    \\echo READY`);
  await waitFor(() => writer.output().includes("READY"), "Payment writer did not start");
  const checkpoint = session(t, "cash_checkpoint_waiting", `set role authenticated;
    select set_config('request.jwt.claim.sub','${business}',false);
    select public.experimental_create_cash_checkpoint('${credential}',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','cash','2026-01-01T12:00:00Z');`);
  checkpoint.child.stdin.end();
  await waitFor(() => sql("select count(*) from pg_stat_activity where application_name = 'cash_checkpoint_waiting' and wait_event_type = 'Lock';") === "1",
    "Checkpoint did not wait for payment");
  writer.child.stdin.end("commit;\n");
  const writeResult = await writer.finished;
  assert.equal(writeResult.code, 0, writeResult.errors);
  const checkpointResult = await checkpoint.finished;
  assert.equal(checkpointResult.code, 0, checkpointResult.errors);
  assert.match(checkpointResult.output, /"paymentStatus": "approved"/);
  assert.equal(sql(`select count(*) from public.experimental_cash_adjustment_candidates where business_id = '${business}';`), "0");

  const checkpointFirst = session(t, "cash_checkpoint_first", `set role authenticated;
    select set_config('request.jwt.claim.sub','${business}',false);
    begin;
    select public.experimental_create_cash_checkpoint('${credential}',
      'cccccccc-cccc-cccc-cccc-cccccccccccc','cash-2','2026-01-01T12:00:00Z');
    \\echo READY`);
  await waitFor(() => checkpointFirst.output().includes("READY"), "Checkpoint did not start");
  const otherWriter = session(t, "cash_other_business", `update public.online_orders
    set payment_status = 'approved' where business_id = '${otherBusiness}';`);
  otherWriter.child.stdin.end();
  await waitFor(() => otherWriter.child.exitCode !== null, "Another store was blocked by the checkpoint");
  const otherResult = await otherWriter.finished;
  assert.equal(otherResult.code, 0, otherResult.errors);
  const lateWriter = session(t, "cash_payment_waiting", `update public.online_orders
    set payment_status = 'refunded' where business_id = '${business}';`);
  lateWriter.child.stdin.end();
  await waitFor(() => sql("select count(*) from pg_stat_activity where application_name = 'cash_payment_waiting' and wait_event_type = 'Lock';") === "1",
    "Payment did not wait for checkpoint");
  checkpointFirst.child.stdin.end("commit;\n");
  const firstResult = await checkpointFirst.finished;
  assert.equal(firstResult.code, 0, firstResult.errors);
  const lateResult = await lateWriter.finished;
  assert.equal(lateResult.code, 0, lateResult.errors);
  assert.equal(sql(`select count(*) from public.experimental_cash_adjustment_candidates
    where business_id = '${business}' and checkpoint_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';`), "1");

  const beforeDelete = session(t, "cash_checkpoint_before_delete", `set role authenticated;
    select set_config('request.jwt.claim.sub','${business}',false);
    begin;
    select public.experimental_create_cash_checkpoint('${credential}',
      'dddddddd-dddd-dddd-dddd-dddddddddddd','cash-3','2026-01-01T12:00:00Z');
    \\echo READY`);
  await waitFor(() => beforeDelete.output().includes("READY"), "Deletion checkpoint did not start");
  const deletion = session(t, "cash_deletion_waiting", `delete from public.online_orders
    where business_id = '${business}';`);
  deletion.child.stdin.end();
  await waitFor(() => sql("select count(*) from pg_stat_activity where application_name = 'cash_deletion_waiting' and wait_event_type = 'Lock';") === "1",
    "Deletion did not wait for checkpoint");
  beforeDelete.child.stdin.end("commit;\n");
  const beforeDeleteResult = await beforeDelete.finished;
  assert.equal(beforeDeleteResult.code, 0, beforeDeleteResult.errors);
  assert.match(beforeDeleteResult.output, /"paymentStatus": "refunded"/);
  const deletionResult = await deletion.finished;
  assert.equal(deletionResult.code, 0, deletionResult.errors);
  assert.equal(sql(`select count(*) from public.experimental_cash_adjustment_candidates c
    join public.experimental_payment_events e on e.id = c.event_id
    where c.business_id = '${business}' and c.checkpoint_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
      and e.operation = 'delete';`), "1");

  sql(`set role authenticated;
    select set_config('request.jwt.claim.sub','${otherBusiness}',false);
    select public.experimental_enable_store_presence(repeat('d',64));
    select public.experimental_create_cash_checkpoint(repeat('d',64),
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','other-cash','2026-01-01T12:00:00Z');
    select set_config('request.jwt.claim.sub','${business}',false);
    select public.experimental_create_cash_checkpoint('${credential}',
      'ffffffff-ffff-ffff-ffff-ffffffffffff','cash-4','2026-01-01T12:00:00Z');
    reset role;
    update public.online_orders set business_id = '${business}' where business_id = '${otherBusiness}';`);
  assert.equal(sql(`select count(*) from public.experimental_cash_adjustment_candidates c
    join public.experimental_payment_events e on e.id = c.event_id
    where (c.business_id = '${business}' and c.checkpoint_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff' and e.operation = 'insert')
       or (c.business_id = '${otherBusiness}' and c.checkpoint_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and e.operation = 'delete');`), "2");
});

test("concurrent decisions preserve one winner and durably reject a stale review", { skip: !container, timeout: 30000 }, async t => {
  const store = "55555555-5555-5555-5555-555555555555";
  const checkpoint = "55555555-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const firstId = "55555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const secondId = "55555555-cccc-cccc-cccc-cccccccccccc";
  sql(`insert into auth.users values ('${store}');
    insert into public.online_orders (business_id,payment_method,order_data)
      values ('${store}','pix','{"paymentMethod":"pix"}');
    set role authenticated;
    select set_config('request.jwt.claim.sub','${store}',false);
    select public.experimental_enable_store_presence('${credential}');
    select public.experimental_create_cash_checkpoint('${credential}','${checkpoint}','cash','2026-01-01T12:00:00Z');
    reset role;
    update public.online_orders set payment_status = 'approved' where business_id = '${store}';`);
  const eventId = sql(`select event_id from public.experimental_cash_adjustment_candidates where business_id = '${store}';`);
  const call = (operation, classification) => `public.experimental_decide_cash_adjustment('${credential}',
    '${checkpoint}', '${eventId}', '${operation}', null, '${classification}', 'Conferido')`;
  const first = session(t, "cash_decision_first", `set role authenticated;
    select set_config('request.jwt.claim.sub','${store}',false);
    begin; select ${call(firstId, "this-session")}; \\echo READY`);
  await waitFor(() => first.output().includes("READY"), "First decision did not start");
  const second = session(t, "cash_decision_waiting", `set role authenticated;
    select set_config('request.jwt.claim.sub','${store}',false);
    select ${call(secondId, "other-session")};`);
  second.child.stdin.end();
  await waitFor(() => sql("select count(*) from pg_stat_activity where application_name = 'cash_decision_waiting' and wait_event_type = 'Lock';") === "1",
    "Second decision did not wait");
  first.child.stdin.end("commit;\n");
  const firstResult = await first.finished;
  const secondResult = await second.finished;
  assert.equal(firstResult.code, 0, firstResult.errors);
  assert.match(firstResult.output, /"status": "recorded"/);
  assert.equal(secondResult.code, 0, secondResult.errors);
  assert.match(secondResult.output, /"status": "conflict"/);
  assert.match(sql(`set role authenticated; select set_config('request.jwt.claim.sub','${store}',false);
    select ${call(secondId, "other-session")};`), /"status": "conflict"/);
  assert.equal(sql(`select count(*) from public.experimental_cash_adjustment_decisions where business_id = '${store}';`), "2");
});
