import assert from "node:assert/strict";
import test from "node:test";
import { compareCashCheckpoint, compareProvisionalCash, createCashReviewRemote } from "../local/cash-review.mjs";

const credential = "a".repeat(64);
const order = () => ({ id: "order", paymentMethod: "pix", paymentStatus: "pending",
  status: "Aguardando Pix", total: 25.5, createdAt: "2026-01-01T10:00:00Z", paidAt: null });

test("checkpoint compares local recorded totals with its captured base and online orders", () => {
  const snapshot = {
    cashSessions: [{ id: "cash", openedAt: "2026-01-01T10:00:00Z", closedAt: "2026-01-01T12:00:00Z",
      openingAmount: 10, offlineClosureStatus: "provisional",
      offlineProvisional: { localExpected: 20, localReceived: 10, localByMethod: [{ payment: "Dinheiro", amount: 10 }] } }],
    sales: [{ id: "sale", paid: true, payment: "Dinheiro", total: 10, cashSessionId: "cash" }],
    financeEntries: [], onlineOrderPayments: []
  };
  const orders = [{ ...order(), paymentStatus: "approved", paidAt: "2026-01-01T11:00:00Z" }];
  const result = compareCashCheckpoint(snapshot, "cash", orders);
  assert.equal(result.localChanged, false);
  assert.equal(result.summary.onlineReceived, 25.5);
  assert.equal(result.summary.estimatedExpected, 45.5);
  assert.deepEqual(result.byMethod, [{ payment: "Dinheiro", amount: 10 }, { payment: "Pix", amount: 25.5 }]);
  assert.deepEqual(result.onlineReceipts, [{ orderId: "order", method: "Pix", amount: 25.5, source: "pix" }]);
  snapshot.sales[0].total = 11;
  assert.equal(compareCashCheckpoint(snapshot, "cash", orders).localChanged, true);
  snapshot.sales[0].total = 10;
  snapshot.sales[0].payment = "Pix";
  assert.equal(compareCashCheckpoint(snapshot, "cash", orders).localChanged, true);
  snapshot.cashSessions[0].offlineProvisional.localByMethod = [{ payment: "Dinheiro", amount: null }];
  assert.throws(() => compareCashCheckpoint(snapshot, "cash", orders), /Invalid recorded/);
});

test("checkpoint breaks down online manual and Pix receipts by method without resolving conflicts", () => {
  const snapshot = {
    cashSessions: [{ id: "cash", openedAt: "2026-01-01T10:00:00Z", closedAt: "2026-01-01T12:00:00Z",
      openingAmount: 10, offlineClosureStatus: "provisional",
      offlineProvisional: { localExpected: 20, localReceived: 10, localByMethod: [{ payment: "Dinheiro", amount: 10 }] } }],
    sales: [{ id: "sale", paid: true, payment: "Dinheiro", total: 10, cashSessionId: "cash" }],
    financeEntries: [], onlineOrderPayments: [
      { onlineOrderId: "manual", cashSessionId: "cash", method: "Dinheiro na entrega" },
      { onlineOrderId: "both", cashSessionId: "cash", method: "Cartão de crédito" }
    ]
  };
  const orders = [
    { ...order(), paymentStatus: "approved", paidAt: "2026-01-01T11:00:00Z" },
    { ...order(), id: "manual", paymentMethod: "cash_on_delivery", total: 3.25 },
    { ...order(), id: "both", paymentStatus: "approved", paidAt: "2026-01-01T11:00:00Z", total: 5 }
  ];
  const result = compareCashCheckpoint(snapshot, "cash", orders);
  assert.equal(result.summary.estimatedExpected, 53.75);
  assert.deepEqual(result.byMethod, [
    { payment: "Dinheiro", amount: 13.25 }, { payment: "Pix", amount: 25.5 },
    { payment: "Cartão de crédito", amount: 5 }
  ]);
  assert.deepEqual(result.onlineReceipts, [
    { orderId: "order", method: "Pix", amount: 25.5, source: "pix" },
    { orderId: "manual", method: "Dinheiro", amount: 3.25, source: "manual" },
    { orderId: "both", method: "Cartão de crédito", amount: 5, source: "manual" }
  ]);
  assert.deepEqual(result.issues, [{ type: "manual-pix-conflict", orderId: "both" }]);
  snapshot.onlineOrderPayments[0].method = "";
  assert.throws(() => compareCashCheckpoint(snapshot, "cash", orders), /no payment method/);
});

