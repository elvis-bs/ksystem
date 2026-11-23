import { randomUUID } from "node:crypto";
import { priceTableItems, PricingDataError, PricingInputError } from "./table-pricing.mjs";
import { requireOpenCashSession, totalCents, validatePaymentMethod } from "./table-orders.mjs";
import { provisionalCashSummary } from "./provisional-cash.mjs";

function notesText(value) {
  if (typeof value !== "string" || value.length > 1000) throw new TypeError("Invalid cash notes");
  return value.trim();
}

function openingCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0
    || !Number.isSafeInteger(Math.round(value * 100))
    || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
    throw new TypeError("Invalid opening amount");
  }
  return Math.round(value * 100);
}

function markProvisionalClose(snapshot, session, countedAmount, notes) {
  const closedAt = new Date().toISOString();
  const summary = provisionalCashSummary(snapshot, session, closedAt);
  const differenceCents = Math.round(countedAmount * 100) - Math.round(summary.expected * 100);
  if (!Number.isSafeInteger(differenceCents)) throw new Error("Cash difference too large");
  session.closedAt = closedAt;
  session.offlineClosureStatus = "provisional";
  session.offlineProvisional = {
    countedCash: countedAmount, closeNotes: notes, localExpected: summary.expected,
    localReceived: summary.received, localByMethod: summary.byMethod, localDifference: differenceCents / 100
  };
  return { sessionId: session.id, status: "provisional", ...session.offlineProvisional };
}

export class LocalSales {
  constructor(store, businessId) {
    if (!store || typeof store.executeCommand !== "function") throw new TypeError("Store is required");
    if (typeof businessId !== "string" || !businessId.trim()) throw new TypeError("Business ID is required");
    this.store = store;
    this.businessId = businessId;
  }

  openCash(commandId, openingAmount, notes = "", authorize = null) {
    const amount = openingCents(openingAmount) / 100;
    notes = notesText(notes);
    return this.store.executeCommand(this.businessId, commandId, {
      action: "openCash", openingAmount: amount, notes
    }, snapshot => {
      if (snapshot.cashSessions.some(session => !session.closedAt)) throw new Error("Cash session already open");
      const session = {
        id: `cash-${randomUUID()}`, openedAt: new Date().toISOString(),
        openingAmount: amount, openNotes: notes
      };
      snapshot.cashSessions.push(session);
      return { cashSessionId: session.id };
    }, authorize);
  }

  closeCashProvisionally(commandId, sessionId, counted, notes = "", authorize = null, allowNew = true) {
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new TypeError("Cash session ID is required");
    if (typeof allowNew !== "boolean") throw new TypeError("Invalid provisional close policy");
    const countedAmount = openingCents(counted) / 100;
    notes = notesText(notes);
    return this.store.executeCommand(this.businessId, commandId, {
      action: "closeCashProvisionally", sessionId, counted: countedAmount, notes
    }, snapshot => {
      if (!allowNew) return { status: "rejected", reason: "online-close-unavailable" };
      const session = requireOpenCashSession(snapshot);
      if (session.id !== sessionId) throw new Error("Cash session changed");
      return markProvisionalClose(snapshot, session, countedAmount, notes);
    }, authorize, { cashCloseSessionId: sessionId, readOnlyResult: result => result.status === "rejected" });
  }

  openQuotedCash(commandId, openingAmount, notes, expectedRevision, authorize = null) {
    const amount = openingCents(openingAmount) / 100;
    notes = notesText(notes);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError("Invalid revision");
    const command = { action: "openQuotedCash", openingAmount: amount, notes, expectedRevision };
    return this.store.executeCommand(this.businessId, commandId, command, (snapshot, revision) => {
      if (revision !== expectedRevision) return { status: "rejected", reason: "changed" };
      if (snapshot.cashSessions.some(session => !session.closedAt)) return { status: "rejected", reason: "cash-changed" };
      const session = { id: `cash-${randomUUID()}`, openedAt: new Date().toISOString(), openingAmount: amount, openNotes: notes };
      snapshot.cashSessions.push(session);
      return { status: "opened", cashSessionId: session.id };
    }, authorize, { readOnlyResult: result => result.status === "rejected" });
  }

