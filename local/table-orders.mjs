import { randomUUID } from "node:crypto";
import { priceTableItems } from "./table-pricing.mjs";

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new TypeError(`${field} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

function cents(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0
    || !Number.isSafeInteger(Math.round(value * 100))
    || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
    throw new TypeError(`${field} must be a non-negative monetary amount`);
  }
  return Math.round(value * 100);
}

function lineCents(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Invalid item");
  requiredText(item.productId, "productId");
  requiredText(item.name, "name");
  if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000) {
    throw new TypeError("Invalid quantity");
  }
  if (!Array.isArray(item.addons)) throw new TypeError("Invalid addons");
  let unit = cents(item.price, "price");
  if (item.border != null) {
    if (typeof item.border !== "object" || Array.isArray(item.border)) throw new TypeError("Invalid border");
    unit += cents(item.border.price, "border price");
  }
  for (const addon of item.addons) {
    if (!addon || typeof addon !== "object" || Array.isArray(addon)) throw new TypeError("Invalid addon");
    unit += cents(addon.price, "addon price");
  }
  const total = unit * item.quantity;
  if (!Number.isSafeInteger(total)) throw new RangeError("Item total is too large");
  return total;
}

function tables(snapshot) {
  if (snapshot.tables === undefined) snapshot.tables = [];
  if (!Array.isArray(snapshot.tables)) throw new Error("Invalid tables in snapshot");
  return snapshot.tables;
}

function findTable(snapshot, tableId) {
  const table = tables(snapshot).find(item => item.id === tableId);
  if (!table) throw new Error("Table not found");
  return table;
}

export function totalCents(items) {
  const total = items.reduce((sum, item) => sum + lineCents(item), 0);
  if (!Number.isSafeInteger(total)) throw new RangeError("Order total is too large");
  return total;
}

export function requireOpenCashSession(snapshot) {
  const sessions = snapshot.cashSessions.filter(session => !session.closedAt);
  if (sessions.length !== 1) throw new Error("Exactly one open cash session is required");
  requiredText(sessions[0].id, "cash session ID");
  return sessions[0];
}

export function validatePaymentMethod(payment) {
  if (!["Dinheiro", "Pix", "Cartão de crédito", "Cartão de débito"].includes(payment)) {
    throw new TypeError("Unsupported payment method");
  }
}

export class TableOrders {
  constructor(store, businessId) {
    this.store = store;
    this.businessId = requiredText(businessId, "businessId");
  }

  createTable(commandId, name, authorize = null) {
    name = requiredText(name, "name");
    return this.store.executeCommand(this.businessId, commandId, { action: "createTable", name }, snapshot => {
      const entries = tables(snapshot);
      if (entries.some(table => table.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
        throw new Error("Table name already exists");
      }
      const table = { id: `table-${randomUUID()}`, name, order: null };
      entries.push(table);
      return { tableId: table.id };
    }, authorize);
  }

  addItems(commandId, tableId, expectedOrderId, items, staff = null) {
    tableId = requiredText(tableId, "tableId");
    if (expectedOrderId !== null) expectedOrderId = requiredText(expectedOrderId, "expectedOrderId");
    if (!Array.isArray(items) || !items.length) throw new TypeError("At least one item is required");
    const copy = JSON.parse(JSON.stringify(items));
    let authorize = null;
    let staffId = null;
    if (staff !== null) {
      if (!staff.accounts || staff.accounts.db !== this.store.db || !staff.identity
        || staff.identity.businessId !== this.businessId || typeof staff.identity.id !== "string") {
        throw new TypeError("Invalid staff authorization");
      }
      staffId = staff.identity.id;
      authorize = () => {
        if (!staff.accounts.isCurrent(staff.identity)) throw new Error("Staff access revoked");
      };
    }
    const command = { action: "addItems", tableId, expectedOrderId, items: copy, ...(staffId ? { staffId } : {}) };
    return this.store.executeCommand(this.businessId, commandId, command, snapshot => {
      const pricedItems = priceTableItems(snapshot, copy);
      const table = findTable(snapshot, tableId);
      if ((table.order?.id ?? null) !== expectedOrderId) throw new Error("Table order changed");
      if (table.order === null) {
        table.order = { id: `table-order-${randomUUID()}`, openedAt: new Date().toISOString(), items: [] };
      }
      if (!table.order || !Array.isArray(table.order.items)) throw new Error("Invalid table order");
      table.order.items.push(...pricedItems.map(item => staffId ? { ...item, addedByStaffId: staffId } : item));
      const total = totalCents(table.order.items) / 100;
      return { tableId, orderId: table.order.id, total };
    }, authorize);
  }

  closeOrder(commandId, tableId, orderId, payment, authorize = null) {
    tableId = requiredText(tableId, "tableId");
    orderId = requiredText(orderId, "orderId");
    validatePaymentMethod(payment);
    return this.store.executeCommand(this.businessId, commandId, { action: "closeOrder", tableId, orderId, payment }, snapshot => {
      const table = findTable(snapshot, tableId);
      if (!table.order || table.order.id !== orderId || !Array.isArray(table.order.items) || !table.order.items.length) {
        throw new Error("Table order is no longer open");
      }
      const session = requireOpenCashSession(snapshot);
      const now = new Date().toISOString();
      const sale = {
        id: `sale-${randomUUID()}`,
        createdAt: now,
        customerId: null,
        customerName: table.name,
        customerPhone: "",
        payment,
        paid: true,
        cashSessionId: session.id,
        paidAt: now,
        status: "Recebido",
        items: table.order.items,
        total: totalCents(table.order.items) / 100,
        tableId,
        tableOrderId: orderId
      };
      snapshot.sales.push(sale);
      table.order = null;
      return { tableId, orderId, saleId: sale.id, total: sale.total };
    }, authorize);
  }
}
