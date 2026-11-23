import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const container = process.env.OFFLINE_TEST_PG_CONTAINER;
const business = "66666666-6666-6666-6666-666666666666";
const credential = "d".repeat(64);
const first = "66666666-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const second = "66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function sql(query) {
  const result = spawnSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt",
    "-v", "ON_ERROR_STOP=1", "-U", "postgres"], { input: query, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function session(t, name, query) {
  const child = spawn("docker", ["exec", "-i", container, "psql", "-X", "-qAt",
    "-v", "ON_ERROR_STOP=1", "-U", "postgres"], { stdio: "pipe" });
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

const auth = `set role authenticated; select set_config('request.jwt.claim.sub','${business}',false);`;
const quote = id => `select public.experimental_quote_online_cash_close('${credential}','${id}','cash',0);`;
const close = id => `select public.experimental_close_online_cash('${credential}','${id}','cash',0,10,'');`;

test("close serializes payment changes, preserves replays and captures subsequent changes",
  { skip: !container, timeout: 60000 }, async t => {
    sql(`insert into auth.users values ('${business}');
      insert into public.business_data (user_id,data) values ('${business}',
        '{"products":[],"ingredients":[],"sales":[],"financeEntries":[],"onlineOrderPayments":[],
          "cashSessions":[{"id":"cash","openedAt":"2026-01-01T10:00:00Z","openingAmount":0}]}');
      insert into public.online_orders (business_id,order_data,total,payment_status,paid_at)
        values ('${business}','{"paymentMethod":"pix"}',10,'approved','2026-01-01T11:00:00Z');
      ${auth} select public.experimental_enable_store_presence('${credential}'); ${quote(first)}`);
    const writer = session(t, "close_payment_before", `begin;
      update public.online_orders set total = 11 where business_id = '${business}'; \\echo READY`);
    await waitFor(() => writer.output().includes("READY"), "Payment update did not start");
    const closing = session(t, "close_waiting_payment", `${auth} ${close(first)}`);
    closing.child.stdin.end();
    await waitFor(() => sql("select count(*) from pg_stat_activity where application_name = 'close_waiting_payment' and wait_event_type = 'Lock';") === "1",
      "Close did not wait for payment");
    writer.child.stdin.end("commit;\n");
    assert.equal((await writer.finished).code, 0);
    const conflict = await closing.finished;
    assert.equal(conflict.code, 0, conflict.errors);
    assert.match(conflict.output, /"reason": "payments-changed"/);
    sql(`${auth} ${quote(second)}`);
    const closeFirst = session(t, "close_before_payment", `${auth} begin; ${close(second)} \\echo READY`);
    await waitFor(() => closeFirst.output().includes("READY"), "Close did not start");
    const later = session(t, "close_payment_waiting", `update public.online_orders set payment_status = 'refunded'
      where business_id = '${business}';`);
    later.child.stdin.end();
    await waitFor(() => sql("select count(*) from pg_stat_activity where application_name = 'close_payment_waiting' and wait_event_type = 'Lock';") === "1",
      "Payment did not wait for close");
    const replay = session(t, "close_retry_waiting", `${auth} ${close(second)}`);
    replay.child.stdin.end();
    closeFirst.child.stdin.end("commit;\n");
    const closed = await closeFirst.finished;
    const retry = await replay.finished;
    const payment = await later.finished;
    assert.equal(closed.code, 0, closed.errors);
    assert.equal(retry.code, 0, retry.errors);
    assert.equal(payment.code, 0, payment.errors);
    assert.match(closed.output, /"status": "closed"/);
    const resultLine = output => output.split("\n").find(line => line.includes('"status": "closed"'));
    assert.deepEqual(JSON.parse(resultLine(retry.output)), JSON.parse(resultLine(closed.output)));
    assert.equal(sql(`select count(*) from public.experimental_cash_adjustment_candidates
      where business_id = '${business}' and checkpoint_id = '${second}';`), "1");
    assert.equal(sql(`select sync_revision from public.business_data where user_id = '${business}';`), "1");
  });
