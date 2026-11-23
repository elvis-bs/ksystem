import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("tablet retry acquires the shared lock and reaches the pending queue", async () => {
  const source = readFileSync(new URL("../local/tablet.mjs", import.meta.url), "utf8")
    .replace('import { TabletQueue } from "./tablet-queue.mjs";', "");
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, textContent: "", hidden: false, disabled: false,
      addEventListener(type, handler) { this.listeners[type] = handler; }
    });
    return elements.get(id);
  };
  let retries = 0;
  let locks = 0;
  const context = {
    document: { getElementById: element },
    window: { addEventListener() {} }, localStorage: {},
    navigator: { locks: { request: async (name, options, action) => {
      locks++;
      assert.equal(name, "bora-tablet-order");
      assert.equal(options.ifAvailable, true);
      return action({});
    } } },
    TabletQueue: class {
      read() { return null; }
      async retry() { retries++; throw new Error("Falha simulada"); }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await element("retry").listeners.click();
  assert.equal(locks, 1);
  assert.equal(retries, 1);
  assert.match(element("message").textContent, /Falha simulada/);
});