test("review fetches the complete server response with the device credential", async () => {
  const remote = createCashReviewRemote({ async rpc(name, args) {
    assert.equal(name, "experimental_cash_review");
    assert.deepEqual(args, { p_credential: credential });
    return { data: { orders: [order()], events: [] }, error: null };
  } }, credential);
  assert.deepEqual(await remote.readOrders(), { orders: [order()], events: [] });
});

test("comparison includes matching Pix and manual receipts once and reports unresolved cases", () => {
  const snapshot = {
    cashSessions: [{ id: "cash", openedAt: "2026-01-01T10:00:00Z", closedAt: "2026-01-01T12:00:00Z",
      offlineClosureStatus: "provisional", offlineProvisional: { localExpected: 50 } }],
    onlineOrderPayments: [{ onlineOrderId: "cash-order", cashSessionId: "cash", method: "Dinheiro" },
      { onlineOrderId: "missing", cashSessionId: "cash", method: "Pix" }],
    financeEntries: [], sales: []
  };
  const orders = [
    { ...order(), id: "pix", paymentStatus: "approved", paidAt: "2026-01-01T11:00:00Z", total: 25.5 },
    { ...order(), id: "cash-order", paymentMethod: "cash_on_delivery", total: 10 },
    { ...order(), id: "pending" },
    { ...order(), id: "refund", paymentStatus: "refunded" },
    { ...order(), id: "undated", paymentStatus: "approved" }
  ];
  const result = compareProvisionalCash(snapshot, orders);
  assert.equal(result.final, false);
  assert.deepEqual(result.summaries, [{ sessionId: "cash", localExpected: 50, onlineReceived: 35.5,
    estimatedExpected: 85.5, includedOrderIds: ["pix", "cash-order"] }]);
  assert.deepEqual(result.issues, [
    { type: "missing-order", orderId: "missing" }, { type: "pending-pix", orderId: "pending" },
    { type: "refunded", orderId: "refund" }, { type: "missing-payment-date", orderId: "undated" }
  ]);
  snapshot.financeEntries.push({ kind: "receivable", saleId: "online-pix" });
  assert.equal(compareProvisionalCash(snapshot, orders).summaries[0].onlineReceived, 10);
});

test("comparison fails on duplicate payments, incomplete local data and ambiguous session dates", () => {
  const session = { id: "cash", openedAt: "2026-01-01T10:00:00Z", closedAt: "2026-01-01T12:00:00Z",
    offlineClosureStatus: "provisional", offlineProvisional: { localExpected: 10 } };
  const snapshot = { cashSessions: [session], onlineOrderPayments: [], financeEntries: [], sales: [] };
  const paid = { ...order(), paymentStatus: "approved", paidAt: "2026-01-01T11:00:00Z" };
  assert.throws(() => compareProvisionalCash({ ...snapshot, onlineOrderPayments: undefined }, [paid]), /Incomplete/);
  assert.throws(() => compareProvisionalCash({ ...snapshot, onlineOrderPayments: [
    { onlineOrderId: "order" }, { onlineOrderId: "order" }
  ] }, [paid]), /duplicate/);
  assert.throws(() => compareProvisionalCash({ ...snapshot, cashSessions: [session, { ...session, id: "other" }] },
    [paid]), /Ambiguous/);
});

