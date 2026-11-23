import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { storeAvailability } from "../supabase/functions/_shared/store-hours.ts";

const source = readFileSync(new URL("../supabase/functions/create-cash-order/index.ts", import.meta.url), "utf8")
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*/g, "");
const javascript = stripTypeScriptTypes(source);
const businessId = "00000000-0000-0000-0000-000000000000";
const hours = [null, { enabled: true, open: "18:00", close: "23:00" }, { enabled: true, open: "18:00", close: "23:00" }];

function createHandler(cashSessions, acceptingOrders = true, presence = null) {
  let handler;
  const client = {
    from(table) {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: table === "business_data"
            ? { data: { cashSessions, storeSettings: { hours } } }
            : { menu: { acceptingOrders }, pickup_enabled: false },
          error: null
        })
      };
      return query;
    },
    rpc: async name => {
      assert.equal(name, "experimental_store_is_present");
      return presence;
    }
  };
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ["2026-11-09T21:05:00Z"]));
    }
  }
  vm.runInNewContext(javascript, {
    adminClient: () => client,
    storeAvailability: settings => storeAvailability(settings, new FixedDate()),
    Deno: {
      serve: callback => { handler = callback; },
      env: { get: key => key === "EXPERIMENTAL_OFFLINE_PRESENCE" && presence !== null ? "true" : undefined }
    },
    Date: FixedDate,
    Response,
    console: { error() {} }
  });
  return handler;
}

function request(body) {
  return new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ businessId, ...body })
  });
}

test("closed cash rejects orders and reports the next future scheduled opening", async () => {
  const handler = createHandler([{ closedAt: "2026-11-09T20:00:00Z" }]);
  const availability = await handler(request({ action: "payment_methods" }));
  assert.deepEqual(await availability.json(), {
    paymentMethods: [], storeOpen: false, nextOpening: "amanhã às 18:00"
  });
  const order = await handler(request({}));
  assert.equal(order.status, 409);
});

test("disabled online ordering stays closed even with open cash", async () => {
  const handler = createHandler([{}], false);
  const response = await handler(request({ action: "payment_methods" }));
  assert.deepEqual(await response.json(), {
    paymentMethods: [], storeOpen: false, nextOpening: "amanhã às 18:00"
  });
});

test("open cash and an active schedule preserve payment availability", async () => {
  const handler = createHandler([{}]);
  const response = await handler(request({ action: "payment_methods" }));
  assert.deepEqual(await response.json(), {
    paymentMethods: ["cash_on_delivery"], storeOpen: true, supportsRemovedIngredients: true, supportsItemNotes: true
  });
});

test("experimental presence closes payment availability and order creation when disconnected", async () => {
  const handler = createHandler([{}], true, { data: false, error: null });
  const availability = await handler(request({ action: "payment_methods" }));
  assert.deepEqual(await availability.json(), {
    paymentMethods: [], storeOpen: false, nextOpening: null
  });
  const order = await handler(request({}));
  assert.equal(order.status, 409);
});

test("experimental presence errors fail closed and online presence retains existing rules", async () => {
  for (const presence of [{ data: null, error: { message: "unavailable" } }, { data: null, error: null }]) {
    const response = await createHandler([{}], true, presence)(request({ action: "payment_methods" }));
    assert.equal(response.status, 500);
    assert.equal((await response.json()).storeOpen, undefined);
  }
  const connected = createHandler([{}], true, { data: true, error: null });
  assert.equal((await (await connected(request({ action: "payment_methods" }))).json()).storeOpen, true);
  const manuallyClosed = createHandler([{}], false, { data: true, error: null });
  assert.equal((await (await manuallyClosed(request({ action: "payment_methods" }))).json()).storeOpen, false);
  const cashClosed = createHandler([], true, { data: true, error: null });
  assert.equal((await (await cashClosed(request({ action: "payment_methods" }))).json()).storeOpen, false);
});
