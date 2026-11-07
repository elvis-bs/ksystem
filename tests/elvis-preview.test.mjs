import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function publicFunction(name, nextName) {
  const start = html.indexOf(`      ${name}`);
  const end = html.indexOf(`      ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `Could not find ${name}`);
  return html.slice(start, end);
}

test("preview checkout never creates an order or Pix charge", async () => {
  const source = publicFunction("async function submitDigitalOrder(", "function startPixPaymentStatusPolling(");
  let requests = 0;
  const messages = [];
  const context = {
    elvisPreview: true,
    digitalCart: [{ productId: "p1" }],
    supabaseClient: { functions: { invoke: () => { requests++; } } },
    showToast: message => messages.push(message)
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  let prevented = false;
  await context.submitDigitalOrder({
    preventDefault: () => { prevented = true; },
    currentTarget: { reportValidity: () => true }
  });
  assert.equal(prevented, true);
  assert.equal(requests, 0);
  assert.match(messages[0], /nenhum pedido foi enviado/);
});

test("preview product rejects invalid quantity and preserves valid quantity", () => {
  const source = publicFunction("function addDigitalItem(", "async function submitDigitalOrder(");
  const product = { id: "p1", name: "Suco", category: "bebida", active: true, price: 8, addons: [] };
  let valid = false;
  const quantity = { value: "2", reportValidity: () => valid };
  const card = {
    querySelector(selector) {
      if (selector === "[data-preview-quantity]") return quantity;
      if (selector === "[data-public-option]") return { value: "0" };
      return null;
    },
    querySelectorAll: () => []
  };
  const context = {
    state: { products: [product] }, elvisPreview: true,
    document: { querySelector: () => card },
    productOptions: p => [{ name: "Padrão", price: p.price }],
    number: Number, roundMoney: value => value, productCost: () => 0,
    digitalCart: [], showToast: () => {}, renderPublicMenu: () => {},
    currentOrderConfirmation: "", currentPixPayment: null, pixPaymentStatusTimer: null
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.addDigitalItem("p1");
  assert.equal(context.digitalCart.length, 0);
  valid = true;
  context.addDigitalItem("p1");
  assert.equal(context.digitalCart.length, 1);
  assert.equal(context.digitalCart[0].quantity, 2);
});

test("preview keeps removed ingredients per item without changing the price", () => {
  const source = publicFunction("function addDigitalItem(", "async function submitDigitalOrder(");
  const product = { id: "p1", name: "Lanche", category: "lanche", active: true, price: 18, addons: [], ingredients: ["Cebola", "Queijo"] };
  let selected = [{ dataset: { previewRemoveIngredient: "0" } }];
  const card = {
    querySelector(selector) {
      if (selector === "[data-preview-quantity]") return { value: "1", reportValidity: () => true };
      if (selector === "[data-public-option]") return { value: "0" };
      return null;
    },
    querySelectorAll: selector => selector === "[data-preview-remove-ingredient]:checked" ? selected : []
  };
  const context = {
    state: { products: [product] }, elvisPreview: true,
    document: { querySelector: () => card },
    productOptions: p => [{ name: "Padrão", price: p.price }],
    number: Number, roundMoney: value => value, productCost: () => 0,
    digitalCart: [], showToast: () => {}, renderPublicMenu: () => {},
    currentOrderConfirmation: "", currentPixPayment: null, pixPaymentStatusTimer: null
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.addDigitalItem("p1");
  selected = [{ dataset: { previewRemoveIngredient: "1" } }];
  context.addDigitalItem("p1");
  assert.deepEqual(Array.from(context.digitalCart[0].removedIngredients), ["Cebola"]);
  assert.deepEqual(Array.from(context.digitalCart[1].removedIngredients), ["Queijo"]);
  assert.equal(context.digitalCart[0].price, 18);
  assert.equal(context.digitalCart[1].price, 18);
});