test("comparison flags unassigned, missing and locally duplicated payments", () => {
  const session = { id: "cash", openedAt: "2026-01-01T10:00:00Z", closedAt: "2026-01-01T12:00:00Z",
    offlineClosureStatus: "provisional", offlineProvisional: { localExpected: 10 } };
  const snapshot = { cashSessions: [session], sales: [{ id: "online-duplicate" }], financeEntries: [],
    onlineOrderPayments: [
      { onlineOrderId: "missing-session", cashSessionId: "unknown" },
      { onlineOrderId: "manual", paidAt: "2026-01-01T11:00:00Z" }
    ] };
  const orders = [
    { ...order(), id: "outside", paymentStatus: "approved", paidAt: "2026-01-01T13:00:00Z" },
    { ...order(), id: "duplicate", paymentStatus: "approved", paidAt: "2026-01-01T11:00:00Z" },
    { ...order(), id: "missing-session", paymentMethod: "cash_on_delivery" },
    { ...order(), id: "manual", paymentMethod: "cash_on_delivery" }
  ];
  const result = compareProvisionalCash(snapshot, orders);
  assert.equal(result.summaries[0].onlineReceived, 25.5);
  assert.deepEqual(result.issues, [
    { type: "unassigned-payment", orderId: "outside" },
    { type: "duplicate-local-sale", orderId: "duplicate" },
    { type: "missing-session", orderId: "missing-session" }
  ]);
});

test("comparison warns about approved Pix with a manual payment and linked receivables", () => {
  const snapshot = {
    cashSessions: [{ id: "cash", openedAt: "2026-01-01T10:00:00Z", closedAt: "2026-01-01T12:00:00Z",
      offlineClosureStatus: "provisional", offlineProvisional: { localExpected: 10 } }],
    sales: [], financeEntries: [{ kind: "receivable", saleId: "online-order" }],
    onlineOrderPayments: [{ onlineOrderId: "order", cashSessionId: "cash", method: "Dinheiro" }]
  };
  const approved = { ...order(), paymentStatus: "approved", paidAt: "2026-01-01T11:00:00Z" };
  const result = compareProvisionalCash(snapshot, [approved]);
  assert.deepEqual(result.issues, [
    { type: "manual-pix-conflict", orderId: "order" },
    { type: "linked-receivable", orderId: "order" }
  ]);
  assert.equal(result.summaries[0].onlineReceived, 0);
  assert.equal(result.final, false);
});

test("remote errors, incomplete results, duplicate and invalid orders fail explicitly", async () => {
  assert.throws(() => createCashReviewRemote({}, credential), /client/);
  assert.throws(() => createCashReviewRemote({ rpc() {} }, "bad"), /credential/);
  await assert.rejects(createCashReviewRemote({ rpc: async () => ({ error: { message: "offline" } }) },
    credential).readOrders(), /offline/);
  for (const data of [
    null, {}, { orders: [] }, { orders: [order(), order()], events: [] },
    { orders: [{ ...order(), total: -1 }], events: [] },
    { orders: [{ ...order(), total: 1.001 }], events: [] }, { orders: [{ ...order(), paidAt: "invalid" }], events: [] },
    { orders: [{ ...order(), paymentMethod: null }], events: [] },
    { orders: [], events: [{ orderId: "x", operation: "update", before: null, after: null, observedAt: "2026-01-01" }] }
  ]) {
    await assert.rejects(createCashReviewRemote({ rpc: async () => ({ data, error: null }) },
      credential).readOrders(), /Invalid/);
  }
});

test("review returns an audited payment change and rejects malformed history", async () => {
  const payment = { paymentStatus: "approved", paidAt: "2026-01-01T11:00:00Z",
    hasPaymentId: true, paymentMethod: "pix", total: 25.5 };
  const event = { orderId: "order", operation: "update", before: payment,
    after: { ...payment, paymentStatus: "refunded" }, observedAt: "2026-01-01T12:00:00Z" };
  const read = events => createCashReviewRemote({ rpc: async () => ({
    data: { orders: [order()], events }, error: null
  }) }, credential).readOrders();
  assert.deepEqual((await read([event])).events, [event]);
  await assert.rejects(read([{ ...event, after: { ...payment, total: 1.001 } }]), /Invalid payment event/);
  await assert.rejects(read([{ ...event, operation: "delete", after: payment }]), /Invalid payment event/);
});

