import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";
import { StaffAccounts } from "../local/staff-accounts.mjs";
import { TableOrders } from "../local/table-orders.mjs";
import { createStaffApi } from "../local/staff-api.mjs";
import { TabletQueue } from "../local/tablet-queue.mjs";
import { PhotoCache } from "../local/photo-cache.mjs";

const origin = "https://localhost:43999";
const password = "test-staff-password";

async function setup(t, withPhotos = false) {
  const dir = mkdtempSync(join(tmpdir(), "bora-staff-https-"));
  const keyPath = join(dir, "test-key.pem");
  const certPath = join(dir, "test-cert.pem");
  const windowsOpenSSL = "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe";
  const openssl = process.platform === "win32" && existsSync(windowsOpenSSL) ? windowsOpenSSL : "openssl";
  execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath, "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  const store = new OfflineStore(join(dir, "store.sqlite"));
  const accounts = new StaffAccounts(store.db);
  const photoBusiness = "11111111-1111-1111-1111-111111111111";
  const businessId = withPhotos ? photoBusiness : "store";
  store.initialize(businessId, {
    products: withPhotos
      ? [{ id: "p1", name: "Lanche", category: "lanche", active: true, price: 10, recipe: [], addons: [],
        photoPath: `${photoBusiness}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg` }]
      : [{ id: "p1", name: "Suco", category: "bebida", active: true, price: 10, cost: 4, addons: [] }],
    ingredients: [], sales: [], cashSessions: [], financeEntries: [{ private: true }]
  }, 0);
  const staff = await accounts.create(businessId, { username: "ana", name: "Ana" }, password);
  const table = new TableOrders(store, businessId).createTable("create", "Mesa 1");
  const photos = withPhotos ? new PhotoCache(store) : null;
  if (photos) await photos.refresh(businessId, async () => Buffer.from([255, 216, 1, 2, 255, 217]));
  const cert = readFileSync(certPath);
  const errors = [];
  const server = createStaffApi({
    store, accounts, businessId, origin, photos,
    tls: { key: readFileSync(keyPath), cert },
    logError: (...args) => errors.push(args)
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    accounts.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function request(path, { method = "GET", data, token, headers = {} } = {}) {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const requestHeaders = {
      host: "localhost:43999", origin, "x-local-request": "1",
      ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers
    };
    for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: "127.0.0.1", port: server.address().port, servername: "localhost", ca: cert,
        path, method, headers: requestHeaders
      }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, headers: res.headers,
            body: res.headers["content-type"]?.startsWith("application/json") ? JSON.parse(text)
              : res.headers["content-type"]?.startsWith("image/jpeg") ? Buffer.concat(chunks) : text });
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  return { request, store, accounts, staff, tableId: table.tableId, errors };
}

test("staff receive cached product photos only after authentication over HTTPS", async t => {
  const { request } = await setup(t, true);
  assert.equal((await request("/api/product-photo", { method: "POST", data: { productId: "p1" } })).status, 401);
  const token = (await request("/api/login", { method: "POST", data: { username: "ana", password } })).body.token;
  assert.equal((await request("/api/catalog", { token })).body.products[0].hasPhoto, true);
  const image = await request("/api/product-photo", { method: "POST", token, data: { productId: "p1" } });
  assert.equal(image.status, 200);
  assert.equal(image.headers["content-type"], "image/jpeg");
  assert.deepEqual(image.body, Buffer.from([255, 216, 1, 2, 255, 217]));
  assert.equal((await request("/api/product-photo", { method: "POST", token, data: { productId: "../secret" } })).status, 404);
});

test("HTTPS staff can view restricted data and add idempotent priced orders", async t => {
  const { request, store, tableId } = await setup(t);
  assert.equal((await request("/api/catalog")).status, 401);
  const login = await request("/api/login", { method: "POST", data: { username: "ana", password } });
  assert.equal(login.status, 200);
  assert.equal(login.body.businessId, "store");
  assert.ok(login.body.staffId);
  const token = login.body.token;
  assert.match(token, /^[0-9a-f]{64}$/);
  const catalog = await request("/api/catalog", { token });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.products[0].price, 10);
  assert.equal(catalog.body.products[0].cost, undefined);
  assert.equal(JSON.stringify(catalog.body).includes("financeEntries"), false);
  assert.equal((await request("/api/catalog", { token, headers: { origin: undefined, "sec-fetch-site": "same-origin" } })).status, 200);
  assert.equal((await request("/api/tables", { token })).body.tables[0].id, tableId);
  const data = { commandId: "order-1", tableId, expectedOrderId: null,
    items: [{ productId: "p1", optionName: "Padrão", quantity: 2 }] };
  const result = await request("/api/table-items", { method: "POST", token, data });
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 20);
  assert.deepEqual((await request("/api/table-items", { method: "POST", token, data })).body, result.body);
  assert.equal(store.read("store").snapshot.tables[0].order.items.length, 1);
  assert.equal(store.read("store").snapshot.sales.length, 0);
  assert.equal((await request("/api/close-order", { method: "POST", token, data: {} })).status, 404);
  assert.equal((await request("/api/logout", { method: "POST", token })).status, 200);
  assert.equal((await request("/api/tables", { token })).status, 401);
});

