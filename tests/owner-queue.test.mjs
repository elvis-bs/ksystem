import assert from "node:assert/strict";
import test from "node:test";
import { OwnerQueue } from "../local/owner-queue.mjs";

function storage() {
  const entries = new Map();
  return {
    getItem: key => entries.has(key) ? entries.get(key) : null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key)
  };
}

test("lost sale response is retried with the identical command after reload", async () => {
  const data = storage();
  const command = { commandId: "sale-1", paid: true, items: [{ productId: "p1" }] };
  const first = new OwnerQueue(data, async () => { throw new Error("offline"); });
  first.prepare("store", "/api/owner/sale", command);
  await assert.rejects(first.retry("store"), /offline/);
  const second = new OwnerQueue(data, async (path, sent) => {
    assert.equal(path, "/api/owner/sale");
    assert.deepEqual(sent, command);
    return { saleId: "sale", total: 10, cashSessionId: "cash" };
  });
  await assert.rejects(second.retry("other"), /mesma loja/);
  assert.throws(() => second.prepare("store", "/api/owner/sale", command), /pendente/);
  assert.equal((await second.retry("store")).saleId, "sale");
  assert.equal(second.read(), null);
});

test("invalid results, corrupt state and storage failure never discard pending operation", async () => {
  const data = storage();
  const queue = new OwnerQueue(data, async () => ({ saleId: "sale", total: 10, cashSessionId: null }));
  queue.prepare("store", "/api/owner/sale", { commandId: "sale", paid: true });
  await assert.rejects(queue.retry("store"), /Resposta inválida/);
  assert.equal(queue.read().command.commandId, "sale");
  data.setItem("bora-owner-pending-v1", '{"businessId":"store","path":"invalid"}');
  assert.throws(() => queue.read(), /inválida/);
  const unavailable = new OwnerQueue({ ...storage(), setItem() { throw new Error("disco cheio"); } }, async () => {});
  assert.throws(() => unavailable.prepare("store", "/api/owner/open-cash", { commandId: "cash" }), /disco cheio/);
});

test("all owner actions verify result identity and prevent simultaneous retries", async () => {
  const cases = [
    ["/api/owner/open-cash", { commandId: "open" }, { cashSessionId: "cash" }],
    ["/api/owner/provisional-close-cash", { commandId: "close-cash", sessionId: "cash" },
      { sessionId: "cash", status: "provisional", localExpected: 10, localReceived: 0 }],
    ["/api/owner/create-table", { commandId: "create" }, { tableId: "table" }],
    ["/api/owner/close-table", { commandId: "close", tableId: "table", orderId: "order" },
      { tableId: "table", orderId: "order", saleId: "sale", total: 5 }]
  ];
  for (const [path, command, result] of cases) {
    const data = storage();
    let finish;
    const queue = new OwnerQueue(data, () => new Promise(resolve => { finish = resolve; }));
    queue.prepare("store", path, command);
    const running = queue.retry("store");
    await assert.rejects(queue.retry("store"), /andamento/);
    finish(result);
    assert.deepEqual(await running, result);
    assert.equal(queue.read(), null);
  }
});

test("quoted sale accepts only matching confirmation or a durable rejection", async () => {
  const data = storage();
  const command = { commandId: "quoted", paid: true, expectedSessionId: "cash", expectedTotal: 20 };
  let result = { status: "recorded", saleId: "sale", cashSessionId: "cash", total: 21 };
  const queue = new OwnerQueue(data, async () => result);
  queue.prepare("store", "/api/owner/quoted-sale", command);
  await assert.rejects(queue.retry("store"), /Resposta inválida/);
  assert.equal(queue.read().command.commandId, "quoted");
  result = { status: "rejected", reason: "changed" };
  assert.deepEqual(await queue.retry("store"), result);
  assert.equal(queue.read(), null);
});

test("quoted cash results require session identity and allow durable rejection", async () => {
  const data = storage();
  let result = { status: "provisional", sessionId: "other", localExpected: 15, localReceived: 5 };
  const queue = new OwnerQueue(data, async () => result);
  queue.prepare("store", "/api/owner/quoted-provisional-close", { commandId: "close", sessionId: "cash" });
  await assert.rejects(queue.retry("store"), /Resposta inválida/);
  result = { ...result, sessionId: "cash" };
  assert.deepEqual(await queue.retry("store"), result);
  queue.prepare("store", "/api/owner/quoted-open-cash", { commandId: "open" });
  result = { status: "rejected", reason: "changed" };
  assert.deepEqual(await queue.retry("store"), result);
  assert.equal(queue.read(), null);
});

test("legacy close queues accept a durable disabled-policy rejection", async () => {
  for (const path of ["/api/owner/quoted-provisional-close", "/api/owner/provisional-close-cash"]) {
    const data = storage();
    const queue = new OwnerQueue(data, async () => ({ status: "rejected", reason: "online-close-unavailable" }));
    queue.prepare("store", path, { commandId: "close", sessionId: "cash" });
    assert.deepEqual(await queue.retry("store"), { status: "rejected", reason: "online-close-unavailable" });
    assert.equal(queue.read(), null);
  }
});

test("cash decision retry keeps the same operation until recorded or a durable conflict", async () => {
  const data = storage();
  const command = { commandId: "decision", sessionId: "cash", eventId: "123", expectedDecisionId: null,
    classification: "this-session", notes: "Conferido" };
  const first = new OwnerQueue(data, async () => { throw new Error("resposta perdida"); });
  first.prepare("store", "/api/owner/cash-decision", command);
  await assert.rejects(first.retry("store"), /resposta perdida/);
  let result = { status: "recorded", operationId: "other", eventId: "123" };
  const second = new OwnerQueue(data, async (path, sent) => {
    assert.equal(path, "/api/owner/cash-decision");
    assert.deepEqual(sent, command);
    return result;
  });
  await assert.rejects(second.retry("store"), /Resposta inválida/);
  assert.deepEqual(second.read().command, command);
  result = { status: "conflict", operationId: "decision", eventId: "123" };
  assert.deepEqual(await second.retry("store"), result);
  assert.equal(second.read(), null);
});
