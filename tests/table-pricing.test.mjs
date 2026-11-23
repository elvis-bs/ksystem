import assert from "node:assert/strict";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";
import { TableOrders } from "../local/table-orders.mjs";

function setup(t, pricing = "highest") {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", {
    pizzaEnabled: true, pizzaPricingMode: pricing,
    pizzaSizes: [{ name: "Média", flavorLimit: 2 }],
    ingredients: [{ id: "ing", cost: 0.1 }],
    products: [
      { id: "p1", name: "Calabresa", category: "pizza", active: true,
        sizes: [{ name: "Média", price: 30, factor: 2 }],
        recipe: [{ ingredientId: "ing", quantity: 50 }],
        addons: [{ name: "Queijo", price: 3, cost: 1 }],
        borderOptions: [{ name: "Recheada", price: 5, cost: 2 }] },
      { id: "p2", name: "Frango", category: "pizza", active: true,
        sizes: [{ name: "Média", price: 40, factor: 1 }],
        recipe: [{ ingredientId: "ing", quantity: 40 }], addons: [] },
      { id: "drink", name: "Suco", category: "bebida", active: true, price: 7, cost: 3, addons: [] },
      { id: "inactive", name: "Indisponível", category: "bebida", active: false, price: 1, cost: 1, addons: [] }
    ],
    sales: [], cashSessions: [{ id: "cash", openedAt: "2026-01-01" }]
  }, 0);
  const service = new TableOrders(store, "store");
  return { store, service, tableId: service.createTable("create", "Mesa 1").tableId };
}
const pizza = () => ({
  productId: "p1", optionName: "Média", quantity: 2,
  flavorIds: ["p2", "p1"], addonIndexes: [0], borderIndex: 0
});

test("prices mixed pizza and costs using the current local catalog", t => {
  const { store, service, tableId } = setup(t);
  const result = service.addItems("add", tableId, null, [pizza()]);
  assert.equal(result.total, 96);
  const saved = store.read("store").snapshot.tables[0].order.items[0];
  assert.equal(saved.price, 40);
  assert.equal(saved.cost, 7);
  assert.equal(saved.name, "Calabresa / Frango");
  assert.deepEqual(saved.border, { name: "Recheada", price: 5, cost: 2 });
  assert.deepEqual(saved.addons, [{ name: "Queijo", price: 3, cost: 1 }]);
  assert.equal(service.closeOrder("close", tableId, result.orderId, "Dinheiro").total, 96);
});

test("size pricing follows application flavor order instead of tablet request order", t => {
  const { service, tableId } = setup(t, "size");
  assert.equal(service.addItems("add", tableId, null, [pizza()]).total, 76);
});

test("rejects forged prices, invalid selections, duplicates, inactive products, and malformed quantities", t => {
  const { store, service, tableId } = setup(t);
  const before = store.read("store");
  const invalid = [
    { ...pizza(), price: 0 },
    { ...pizza(), cost: 0 },
    { ...pizza(), addonIndexes: [0, 0] },
    { ...pizza(), addonIndexes: 0 },
    { ...pizza(), addonIndexes: [-1] },
    { ...pizza(), borderIndex: 4 },
    { ...pizza(), flavorIds: ["p1", "p1"] },
    { ...pizza(), flavorIds: ["p1", "missing"] },
    { ...pizza(), flavorIds: ["p1", "p2", "drink"] },
    { ...pizza(), optionName: "Grande" },
    { ...pizza(), quantity: 0 },
    { productId: "inactive", optionName: "Padrão", quantity: 1 },
    { productId: "drink", optionName: "Padrão", quantity: 1, borderIndex: 0 }
  ];
  for (const [index, request] of invalid.entries()) {
    assert.throws(() => service.addItems(`invalid-${index}`, tableId, null, [request]));
    assert.deepEqual(store.read("store"), before);
  }
});

test("replay returns original result even after catalog prices change", t => {
  const { store, service, tableId } = setup(t);
  const first = service.addItems("add", tableId, null, [pizza()]);
  const state = store.read("store");
  state.snapshot.products[1].sizes[0].price = 50;
  store.save("store", state.snapshot, state.localRevision);
  assert.deepEqual(service.addItems("add", tableId, null, [pizza()]), first);
  assert.equal(service.addItems("new", tableId, first.orderId, [pizza()]).total, 212);
});

test("catalog errors and disabled pizza leave all items unchanged", t => {
  const { store, service, tableId } = setup(t);
  const state = store.read("store");
  state.snapshot.pizzaEnabled = false;
  store.save("store", state.snapshot, state.localRevision);
  const before = store.read("store");
  assert.throws(() => service.addItems("pizza-disabled", tableId, null, [pizza()]), /Pizza unavailable/);
  assert.deepEqual(store.read("store"), before);
  const changed = store.read("store");
  changed.snapshot.pizzaEnabled = true;
  changed.snapshot.ingredients = [];
  store.save("store", changed.snapshot, changed.localRevision);
  const invalidCatalog = store.read("store");
  assert.throws(() => service.addItems("missing-ingredient", tableId, null, [pizza()]), /Ingredient/);
  assert.deepEqual(store.read("store"), invalidCatalog);
});
