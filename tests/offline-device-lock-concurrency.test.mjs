import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const container = process.env.OFFLINE_TEST_PG_CONTAINER;
const firstBusiness = "33333333-3333-3333-3333-333333333333";
const secondBusiness = "44444444-4444-4444-4444-444444444444";
const snapshot = '{"products":[],"ingredients":[],"sales":[],"cashSessions":[]}';

function runSql(sql) {
  const result = spawnSync("docker", [
    "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres"
  ], { input: sql, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function session(t, applicationName, sql) {
  const child = spawn("docker", [
    "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres"
  ], { stdio: "pipe" });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  const finished = once(child, "close").then(([code]) => ({ code, output, errors }));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdin.write(`set application_name = '${applicationName}';\n${sql}\n`);
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

test("enrollment, legacy writes and owned sync serialize safely", { skip: !container, timeout: 30000 }, async t => {
  runSql(`insert into auth.users values ('${firstBusiness}'), ('${secondBusiness}');
    insert into public.business_data (user_id, data)
    values ('${firstBusiness}', '${snapshot}'), ('${secondBusiness}', '${snapshot}');`);

  const enrollment = session(t, "offline_lock_enrollment_first", `
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${firstBusiness}', false);
    begin;
    select public.experimental_enable_store_presence(repeat('a',64));
    \\echo READY
  `);
  await waitFor(() => enrollment.output().includes("READY"), "Enrollment did not acquire the lock");
  const writer = session(t, "offline_lock_writer_waiting", `
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${firstBusiness}', false);
    update public.business_data set data = '{"legacy":"overwrite"}' where user_id = '${firstBusiness}';
  `);
  writer.child.stdin.end();
  await waitFor(() => runSql("select count(*) from pg_stat_activity where application_name = 'offline_lock_writer_waiting' and wait_event = 'advisory';") === "1",
    "Legacy writer did not wait for enrollment");
  enrollment.child.stdin.end("commit;\n");
  assert.equal((await enrollment.finished).code, 0);
  const rejected = await writer.finished;
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.errors, /STORE_DEVICE_LOCKED/);
  assert.equal(runSql(`select data = '${snapshot}'::jsonb from public.business_data where user_id = '${firstBusiness}';`), "t");

  const firstWriter = session(t, "offline_lock_writer_first", `
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${secondBusiness}', false);
    begin;
    update public.business_data set data = '{"before":true}' where user_id = '${secondBusiness}';
    \\echo READY
  `);
  await waitFor(() => firstWriter.output().includes("READY"), "Legacy writer did not acquire the lock");
  const secondEnrollment = session(t, "offline_lock_enrollment_waiting", `
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${secondBusiness}', false);
    select public.experimental_enable_store_presence(repeat('b',64));
  `);
  secondEnrollment.child.stdin.end();
  await waitFor(() => runSql("select count(*) from pg_stat_activity where application_name = 'offline_lock_enrollment_waiting' and wait_event = 'advisory';") === "1",
    "Enrollment did not wait for legacy writer");
  firstWriter.child.stdin.end("commit;\n");
  assert.equal((await firstWriter.finished).code, 0);
  assert.equal((await secondEnrollment.finished).code, 0);
  assert.equal(runSql(`select data = '{"before":true}'::jsonb from public.business_data where user_id = '${secondBusiness}';`), "t");

  const sync = session(t, "offline_lock_sync_first", `
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${firstBusiness}', false);
    begin;
    select pg_advisory_xact_lock(hashtextextended('${firstBusiness}', 512483));
    \\echo READY
  `);
  await waitFor(() => sync.output().includes("READY"), "Sync did not acquire the lock");
  const lateWriter = session(t, "offline_lock_late_writer", `
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${firstBusiness}', false);
    update public.business_data set data = '{"legacy":"overwrite"}' where user_id = '${firstBusiness}';
  `);
  lateWriter.child.stdin.end();
  await waitFor(() => runSql("select count(*) from pg_stat_activity where application_name = 'offline_lock_late_writer' and wait_event = 'advisory';") === "1",
    "Legacy writer did not wait for sync");
  sync.child.stdin.end(`select public.experimental_apply_owned_snapshot(repeat('a',64),
    'cccccccc-cccc-cccc-cccc-cccccccccccc', '${snapshot}', 0);
    commit;\n`);
  const syncResult = await sync.finished;
  assert.equal(syncResult.code, 0, syncResult.errors);
  assert.match(syncResult.output, /"status": "applied"/);
  const lateResult = await lateWriter.finished;
  assert.notEqual(lateResult.code, 0);
  assert.match(lateResult.errors, /STORE_DEVICE_LOCKED/);
});
