import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { OwnerQueue } from "../local/owner-queue.mjs";

test("local main interface logs in, renders SQLite snapshot and blocks edits", async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const listeners = [];
  const classList = { add() {}, remove() {}, toggle() {} };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, listeners: {}, classList, dataset: {}, hidden: false, textContent: "", innerHTML: "", disabled: false,
      fields: {}, addEventListener(type, handler) { this.listeners[type] = handler; },
      reportValidity() { return true; }, reset() { this.fields = {}; },
      replaceChildren() { this.innerHTML = ""; }, append() {}
    });

    return elements.get(id);
  };
  const document = {
    body: { classList },
    getElementById: element,
    querySelector: element,
    querySelectorAll: () => [],
    addEventListener(type, handler, capture) { listeners.push({ type, handler, capture }); },
    createTextNode: text => text
  };
  const snapshot = {
    products: [{ id: "p1", name: "Suco local", category: "bebida", active: true, price: 10, cost: 4 }],
    ingredients: [], sales: [], cashSessions: [], financeEntries: [], onlineOrderPayments: []
  };
  const calls = [];
  let invalidSnapshot = false;
  const fetch = async (path, request) => {
    calls.push({ path, request });
    if (path === "/api/owner/login") return { ok: true, json: async () => ({ token: "token", businessId: "store" }) };
    if (path === "/api/owner/main-preview") return { ok: true, json: async () => ({
      snapshot: invalidSnapshot ? { ...snapshot, sales: null } : snapshot, localRevision: 3
    }) };
    if (path === "/api/owner/logout") return { ok: true };
    throw new Error(`Unexpected request ${path}`);
  };
  const context = {
    document, fetch, window: { addEventListener() {} }, location: { pathname: "/local-main", search: "" },
    localStorage: { getItem() { throw new Error("Must not use browser storage"); }, setItem() { throw new Error("Must not write"); } },
    URLSearchParams, Intl, console, setTimeout, clearTimeout,
    FormData: class { constructor(form) { this.form = form; } get(key) { return this.form.fields[key]; } }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const form = element("authForm");
  form.fields = { email: "owner@example.test", password: "example-password" };
  await form.listeners.submit({ preventDefault() {}, currentTarget: form });
  assert.equal(element("authGate").hidden, true);
  assert.equal(element("localPreviewWarning").hidden, false);
  assert.match(element("pageContent").innerHTML, /Suco local/);
  assert.deepEqual(calls.map(call => call.path), ["/api/owner/login", "/api/owner/main-preview"]);
  assert.equal(calls[1].request.headers.authorization, "Bearer token");
  const clickGuard = listeners.find(listener => listener.type === "click" && listener.capture === true).handler;
  const attempt = button => {
    const event = { target: { closest: () => button }, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    clickGuard(event);
    return event;
  };
  assert.equal(attempt({ id: "", dataset: { page: "caixa" } }).prevented, false);
  assert.equal(attempt({ id: "", dataset: { page: "vendas" } }).prevented, false);
  const edit = attempt({ id: "", dataset: { action: "new-product" } });
  assert.equal(edit.prevented, true);
  assert.equal(edit.stopped, true);
  const submitGuard = listeners.find(listener => listener.type === "submit" && listener.capture === true).handler;
  const submission = { target: { id: "modalForm", dataset: { type: "product" } }, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  submitGuard(submission);
  assert.equal(submission.prevented, true);
  assert.equal(submission.stopped, true);
  await element("signOutButton").listeners.click();
  assert.equal(element("authGate").hidden, false);
  assert.equal(element("pageContent").innerHTML, "");
  assert.equal(element("localPreviewWarning").hidden, true);
  assert.equal(calls[2].path, "/api/owner/logout");
  invalidSnapshot = true;
  form.fields = { email: "owner@example.test", password: "example-password" };
  await form.listeners.submit({ preventDefault() {}, currentTarget: form });
  assert.equal(element("authGate").hidden, false);
  assert.match(element("authMessage").textContent, /Dados locais inválidos/);
  assert.equal(element("pageContent").innerHTML, "");
  assert.equal(calls[5].path, "/api/owner/logout");
});

test("local sale survives a lost response and retries the same command after page reload", async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1]
    .replace('await import("/owner-queue.mjs")', "({ OwnerQueue: window.testOwnerQueue })")
    .replace("      initializeAuth();", "      window.testLocal = { submitLocalSale, addSaleItem, getCart: () => saleCart }; initializeAuth();");
  const entries = new Map();
  const storage = { getItem: key => entries.has(key) ? entries.get(key) : null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const snapshot = { products: [{ id: "p1", name: "Suco", category: "bebida", active: true, price: 10, cost: 4 }],
    ingredients: [], sales: [], cashSessions: [{ id: "cash", openedAt: "2026-01-01T10:00:00Z" }], financeEntries: [] };
  let revision = 3;
  const commands = [];
  let saved;
  const fetch = async (path, request) => {
    if (path === "/api/owner/login") return { ok: true, json: async () => ({ token: "token", businessId: "store" }) };
    if (path === "/api/owner/main-preview") return { ok: true, json: async () => ({ snapshot, localRevision: revision }) };
    if (path === "/api/owner/quoted-sale") {
      const command = JSON.parse(request.body);
      commands.push(command);
      if (!saved) {
        saved = { status: "recorded", saleId: "sale", total: 20, cashSessionId: "cash" };
        snapshot.sales.push({ id: "sale", paid: true, total: 20, payment: "Dinheiro", cashSessionId: "cash" });
        revision++;
        throw new Error("resposta perdida");
      }
      return { ok: true, json: async () => saved };
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const createPage = async () => {
    const elements = new Map();
    const classList = { add() {}, remove() {}, toggle() {} };
    const element = id => {
      if (!elements.has(id)) elements.set(id, {
        id, listeners: {}, classList, dataset: {}, hidden: false, textContent: "", innerHTML: "", disabled: false,
        fields: {}, value: "", addEventListener(type, handler) { this.listeners[type] = handler; }, reportValidity() { return true; },
        reset() { this.fields = {}; }, replaceChildren() { this.innerHTML = ""; }, append() {}
      });
      return elements.get(id);
    };
    const document = { body: { classList }, getElementById: element, querySelector: element,
      querySelectorAll: () => [], addEventListener() {}, createTextNode: text => text };
    const window = { addEventListener() {}, testOwnerQueue: OwnerQueue };
    const context = { OwnerQueue, window, document, fetch, localStorage: storage,
      location: { pathname: "/local-main", search: "" }, URLSearchParams, Intl,
      navigator: { locks: { request: async (name, options, action) => action({}) } },
      crypto: { randomUUID: () => "command-1" }, console: { error() {}, warn() {} }, setTimeout, clearTimeout,
      FormData: class { constructor(form) { this.form = form; } get(key) { return this.form.fields[key]; } } };
    vm.createContext(context);
    vm.runInContext(source, context);
    const form = element("authForm");
    form.fields = { email: "owner@example.test", password: "example-password" };
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    return { element, api: window.testLocal };
  };
  let page = await createPage();
  const productForm = { fields: { productId: "p1", optionIndex: "0", quantity: "2" }, reportValidity: () => true,
    querySelectorAll: () => [], querySelector: () => null };
  page.api.addSaleItem({ preventDefault() {}, currentTarget: productForm });
  assert.equal(page.api.getCart().length, 1);
  await page.api.submitLocalSale({ fields: { payment: "Dinheiro", paymentStatus: "paid" } });
  assert.equal(commands.length, 1, page.element("localOperationStatus").textContent);
  assert.equal(commands[0].expectedRevision, 3);
  assert.equal(commands[0].expectedTotal, 20);
  assert.deepEqual(commands[0].items, [{ productId: "p1", optionName: "Padrão", quantity: 2, addonIndexes: [] }]);
  assert.match(page.element("localOperationStatus").textContent, /resposta perdida/);
  assert.equal(snapshot.sales.length, 1);
  page = await createPage();
  await page.element("retryLocalSale").listeners.click();
  assert.deepEqual(commands[1], commands[0]);
  assert.equal(entries.size, 0);
  assert.equal(snapshot.sales.length, 1);
  assert.match(page.element("localOperationStatus").textContent, /confirmada/);
});

test("main screen blocks new provisional close but retries a previously queued command", async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1]
    .replace('await import("/owner-queue.mjs")', "({ OwnerQueue: window.testOwnerQueue })")
    .replace("      initializeAuth();", "      window.testLocal = { openCashForm }; initializeAuth();");
  const entries = new Map();
  const storage = { getItem: key => entries.has(key) ? entries.get(key) : null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const snapshot = { products: [], ingredients: [], sales: [], financeEntries: [],
    cashSessions: [{ id: "cash", openedAt: "2026-01-01T10:00:00Z", openingAmount: 10 }] };
  const sent = [];
  let closed = false;
  const fetch = async (path, request) => {
    if (path === "/api/owner/login") return { ok: true, json: async () => ({ token: "token", businessId: "store" }) };
    if (path === "/api/owner/main-preview") return { ok: true, json: async () => ({ snapshot, localRevision: closed ? 5 : 4 }) };
    if (path === "/api/owner/quoted-provisional-close") {
      sent.push(JSON.parse(request.body));
      if (!closed) {
        closed = true;
        snapshot.cashSessions[0].closedAt = "2026-01-01T12:00:00Z";
        snapshot.cashSessions[0].offlineClosureStatus = "provisional";
        throw new Error("resposta perdida");
      }
      return { ok: true, json: async () => ({ status: "provisional", sessionId: "cash", localExpected: 10, localReceived: 0 }) };
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const page = async () => {
    const elements = new Map();
    const listeners = [];
    const classList = { add() {}, remove() {}, toggle() {} };
    const element = id => {
      if (!elements.has(id)) elements.set(id, { id, listeners: {}, classList, dataset: {}, hidden: false,
        fields: {}, textContent: "", innerHTML: "", disabled: false,
        addEventListener(type, handler) { this.listeners[type] = handler; }, reportValidity() { return true; },
        reset() { this.fields = {}; }, replaceChildren(...items) { this.textContent = items.join(""); }, append() {}, querySelectorAll() { return []; } });
      return elements.get(id);
    };
    const document = { body: { classList, style: {} }, getElementById: element, querySelector: element,
      querySelectorAll: () => [], addEventListener(type, handler, capture) { listeners.push({ type, handler, capture }); },
      createTextNode: text => text };
    const window = { addEventListener() {}, testOwnerQueue: OwnerQueue };
    const context = { window, document, fetch, localStorage: storage, location: { pathname: "/local-main", search: "" },
      navigator: { locks: { request: async (name, options, action) => action({}) } }, crypto: { randomUUID: () => "close-id" },
      URLSearchParams, Intl, console: { error() {}, warn() {} }, setTimeout, clearTimeout,
      FormData: class { constructor(form) { this.form = form; } get(key) { return this.form.fields[key]; } } };
    vm.createContext(context);
    vm.runInContext(source, context);
    const form = element("authForm");
    form.fields = { email: "owner@example.test", password: "example" };
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    return { element, api: window.testLocal, listeners };
  };
  let first = await page();
  first.api.openCashForm(true);
  assert.match(first.element("toast").textContent, /caixa permanece aberto/);
  assert.equal(sent.length, 0);
  const command = { commandId: "close-id", sessionId: "cash", counted: 10, notes: "conferido", expectedRevision: 4 };
  new OwnerQueue(storage, async () => {}).prepare("store", "/api/owner/quoted-provisional-close", command);
  closed = true;
  snapshot.cashSessions[0].closedAt = "2026-01-01T12:00:00Z";
  snapshot.cashSessions[0].offlineClosureStatus = "provisional";
  first = await page();
  await first.element("retryLocalSale").listeners.click();
  assert.deepEqual(sent[0], command);
  assert.equal(entries.size, 0);
  assert.match(first.element("localOperationStatus").textContent, /fechado provisoriamente/);
});
