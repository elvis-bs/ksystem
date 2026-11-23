import { provisionalCashSummary } from "./provisional-cash.mjs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateReview(data, { requireEventIds = false } = {}) {
  if (!data || !Array.isArray(data.orders) || data.orders.length > 10000
    || !Array.isArray(data.events) || data.events.length > 10000) {
    throw new Error("Invalid online cash review response");
  }
  const ids = new Set();
  for (const order of data.orders) {
    if (!order || typeof order.id !== "string" || !order.id || ids.has(order.id)
      || typeof order.paymentMethod !== "string" || !order.paymentMethod
      || typeof order.paymentStatus !== "string" || !order.paymentStatus
      || typeof order.status !== "string" || !order.status
      || typeof order.total !== "number" || !Number.isFinite(order.total) || order.total <= 0
      || !Number.isSafeInteger(Math.round(order.total * 100))
      || Math.abs(order.total * 100 - Math.round(order.total * 100)) > 1e-7
      || typeof order.createdAt !== "string" || !Number.isFinite(Date.parse(order.createdAt))
      || (order.paidAt !== null && (typeof order.paidAt !== "string" || !Number.isFinite(Date.parse(order.paidAt))))) {
      throw new Error("Invalid order in online cash review");
    }
    ids.add(order.id);
  }
  const validPayment = payment => payment === null || (
    payment && typeof payment === "object" && !Array.isArray(payment)
    && typeof payment.paymentStatus === "string" && payment.paymentStatus.length > 0
    && (payment.paidAt === null || typeof payment.paidAt === "string" && Number.isFinite(Date.parse(payment.paidAt)))
    && typeof payment.hasPaymentId === "boolean"
    && (payment.paymentMethod === null || typeof payment.paymentMethod === "string")
    && typeof payment.total === "number" && Number.isFinite(payment.total) && payment.total > 0
    && Number.isSafeInteger(Math.round(payment.total * 100))
    && Math.abs(payment.total * 100 - Math.round(payment.total * 100)) <= 1e-7
  );
  const eventIds = new Set();
  for (const event of data.events) {
    if (!event || typeof event.orderId !== "string" || !event.orderId
      || !["insert", "update", "delete"].includes(event.operation)
      || typeof event.observedAt !== "string" || !Number.isFinite(Date.parse(event.observedAt))
      || !validPayment(event.before) || !validPayment(event.after)
      || (event.operation === "insert" && (event.before !== null || event.after === null))
      || (event.operation === "delete" && (event.before === null || event.after !== null))
      || (event.operation === "update" && (event.before === null || event.after === null))) {
      throw new Error("Invalid payment event in online cash review");
    }
    if (requireEventIds) {
      if (typeof event.eventId !== "string" || !/^[1-9][0-9]*$/.test(event.eventId)
        || eventIds.has(event.eventId)) {
        throw new Error("Invalid or duplicate cash adjustment event ID");
      }
      eventIds.add(event.eventId);
      const decision = event.decision;
      if (decision !== null && (!decision || typeof decision !== "object"
        || typeof decision.decisionId !== "string" || !uuidPattern.test(decision.decisionId)
        || !["this-session", "other-session", "unresolved"].includes(decision.classification)
        || typeof decision.notes !== "string" || !decision.notes.trim() || decision.notes.length > 1000
        || typeof decision.recordedAt !== "string" || !Number.isFinite(Date.parse(decision.recordedAt)))) {
        throw new Error("Invalid cash adjustment decision");
      }
    }
  }
  return { orders: data.orders, events: data.events };
}

export function createCashReviewRemote(client, credential) {
  if (!client || typeof client.rpc !== "function") throw new TypeError("Supabase client is required");
  if (typeof credential !== "string" || !/^[0-9a-f]{64}$/.test(credential)) throw new TypeError("Invalid device credential");
  return {
    async readOrders() {
      const { data, error } = await client.rpc("experimental_cash_review", { p_credential: credential });
      if (error) throw new Error(`Online cash review failed: ${error.message}`, { cause: error });
      return validateReview(data);
    },
    async readCheckpoint({ checkpointId, sessionId, closedAt }) {
      const { data: checkpoint, error } = await client.rpc("experimental_create_cash_checkpoint", {
        p_credential: credential, p_checkpoint_id: checkpointId, p_session_id: sessionId, p_closed_at: closedAt
      });
      if (error) throw new Error(`Cash checkpoint failed: ${error.message}`, { cause: error });
      if (!checkpoint || checkpoint.checkpointId !== checkpointId) throw new Error("Invalid cash checkpoint response");
      const { data: candidates, error: candidateError } = await client.rpc("experimental_cash_checkpoint_candidates", {
        p_credential: credential, p_checkpoint_id: checkpointId
      });
      if (candidateError) throw new Error(`Cash checkpoint candidates failed: ${candidateError.message}`, { cause: candidateError });
      return validateReview({ orders: checkpoint.orders, events: candidates?.events }, { requireEventIds: true });
    },
    async decideAdjustment({ checkpointId, eventId, commandId, expectedDecisionId, classification, notes }) {
      if (!uuidPattern.test(checkpointId) || typeof eventId !== "string" || !/^[1-9][0-9]{0,18}$/.test(eventId)
        || !uuidPattern.test(commandId) || !(expectedDecisionId === null || typeof expectedDecisionId === "string" && uuidPattern.test(expectedDecisionId))
        || !["this-session", "other-session", "unresolved"].includes(classification)
        || typeof notes !== "string" || !notes.trim() || notes !== notes.trim() || notes.length > 1000) {
        throw new TypeError("Invalid cash adjustment decision");
      }
      const { data, error } = await client.rpc("experimental_decide_cash_adjustment", {
        p_credential: credential, p_checkpoint_id: checkpointId, p_event_id: eventId,
        p_operation_id: commandId, p_expected_decision_id: expectedDecisionId, p_classification: classification, p_notes: notes
      });
      if (error) throw new Error(`Cash adjustment decision failed: ${error.message}`, { cause: error });
      if (!data || !["recorded", "conflict"].includes(data.status)
        || data.operationId !== commandId || data.eventId !== eventId) {
        throw new Error("Invalid cash adjustment decision response");
      }
      return data;
    }
  };
}