test("tablet assets are served with strict content policy and without external resources", async t => {
  const { request } = await setup(t);
  const navigation = await request("/", { headers: { origin: undefined, "x-local-request": undefined, "sec-fetch-site": "none" } });
  assert.equal(navigation.status, 200);
  assert.match(navigation.body, /Versão experimental/);
  assert.match(navigation.headers["content-security-policy"], /script-src 'self'/);
  assert.equal(navigation.headers["cache-control"], "no-store");
  for (const asset of ["/tablet.mjs", "/tablet-queue.mjs", "/tablet.css"]) {
    assert.equal((await request(asset, { headers: { origin: undefined, "x-local-request": undefined } })).status, 200);
  }
  assert.equal((await request("/", { headers: { host: "evil.example", "x-local-request": undefined } })).status, 403);
});

test("tablet retries a lost HTTPS response without duplicating the order", async t => {
  const { request, store, tableId } = await setup(t);
  const login = (await request("/api/login", { method: "POST", data: { username: "ana", password } })).body;
  const data = new Map();
  const storage = {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  };
  let first = true;
  const queue = new TabletQueue(storage, async command => {
    const result = await request("/api/table-items", { method: "POST", token: login.token, data: command });
    assert.equal(result.status, 200);
    if (first) { first = false; throw new Error("response lost"); }
    return result.body;
  });
  queue.prepare(login, {
    commandId: "lost-response", tableId, expectedOrderId: null,
    items: [{ productId: "p1", optionName: "Padrão", quantity: 1 }]
  });
  await assert.rejects(queue.retry(login), /response lost/);
  assert.equal(store.read("store").snapshot.tables[0].order.items.length, 1);
  assert.equal((await queue.retry(login)).total, 10);
  assert.equal(store.read("store").snapshot.tables[0].order.items.length, 1);
  assert.equal(queue.read(), null);
});

test("cross-origin requests, forged prices, stale orders and revoked staff are rejected", async t => {
  const { request, store, accounts, staff, tableId } = await setup(t);
  assert.equal((await request("/api/login", {
    method: "POST", data: { username: "ana", password }, headers: { origin: "https://evil.example" }
  })).status, 403);
  assert.equal((await request("/api/login", {
    method: "POST", data: { username: "ana", password }, headers: { host: "evil.example" }
  })).status, 403);
  assert.equal((await request("/api/login", {
    method: "POST", data: { username: "ana", password }, headers: { "x-local-request": "" }
  })).status, 403);
  assert.equal((await request("/api/login", {
    method: "POST", data: { username: "ana", password }, headers: { "sec-fetch-site": "cross-site" }
  })).status, 403);
  assert.equal((await request("/api/login", {
    method: "POST", data: { username: "ana", password: "wrong" }
  })).status, 401);
  assert.equal((await request("/api/login", {
    method: "POST", data: { username: "ana", password }, headers: { "content-type": "text/plain" }
  })).status, 415);
  assert.equal((await request("/api/login", {
    method: "POST", data: { username: "ana", password: "x".repeat(70000) }
  })).status, 413);
  const token = (await request("/api/login", { method: "POST", data: { username: "ana", password } })).body.token;
  const item = { productId: "p1", optionName: "Padrão", quantity: 1 };
  const invalid = { commandId: "forged", tableId, expectedOrderId: null, items: [{ ...item, price: 0 }] };
  assert.equal((await request("/api/table-items", { method: "POST", token, data: invalid })).status, 409);
  const valid = { ...invalid, commandId: "valid", items: [item] };
  const added = await request("/api/table-items", { method: "POST", token, data: valid });
  assert.equal(added.status, 200);
  assert.equal((await request("/api/table-items", { method: "POST", token, data: { ...valid, commandId: "stale" } })).status, 409);
  accounts.setActive("store", staff.id, false);
  assert.equal((await request("/api/table-items", { method: "POST", token, data: valid })).status, 401);
  assert.equal(store.read("store").snapshot.tables[0].order.items.length, 1);
});

test("authorization and command execution use the same transaction, including replays", async t => {
  const { store, accounts, staff, tableId } = await setup(t);
  const identity = await accounts.authenticate("store", "ana", password);
  const orders = new TableOrders(store, "store");
  const args = ["command", tableId, null, [{ productId: "p1", optionName: "Padrão", quantity: 1 }],
    { accounts, identity }];
  const result = orders.addItems(...args);
  assert.equal(store.read("store").snapshot.tables[0].order.items[0].addedByStaffId, staff.id);
  assert.deepEqual(orders.addItems(...args), result);
  const second = await accounts.create("store", { username: "bia", name: "Bia" }, "other-password");
  const secondIdentity = await accounts.authenticate("store", second.username, "other-password");
  assert.throws(() => orders.addItems(...args.slice(0, 4), { accounts, identity: secondIdentity }), /different data/);
  accounts.setActive("store", staff.id, false);
  assert.throws(() => orders.addItems(...args), /revoked/);
  assert.equal(store.read("store").snapshot.tables[0].order.items.length, 1);
});
