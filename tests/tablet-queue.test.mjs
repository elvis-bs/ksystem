import assert from "node:assert/strict";
import test from "node:test";
import { TabletQueue } from "../local/tablet-queue.mjs";

function storage() {
  const entries = new Map();
  return {
    getItem: key => entries.has(key) ? entries.get(key) : null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key)
  };
}
const identity = { businessId: "store", staffId: "staff" };
const command = { commandId: "command", tableId: "table", expectedOrderId: null, items: [{ productId: "p" }] };

test("lost response survives reload and retries the identical command", async () => {
  const data = storage();
  let first = new TabletQueue(data, async () => { throw new Error("Conexão perdida"); });
  first.prepare(identity, command);
  await assert.rejects(first.retry(identity), /Conexão perdida/);
  const requests = [];
  first = new TabletQueue(data, async request => {
    requests.push(request);
    return { tableId: "table", orderId: "order", total: 25 };
  });
  assert.throws(() => first.prepare(identity, command), /pendente/);
  await assert.rejects(first.retry({ businessId: "store", staffId: "other" }), /mesmo funcionário/);
  await assert.rejects(first.retry({ businessId: "other", staffId: "staff" }), /mesma loja/);
  assert.deepEqual(await first.retry(identity), { tableId: "table", orderId: "order", total: 25 });
  assert.deepEqual(requests, [command]);
  assert.equal(first.read(), null);
});

test("invalid responses, server errors and failed local storage never discard pending orders", async () => {
  const data = storage();
  const queue = new TabletQueue(data, async () => ({ tableId: "wrong", orderId: "order", total: 3 }));
  queue.prepare(identity, command);
  await assert.rejects(queue.retry(identity), /Resposta inválida/);
  assert.deepEqual(queue.read().command, command);
  queue.send = async () => { throw new Error("conflito"); };
  await assert.rejects(queue.retry(identity), /conflito/);
  assert.deepEqual(queue.read().command, command);
  const unavailable = new TabletQueue({ ...storage(), setItem() { throw new Error("disco cheio"); } }, async () => {});
  assert.throws(() => unavailable.prepare(identity, command), /disco cheio/);
});

test("rejects simultaneous retry and preserves order until confirmation", async () => {
  const data = storage();
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const queue = new TabletQueue(data, async () => gate);
  queue.prepare(identity, command);
  const ongoing = queue.retry(identity);
  await assert.rejects(queue.retry(identity), /andamento/);
  assert.deepEqual(queue.read().command, command);
  resolve({ tableId: "table", orderId: "order", total: 0 });
  await ongoing;
  assert.equal(queue.read(), null);
});