test("checkpoint reuses its identifier and validates both remote responses", async () => {
  const calls = [];
  const request = { checkpointId: "checkpoint", sessionId: "cash", closedAt: "2026-01-01T12:00:00Z" };
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === "experimental_create_cash_checkpoint") {
      return { data: { checkpointId: "checkpoint", orders: [order()] }, error: null };
    }
    return { data: { events: [] }, error: null };
  } };
  const remote = createCashReviewRemote(client, credential);
  assert.deepEqual(await remote.readCheckpoint(request), { orders: [order()], events: [] });
  assert.deepEqual(await remote.readCheckpoint(request), { orders: [order()], events: [] });
  assert.deepEqual(calls[0], calls[2]);
  assert.deepEqual(calls[0].args, { p_credential: credential, p_checkpoint_id: "checkpoint",
    p_session_id: "cash", p_closed_at: request.closedAt });
  assert.deepEqual(calls[1].args, { p_credential: credential, p_checkpoint_id: "checkpoint" });
  await assert.rejects(createCashReviewRemote({ rpc: async () => ({
    data: { checkpointId: "different", orders: [] }, error: null
  }) }, credential).readCheckpoint(request), /Invalid cash checkpoint/);
  await assert.rejects(createCashReviewRemote({ rpc: async name => name === "experimental_create_cash_checkpoint"
    ? { data: { checkpointId: "checkpoint", orders: [] }, error: null }
    : { data: {}, error: null } }, credential).readCheckpoint(request), /Invalid online cash review/);
});

test("checkpoint adjustment events require unique stable string identifiers", async () => {
  const payment = { paymentStatus: "approved", paidAt: "2026-01-01T11:00:00Z",
    hasPaymentId: true, paymentMethod: "pix", total: 25.5 };
  const event = { eventId: "9007199254740993", decision: null, orderId: "order", operation: "update", before: payment,
    after: { ...payment, paymentStatus: "refunded" }, observedAt: "2026-01-01T12:00:00Z" };
  const read = events => createCashReviewRemote({ rpc: async name => name === "experimental_create_cash_checkpoint"
    ? { data: { checkpointId: "checkpoint", orders: [] }, error: null }
    : { data: { events }, error: null } }, credential)
    .readCheckpoint({ checkpointId: "checkpoint", sessionId: "cash", closedAt: "2026-01-01T12:00:00Z" });
  assert.deepEqual((await read([event])).events, [event]);
  for (const bad of [undefined, 1, "0", "01", "-1", "1.5"]) {
    await assert.rejects(read([{ ...event, eventId: bad }]), /event ID/);
  }
  await assert.rejects(read([event, event]), /duplicate cash adjustment event ID/);
  await assert.rejects(read([{ ...event, decision: undefined }]), /Invalid cash adjustment decision/);
  await assert.rejects(read([{ ...event, decision: { decisionId: "bad", classification: "this-session",
    notes: "ok", recordedAt: "2026-01-01" } }]), /Invalid cash adjustment decision/);
});

test("decision requests preserve operation and version identity and validate the response", async () => {
  const command = { checkpointId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    eventId: "9007199254740993", commandId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    expectedDecisionId: null, classification: "this-session", notes: "Conferido" };
  let answer = { status: "recorded", operationId: command.commandId, eventId: command.eventId };
  const calls = [];
  const remote = createCashReviewRemote({ rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: answer, error: null };
  } }, credential);
  assert.deepEqual(await remote.decideAdjustment(command), answer);
  assert.deepEqual(calls[0], { name: "experimental_decide_cash_adjustment", args: {
    p_credential: credential, p_checkpoint_id: command.checkpointId, p_event_id: command.eventId,
    p_operation_id: command.commandId, p_expected_decision_id: null,
    p_classification: "this-session", p_notes: "Conferido"
  } });
  answer = { ...answer, status: "conflict" };
  assert.deepEqual(await remote.decideAdjustment(command), answer);
  answer = { ...answer, eventId: "1" };
  await assert.rejects(remote.decideAdjustment(command), /Invalid cash adjustment decision response/);
  await assert.rejects(remote.decideAdjustment({ ...command, notes: "   " }), /Invalid cash adjustment decision/);
});