function sessionForPaymentDate(sessions, date) {
  const time = Date.parse(date);
  if (!Number.isFinite(time)) throw new Error("Invalid online payment date");
  const matches = sessions.filter(candidate => {
    const opened = Date.parse(candidate.openedAt);
    const closed = candidate.closedAt ? Date.parse(candidate.closedAt) : Infinity;
    if (!Number.isFinite(opened) || (!Number.isFinite(closed) && closed !== Infinity)) {
      throw new Error("Invalid cash session date");
    }
    return time >= opened && time <= closed;
  });
  if (matches.length > 1) throw new Error("Ambiguous online payment cash session");
  return matches[0]?.id ?? null;
}

export function compareProvisionalCash(snapshot, orders) {
  if (!Array.isArray(snapshot.cashSessions) || !Array.isArray(snapshot.sales) || !Array.isArray(snapshot.onlineOrderPayments)
    || !Array.isArray(snapshot.financeEntries) || !Array.isArray(orders)) {
    throw new Error("Incomplete local reconciliation data");
  }

  const lookup = new Map(orders.map(order => [order.id, order]));
  if (lookup.size !== orders.length) throw new Error("Duplicate online order");
  const payments = new Map();
  for (const payment of snapshot.onlineOrderPayments) {
    if (!payment || typeof payment.onlineOrderId !== "string" || !payment.onlineOrderId
      || payments.has(payment.onlineOrderId)) throw new Error("Invalid or duplicate online payment");
    payments.set(payment.onlineOrderId, payment);
  }
  const linkedReceivables = new Set(snapshot.financeEntries
    .filter(entry => entry.kind === "receivable" && entry.saleId).map(entry => entry.saleId));
  const localSaleIds = new Set(snapshot.sales.map(sale => sale.id));
  const issues = [];
  for (const payment of payments.values()) {
    if (!lookup.has(payment.onlineOrderId)) issues.push({ type: "missing-order", orderId: payment.onlineOrderId });
  }
  for (const order of orders) {
    if (order.paymentMethod === "pix" && order.paymentStatus === "pending") {
      issues.push({ type: "pending-pix", orderId: order.id });
    } else if (order.paymentStatus === "refunded") {
      issues.push({ type: "refunded", orderId: order.id });
    } else if (!["pending", "approved", "rejected", "cancelled", "refunded", "failed"].includes(order.paymentStatus)) {
      issues.push({ type: "unknown-status", orderId: order.id });
    }
    const manual = payments.get(order.id);
    const paid = manual || (order.paymentMethod === "pix" && order.paymentStatus === "approved");
    if (!paid) continue;
    if (manual && order.paymentMethod === "pix" && order.paymentStatus === "approved") {
      issues.push({ type: "manual-pix-conflict", orderId: order.id });
    }
    if (localSaleIds.has(`online-${order.id}`)) {
      issues.push({ type: "duplicate-local-sale", orderId: order.id });
    }
    if (linkedReceivables.has(`online-${order.id}`)) {
      issues.push({ type: "linked-receivable", orderId: order.id });
    }
    if (manual?.cashSessionId && !snapshot.cashSessions.some(session => session.id === manual.cashSessionId)) {
      issues.push({ type: "missing-session", orderId: order.id });
    } else if (!manual?.cashSessionId) {
      const date = manual?.paidAt || order.paidAt;
      if (!date) issues.push({ type: "missing-payment-date", orderId: order.id });
      else if (!sessionForPaymentDate(snapshot.cashSessions, date)) {
        issues.push({ type: "unassigned-payment", orderId: order.id });
      }
    }
  }
  const sessions = snapshot.cashSessions.filter(session => session.offlineClosureStatus === "provisional");
  const summaries = sessions.map(session => {
    const start = Date.parse(session.openedAt);
    const end = Date.parse(session.closedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !session.offlineProvisional
      || !Number.isFinite(session.offlineProvisional.localExpected)) throw new Error("Invalid provisional cash session");
    let onlineCents = 0;
    const included = [];
    for (const order of orders) {
      const manual = payments.get(order.id);
      if (linkedReceivables.has(`online-${order.id}`) || localSaleIds.has(`online-${order.id}`)) continue;
      const pixPaid = order.paymentMethod === "pix" && order.paymentStatus === "approved";
      if (!pixPaid && !manual) continue;
      let belongs = manual?.cashSessionId === session.id;
      if (!manual?.cashSessionId && (manual?.paidAt || order.paidAt)) {
        belongs = sessionForPaymentDate(snapshot.cashSessions, manual?.paidAt || order.paidAt) === session.id;
      }

      if (!belongs) continue;
      const cents = Math.round(order.total * 100);
      if (!Number.isSafeInteger(cents) || cents <= 0 || Math.abs(order.total * 100 - cents) > 1e-7) {
        throw new Error("Invalid online order amount");
      }
      onlineCents += cents;
      if (!Number.isSafeInteger(onlineCents)) throw new Error("Online cash total too large");
      included.push(order.id);
    }
    const localCents = Math.round(session.offlineProvisional.localExpected * 100);
    if (!Number.isSafeInteger(localCents) || !Number.isSafeInteger(localCents + onlineCents)) {
      throw new Error("Cash estimate too large");
    }
    return { sessionId: session.id, localExpected: localCents / 100, onlineReceived: onlineCents / 100,
      estimatedExpected: (localCents + onlineCents) / 100, includedOrderIds: included };
  });
  return { summaries, issues, final: false };
}

