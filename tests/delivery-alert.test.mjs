import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("      function updateDriverAlertControls(");
const end = html.indexOf("      async function openAuthenticatedSession(", start);
const refreshStart = html.indexOf("      async function refreshDriverOrders(");
const refreshEnd = html.indexOf("      function driverOrderCard(", refreshStart);
assert.ok(start >= 0 && end > start && refreshStart >= 0 && refreshEnd > refreshStart);

function setup() {
  const elements = {
    driverAlertButton: {
      textContent: "", disabled: false,
      classList: { toggle() {} },
      setAttribute(name, value) { this[name] = value; }
    },
    driverAlertStatus: { textContent: "" }
  };
  const sounds = [];
  let disconnected = 0;
  class AudioContext {
    state = "suspended";
    currentTime = 0;
    destination = {};
    async resume() { this.state = "running"; }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnect() { disconnected++; }
      };
    }
    createOscillator() {
      return {
        frequency: {}, connect() {}, stop() {},
        start() { sounds.push(true); }
      };
    }
  }
  const ctx = {
    window: { AudioContext },
    document: { hidden: false, getElementById: id => elements[id] },
    driverAlertEnabled: false, driverAlertAudioContext: null, driverAlertGain: null,
    currentUser: { id: "driver" }, driverProfile: { user_id: "driver", active: true },
    driverOrders: [], driverOrdersError: "", isDriverPortal: true,
    console: { error() {} },
    renderDriverPortal() {},
    supabaseClient: {
      from(table) {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() { return ctx.profileResult; },
          async order() { return ctx.ordersResult; }
        };
        assert.ok(["delivery_drivers", "online_orders"].includes(table));
        return query;
      }
    },
    profileResult: { data: { active: true }, error: null },
    ordersResult: { data: [], error: null }
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end) + html.slice(refreshStart, refreshEnd), ctx);
  return { ctx, elements, sounds, getDisconnected: () => disconnected };
}

test("driver enables a distinct alert, can silence it, and audio is disconnected", async () => {
  const { ctx, elements, sounds, getDisconnected } = setup();
  await ctx.toggleDriverAlert();
  assert.equal(ctx.driverAlertEnabled, true);
  assert.equal(sounds.length, 4);
  assert.equal(elements.driverAlertButton.textContent, "Silenciar alerta");
  assert.equal(elements.driverAlertButton["aria-pressed"], "true");
  await ctx.toggleDriverAlert();
  assert.equal(ctx.driverAlertEnabled, false);
  assert.equal(getDisconnected(), 1);
  assert.equal(elements.driverAlertButton.textContent, "Ativar alerta sonoro");
});

test("successful refresh repeats only for unassigned available orders while visible", async () => {
  const { ctx, sounds } = setup();
  await ctx.toggleDriverAlert();
  ctx.ordersResult.data = [
    { status: "Saiu para entrega", delivery_driver_id: "driver" },
    { status: "Concluído", delivery_driver_id: null }
  ];
  await ctx.refreshDriverOrders();
  assert.equal(sounds.length, 4);
  ctx.ordersResult.data.push({ status: "Saiu para entrega", delivery_driver_id: null });
  await ctx.refreshDriverOrders();
  await ctx.refreshDriverOrders();
  assert.equal(sounds.length, 12);
  ctx.document.hidden = true;
  await ctx.refreshDriverOrders();
  assert.equal(sounds.length, 12);
  ctx.document.hidden = false;
  ctx.ordersResult = { data: null, error: new Error("offline") };
  await ctx.refreshDriverOrders();
  assert.equal(sounds.length, 12);
  await ctx.toggleDriverAlert();
  ctx.ordersResult = { data: [{ status: "Saiu para entrega", delivery_driver_id: null }], error: null };
  await ctx.refreshDriverOrders();
  assert.equal(sounds.length, 12);
});

test("pausing the driver's access disables the alert and reports the reason", async () => {
  const { ctx, elements, getDisconnected } = setup();
  await ctx.toggleDriverAlert();
  ctx.profileResult.data.active = false;
  assert.equal(await ctx.refreshDriverOrders(), false);
  assert.equal(ctx.driverAlertEnabled, false);
  assert.equal(getDisconnected(), 1);
  assert.match(elements.driverAlertStatus.textContent, /acesso está pausado/);
});

test("audio failure is visible and never leaves the alert marked active", async () => {
  const { ctx, elements } = setup();
  ctx.window.AudioContext = class { async resume() { throw new Error("blocked"); } };
  await ctx.toggleDriverAlert();
  assert.equal(ctx.driverAlertEnabled, false);
  assert.equal(elements.driverAlertButton.disabled, false);
  assert.match(elements.driverAlertStatus.textContent, /Não foi possível ativar/);
  ctx.window.AudioContext = undefined;
  await ctx.toggleDriverAlert();
  assert.match(elements.driverAlertStatus.textContent, /não oferece suporte/);
});
