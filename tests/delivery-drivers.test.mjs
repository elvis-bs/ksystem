import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const schema = readFileSync(new URL("../supabase-schema.sql", import.meta.url), "utf8");
const functionSource = readFileSync(new URL("../supabase/functions/manage-delivery-drivers/index.ts", import.meta.url), "utf8");

test("driver orders are isolated to the active driver's own store and delivery orders", () => {
  assert.match(schema, /create policy "Delivery drivers can read available and assigned orders"[\s\S]*?order_data ->> 'fulfillment' = 'delivery'[\s\S]*?driver\.business_id = online_orders\.business_id[\s\S]*?driver\.active[\s\S]*?status = 'Saiu para entrega'/);
  assert.match(schema, /create policy "Delivery drivers can finish their assigned orders"[\s\S]*?delivery_driver_id = \(select auth\.uid\(\)\)[\s\S]*?status = 'Saiu para entrega'[\s\S]*?with check \([\s\S]*?status = 'Concluído'/);
  assert.match(schema, /grant update \(active\) on public\.delivery_drivers to authenticated/);
  assert.match(schema, /grant select, insert, update, delete on public\.delivery_drivers to service_role/);
});

test("claim RPC atomically reserves only eligible unassigned delivery orders", () => {
  const claimFunction = schema.slice(schema.indexOf("create or replace function public.claim_delivery_order"), schema.indexOf("create table if not exists public.mercadopago_connections"));
  assert.match(claimFunction, /security definer/);
  assert.match(claimFunction, /delivery_driver_id is null/);
  assert.match(claimFunction, /status = 'Saiu para entrega'/);
  assert.match(claimFunction, /order_data ->> 'fulfillment' = 'delivery'/);
  assert.match(claimFunction, /order_data ->> 'paymentMethod' <> 'pix'[\s\S]*?payment_status = 'approved'/);
  assert.match(claimFunction, /grant execute on function public\.claim_delivery_order\(uuid\) to authenticated/);
});

test("driver account creation authenticates and requires an existing store account", () => {
  assert.match(functionSource, /auth\.getUser\(jwt\)/);
  assert.match(functionSource, /from\("business_data"\)[\s\S]*?eq\("user_id", userData\.user\.id\)/);
  assert.match(functionSource, /auth\.admin\.createUser/);
  assert.match(functionSource, /delivery_drivers"\)\.insert/);
  assert.match(functionSource, /auth\.admin\.deleteUser/);
  assert.match(html, /data-page="entregadores"/);
  assert.match(html, /manage-delivery-drivers/);
  assert.match(html, /searchParams\.set\("entregador", "1"\)/);
});

test("a driver can claim an order and sees a conflict if another driver got it first", async () => {
  const start = html.indexOf("      async function claimDeliveryOrder(");
  const end = html.indexOf("      async function finishDeliveryOrder(", start);
  assert.ok(start >= 0 && end > start);
  const messages = [];
  let refreshed = 0;
  const context = {
    driverProfile: { active: true },
    supabaseClient: { rpc: async (name, args) => {
      assert.equal(name, "claim_delivery_order");
      assert.equal(args.p_order_id, "order-id");
      return context.claimed ? { data: true, error: null } : { data: false, error: null };
    } },
    showToast: message => messages.push(message),
    refreshDriverOrders: async () => { refreshed++; return true; },
    console: { error() {} }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  await context.claimDeliveryOrder("order-id");
  assert.match(messages[0], /Outro entregador aceitou/);
  context.claimed = true;
  await context.claimDeliveryOrder("order-id");
  assert.match(messages[1], /Entrega aceita/);
  assert.equal(refreshed, 2);
});

test("driver completion updates only their active delivery and refreshes the portal", async () => {
  const start = html.indexOf("      async function finishDeliveryOrder(");
  const end = html.indexOf("      function setAuthMode(", start);
  assert.ok(start >= 0 && end > start);
  const filters = [];
  const messages = [];
  let refreshed = 0;
  const query = {
    update(values) { assert.equal(values.status, "Concluído"); return this; },
    eq(field, value) { filters.push([field, value]); return this; },
    select() { return this; },
    async maybeSingle() { return { data: { id: "order-id" }, error: null }; }
  };
  const context = {
    driverProfile: { active: true, user_id: "driver-id" },
    supabaseClient: { from: table => { assert.equal(table, "online_orders"); return query; } },
    showToast: text => messages.push(text), refreshDriverOrders: async () => { refreshed++; },
    console: { error() {} }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  await context.finishDeliveryOrder("order-id");
  assert.deepEqual(filters, [["id", "order-id"], ["delivery_driver_id", "driver-id"], ["status", "Saiu para entrega"]]);
  assert.equal(refreshed, 1);
  assert.match(messages[0], /marcado como entregue/);
});