export function compareCashCheckpoint(snapshot, sessionId, orders) {
  const sessions = snapshot.cashSessions.filter(session => session.id === sessionId);
  if (sessions.length !== 1 || sessions[0].offlineClosureStatus !== "provisional") {
    throw new Error("Valid provisional cash session is required");
  }
  const session = sessions[0];
  const comparison = compareProvisionalCash(snapshot, orders);
  const summary = comparison.summaries.find(item => item.sessionId === sessionId);
  if (!summary) throw new Error("Cash checkpoint summary is missing");
  const local = provisionalCashSummary(snapshot, session, session.closedAt);
  const recorded = session.offlineProvisional;
  const cents = value => {
    if (typeof value !== "number" || !Number.isFinite(value)
      || !Number.isSafeInteger(Math.round(value * 100))
      || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
      throw new Error("Invalid recorded provisional total");
    }
    return Math.round(value * 100);
  };
  if (!Array.isArray(recorded.localByMethod)) throw new Error("Invalid recorded provisional methods");
  const methods = items => {
    const result = new Map();
    for (const item of items) {
      if (!item || typeof item.payment !== "string" || !item.payment || result.has(item.payment)) {
        throw new Error("Invalid recorded provisional methods");
      }
      result.set(item.payment, cents(item.amount));
    }
    return result;
  };
  const expectedMethods = methods(recorded.localByMethod);
  const actualMethods = methods(local.byMethod);
  const localChanged = cents(recorded.localExpected) !== cents(local.expected)
    || cents(recorded.localReceived) !== cents(local.received)
    || expectedMethods.size !== actualMethods.size
    || [...expectedMethods].some(([method, amount]) => actualMethods.get(method) !== amount);
  const manualPayments = new Map(snapshot.onlineOrderPayments.map(payment => [payment.onlineOrderId, payment]));
  const ordersById = new Map(orders.map(order => [order.id, order]));
  const totals = new Map(expectedMethods);
  const onlineReceipts = summary.includedOrderIds.map(orderId => {
    const order = ordersById.get(orderId);
    const manual = manualPayments.get(orderId);
    const method = manual ? manual.method : "Pix";
    if (typeof method !== "string" || !method.trim()) throw new Error("Online receipt has no payment method");
    const normalized = method === "Pix online" ? "Pix"
      : ["Dinheiro na entrega", "Dinheiro na retirada"].includes(method) ? "Dinheiro" : method;
    const amount = cents(order.total);
    const total = (totals.get(normalized) || 0) + amount;
    if (!Number.isSafeInteger(total)) throw new Error("Cash method total too large");
    totals.set(normalized, total);
    return { orderId, method: normalized, amount: amount / 100, source: manual ? "manual" : "pix" };
  });
  let methodSum = 0;
  for (const value of totals.values()) {
    methodSum += value;
    if (!Number.isSafeInteger(methodSum)) throw new Error("Cash method total too large");
  }
  if (methodSum !== cents(recorded.localReceived) + cents(summary.onlineReceived)) {
    throw new Error("Cash method totals differ from receipts");
  }
  return { summary, issues: comparison.issues, localChanged, onlineReceipts,
    byMethod: [...totals].map(([payment, amount]) => ({ payment, amount: amount / 100 })) };
}
