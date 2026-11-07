import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../supabase/functions/create-cash-order/index.ts", import.meta.url), "utf8")
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*/g, "");
const javascript = stripTypeScriptTypes(source);

function createHandler() {
  let handler;
  let inserted;
  const menu = {
    acceptingOrders: true,
    products: [{ id: "p1", category: "lanche", name: "Lanche", active: true, price: 18, ingredients: ["Cebola", "Queijo"], addons: [] }]
  };
  const client = {
    from(table) {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: table === "business_data" ? { data: { cashSessions: [{}] } } : { menu, delivery_fee: 3 }, error: null }),
        insert: value => { inserted = value; return query; },
        single: async () => ({ data: { id: "order-id" }, error: null })
      };
      return query;
    },
    rpc: async () => ({ data: true, error: null })
  };
  vm.runInNewContext(javascript, {
    adminClient: () => client,
    storeAvailability: () => ({ open: true }),
    Deno: { serve: callback => { handler = callback; }, env: { get: () => undefined } },
    Response, crypto, TextEncoder, console
  });
  return { handler, getInserted: () => inserted };
}

function request(items) {
  return new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      businessId: "00000000-0000-0000-0000-000000000000",
      fulfillment: "delivery", paymentMethod: "cash_on_delivery",
      customer: { name: "Cliente", phone: "11999999999", address: "Rua teste 123" },
      items
    })
  });
}

const item = { productId: "p1", optionName: "Padrão", quantity: 1 };

test("stores independent ingredient removals with server-calculated totals", async () => {
  const { handler, getInserted } = createHandler();
  const response = await handler(request([
    { ...item, removedIngredients: ["Cebola"] },
    { ...item, removedIngredients: ["Queijo"] }
  ]));
  assert.equal(response.status, 201);
  assert.equal(getInserted().total, 39);
  assert.deepEqual(Array.from(getInserted().order_data.items[0].removedIngredients), ["Cebola"]);
  assert.deepEqual(Array.from(getInserted().order_data.items[1].removedIngredients), ["Queijo"]);
});

test("rejects unknown ingredient removals and accepts older clients", async () => {
  const invalid = createHandler();
  const response = await invalid.handler(request([{ ...item, removedIngredients: ["Bacon"] }]));
  assert.equal(response.status, 400);
  assert.equal(invalid.getInserted(), undefined);
  const oldClient = createHandler();
  assert.equal((await oldClient.handler(request([item]))).status, 201);
  assert.deepEqual(Array.from(oldClient.getInserted().order_data.items[0].removedIngredients), []);
});
