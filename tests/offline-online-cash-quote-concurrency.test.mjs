import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const container = process.env.OFFLINE_TEST_PG_CONTAINER;
const store = "99999999-9999-9999-9999-999999999999";
const credential = "c".repeat(64);

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

test("online cash quote serializes with payment writes and preserves its first response",
  { skip: !container, timeout: 30000 }, async t => {
    sql(`insert into auth.users values ('${store}');
      insert into public.business_data (user_id, data)
        values ('${store}', '{"products":[],"ingredients":[],"sales":[],"cashSessions":[{"id":"cash","openedAt":"2026-01-01T10:00:00Z"}]}');
      insert into public.online_orders (business_id,order_data,total)
        values ('${store}','{"paymentMethod":"pix"}',10);
      set role authenticated;
      select set_config('request.jwt.claim.sub','${store}',false);
      select public.experimental_enable_store_presence('${credential}');`);
    const writer = session(t, "quote_payment_before", `begin;
      update public.online_orders set payment_status = 'approved' where business_id = '${store}';
      \\echo READY`);
    await waitFor(() => writer.output().includes("READY"), "Payment writer did not start");
    const quote = session(t, "quote_waiting_payment", `set role authenticated;
      select set_config('request.jwt.claim.sub','${store}',false);
      select public.experimental_quote_online_cash_close('${credential}',
        '99999999-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cash',0);`);
    quote.child.stdin.end();
    await waitFor(() => sql("select count(*) from pg_stat_activity where application_name = 'quote_waiting_payment' and wait_event_type = 'Lock';") === "1",
      "Quote did not wait for payment");
    writer.child.stdin.end("commit;\n");
    const writerResult = await writer.finished;
    const quoteResult = await quote.finished;
    assert.equal(writerResult.code, 0, writerResult.errors);
    assert.equal(quoteResult.code, 0, quoteResult.errors);
    assert.match(quoteResult.output, /"paymentStatus": "approved"/);

    const quoteFirst = session(t, "quote_before_payment", `set role authenticated;
      select set_config('request.jwt.claim.sub','${store}',false);
      begin; select public.experimental_quote_online_cash_close('${credential}',
        '99999999-bbbb-bbbb-bbbb-bbbbbbbbbbbb','cash',0); \\echo READY`);
    await waitFor(() => quoteFirst.output().includes("READY"), "Quote did not start");
    const later = session(t, "quote_payment_waiting", `update public.online_orders set payment_status = 'refunded'
      where business_id = '${store}';`);
    later.child.stdin.end();
    await waitFor(() => sql("select count(*) from pg_stat_activity where application_name = 'quote_payment_waiting' and wait_event_type = 'Lock';") === "1",
      "Payment did not wait for quote");
    quoteFirst.child.stdin.end("commit;\n");
    const quoteFirstResult = await quoteFirst.finished;
    const laterResult = await later.finished;
    assert.equal(quoteFirstResult.code, 0, quoteFirstResult.errors);
    assert.match(quoteFirstResult.output, /"paymentStatus": "approved"/);
    assert.equal(laterResult.code, 0, laterResult.errors);
    assert.match(sql(`set role authenticated; select set_config('request.jwt.claim.sub','${store}',false);
      select public.experimental_quote_online_cash_close('${credential}',
        '99999999-bbbb-bbbb-bbbb-bbbbbbbbbbbb','cash',0);`), /"paymentStatus": "approved"/);
    assert.equal(sql(`select payment_status from public.online_orders where business_id = '${store}';`), "refunded");
  });
