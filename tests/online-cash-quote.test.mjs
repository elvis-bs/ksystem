import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";
import { createOnlineCashQuoteRemote, readReservedOnlineCashQuote } from "../local/online-cash-quote.mjs";

const credential = "a".repeat(64);
const commandId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const request = { sessionId: "cash", counted: 10, notes: "" };
const snapshot = () => ({ products: [], ingredients: [], sales: [], financeEntries: [], onlineOrderPayments: [],
  cashSessions: [{ id: "cash", openedAt: "2026-01-01T10:00:00Z", openingAmount: 10 }] });
const order = () => ({ id: "order", paymentMethod: "pix", paymentStatus: "approved", status: "Recebido",
  total: 10, createdAt: "2026-01-01T10:00:00Z", paidAt: "2026-01-01T11:00:00Z", paymentIdHash: "a".repeat(64) });
const ready = () => ({ status: "ready", operationId: commandId, sessionId: "cash", revision: 3,
  quotedAt: "2026-01-01T12:00:00Z", snapshot: snapshot(), orders: [order()] });

test("remote quote validates identities, revisions and complete payment data", async () => {
  let result = ready();
  const calls = [];
  const remote = createOnlineCashQuoteRemote({ async rpc(name, args) {
    calls.push({ name, args });
    return { data: result, error: null };
  } }, credential);
  const query = { operationId: commandId, sessionId: "cash", expectedRevision: 3 };
  assert.deepEqual(await remote.quote(query), ready());
  assert.deepEqual(calls[0], { name: "experimental_quote_online_cash_close", args: {
    p_credential: credential, p_operation_id: commandId, p_session_id: "cash", p_expected_revision: 3
  } });
  for (const bad of [
    { ...ready(), revision: 4 }, { ...ready(), sessionId: "wrong" }, { ...ready(), operationId: "wrong" },
    { ...ready(), quotedAt: "invalid" }, { ...ready(), orders: [order(), order()] },
    { ...ready(), orders: [{ ...order(), paymentIdHash: "wrong" }] },
    { ...ready(), orders: [{ ...order(), total: 1.001 }] },
    { status: "conflict", operationId: commandId, revision: 3 }
  ]) {
    result = bad;
    await assert.rejects(remote.quote(query), /Invalid/);
  }
  result = { status: "conflict", operationId: commandId, revision: 4 };
  assert.deepEqual(await remote.quote(query), result);
  await assert.rejects(createOnlineCashQuoteRemote({ rpc: async () => ({ error: { message: "offline" } }) },
    credential).quote(query), /offline/);
});

test("lost quote response keeps the same reservation for safe retry and checks local and remote snapshots", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", snapshot(), 3);
  let count = 0;
  const calls = [];
  const remote = createOnlineCashQuoteRemote({ async rpc(name, args) {
    calls.push(args);
    if (++count === 1) throw new Error("resposta perdida");
    return { data: ready(), error: null };
  } }, credential);
  await assert.rejects(readReservedOnlineCashQuote(store, "store", commandId, request, 0, remote), /resposta perdida/);
  assert.equal(store.pendingOnlineCashClose("store").phase, "prepared");
  assert.throws(() => store.save("store", snapshot(), 0), /awaiting confirmation/);
  assert.deepEqual(await readReservedOnlineCashQuote(store, "store", commandId, request, 0, remote), ready());
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(store.read("store").snapshot.cashSessions[0].closedAt, undefined);
  const changed = ready();
  changed.snapshot.sales.push({ id: "different" });
  await assert.rejects(readReservedOnlineCashQuote(store, "store", commandId, request, 0,
    { quote: async () => changed }), /differs/);
  assert.equal(store.pendingOnlineCashClose("store").phase, "prepared");
});

test("revoked authorization and cancelled reservation never return a quote as valid", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", snapshot(), 3);
  let calls = 0;
  await assert.rejects(readReservedOnlineCashQuote(store, "store", commandId, request, 0,
    { quote: async () => ready() }, () => { if (++calls === 2) throw new Error("revoked"); }), /revoked/);
  await assert.rejects(readReservedOnlineCashQuote(store, "store", commandId, request, 0, { quote: async () => {
    store.cancelPreparedOnlineCashClose("store", commandId);
    return ready();
  } }), /reservation changed/);
  assert.equal(store.pendingOnlineCashClose("store"), null);
});

test("lost quote can be read with the same operation after the local process restarts", async t => {
  const dir = mkdtempSync(join(tmpdir(), "online-quote-restart-"));
  const filename = join(dir, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize("store", snapshot(), 3);
  const requests = [];
  let saved;
  const remote = createOnlineCashQuoteRemote({ async rpc(name, args) {
    requests.push(args);
    if (!saved) { saved = ready(); throw new Error("response lost"); }
    return { data: saved, error: null };
  } }, credential);
  await assert.rejects(readReservedOnlineCashQuote(store, "store", commandId, request, 0, remote), /response lost/);
  store.close();
  store = new OfflineStore(filename);
  assert.deepEqual(await readReservedOnlineCashQuote(store, "store", commandId, request, 0, remote), saved);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(store.read("store").snapshot.cashSessions[0].closedAt, undefined);
});

test("a UUID returned in PostgreSQL's lowercase form matches an uppercase operation ID", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", snapshot(), 3);
  const remote = createOnlineCashQuoteRemote({ async rpc() {
    return { data: ready(), error: null };
  } }, credential);
  assert.deepEqual(await readReservedOnlineCashQuote(store, "store", commandId.toUpperCase(), request, 0, remote), ready());
  assert.equal(store.pendingOnlineCashClose("store").commandId, commandId.toUpperCase());
});