  closeQuotedCashProvisionally(commandId, sessionId, counted, notes, expectedRevision, authorize = null, allowNew = true) {
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new TypeError("Cash session ID is required");
    if (typeof allowNew !== "boolean") throw new TypeError("Invalid provisional close policy");
    const amount = openingCents(counted) / 100;
    notes = notesText(notes);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError("Invalid revision");
    const command = { action: "closeQuotedCashProvisionally", sessionId, counted: amount, notes, expectedRevision };
    return this.store.executeCommand(this.businessId, commandId, command, (snapshot, revision) => {
      if (!allowNew) return { status: "rejected", reason: "online-close-unavailable" };
      if (revision !== expectedRevision) return { status: "rejected", reason: "changed" };
      const open = snapshot.cashSessions.filter(session => !session.closedAt);
      if (open.length !== 1 || open[0].id !== sessionId) return { status: "rejected", reason: "cash-changed" };
      return markProvisionalClose(snapshot, open[0], amount, notes);
    }, authorize, { cashCloseSessionId: sessionId, readOnlyResult: result => result.status === "rejected" });
  }

  recordSale(commandId, items, payment, paid, authorize = null) {
    validatePaymentMethod(payment);
    if (typeof paid !== "boolean") throw new TypeError("Payment status is required");
    if (!Array.isArray(items) || !items.length) throw new TypeError("At least one item is required");
    const request = JSON.parse(JSON.stringify(items));
    return this.store.executeCommand(this.businessId, commandId, {
      action: "recordSale", items: request, payment, paid
    }, snapshot => {
      const session = requireOpenCashSession(snapshot);
      const pricedItems = priceTableItems(snapshot, request);
      const now = new Date().toISOString();
      const sale = {
        id: `sale-${randomUUID()}`, createdAt: now, customerId: null,
        customerName: "Balcão", customerPhone: "", payment, paid,
        cashSessionId: paid ? session.id : null, paidAt: paid ? now : null,
        status: "Recebido", items: pricedItems, total: totalCents(pricedItems) / 100
      };
      snapshot.sales.push(sale);
      return { saleId: sale.id, total: sale.total, cashSessionId: sale.cashSessionId };
    }, authorize);
  }

  recordQuotedSale(commandId, items, payment, paid, expectedRevision, expectedSessionId, expectedTotal, authorize = null) {
    validatePaymentMethod(payment);
    if (typeof paid !== "boolean") throw new TypeError("Payment status is required");
    if (!Array.isArray(items) || !items.length) throw new TypeError("At least one item is required");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError("Invalid revision");
    if (typeof expectedSessionId !== "string" || !expectedSessionId.trim()) throw new TypeError("Invalid cash session");
    const expectedCents = openingCents(expectedTotal);
    const request = JSON.parse(JSON.stringify(items));
    const command = { action: "recordQuotedSale", items: request, payment, paid,
      expectedRevision, expectedSessionId, expectedTotal: expectedCents / 100 };
    return this.store.executeCommand(this.businessId, commandId, command, (snapshot, revision) => {
      if (revision !== expectedRevision) return { status: "rejected", reason: "changed" };
      const open = snapshot.cashSessions.filter(session => !session.closedAt);
      if (open.length !== 1 || open[0].id !== expectedSessionId) return { status: "rejected", reason: "cash-changed" };
      let pricedItems;
      try {
        pricedItems = priceTableItems(snapshot, request);
      } catch (error) {
        if (!(error instanceof PricingDataError) && !(error instanceof PricingInputError)) throw error;
        return { status: "rejected", reason: "invalid-items" };
      }
      let total;
      try {
        total = totalCents(pricedItems);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return { status: "rejected", reason: "invalid-items" };
      }
      if (total !== expectedCents) return { status: "rejected", reason: "price-changed" };
      const now = new Date().toISOString();
      const sale = {
        id: `sale-${randomUUID()}`, createdAt: now, customerId: null,
        customerName: "Balcão", customerPhone: "", payment, paid,
        cashSessionId: paid ? open[0].id : null, paidAt: paid ? now : null,
        status: "Recebido", items: pricedItems, total: total / 100
      };
      snapshot.sales.push(sale);
      return { status: "recorded", saleId: sale.id, total: sale.total, cashSessionId: sale.cashSessionId };
    }, authorize, { readOnlyResult: result => result.status === "rejected" });
  }
}
