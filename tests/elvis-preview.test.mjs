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

test("public menu publishes only the configured store name from receipt settings", () => {
  const source = publicFunction("function publicMenuSnapshot(", "async function syncPublicMenu(");
  const context = {
    seedData: { onlineOrdering: {} },
    normalizePizzaSizes: () => [], normalizedStoreSettings: () => ({})
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const snapshot = context.publicMenuSnapshot({
    products: [], receiptSettings: { storeName: "  Minha Lanchonete  ", phone: "privado", cnpj: "privado" }
  });
  assert.equal(snapshot.storeName, "Minha Lanchonete");
  assert.equal(snapshot.receiptSettings, undefined);
  assert.equal(snapshot.storeSettings.phone, undefined);
  assert.equal(context.publicMenuSnapshot({ products: [] }).storeName, "");
});

test("both Elvis views display the escaped configured name and a generic fallback", () => {
  const source = publicFunction("function renderElvisPreviewHero(", "function setupElvisPreview(");
  const context = {
    state: { storeName: 'Lanches <& "Casa">' }, publicStoreOpen: true,
    elvisPreview: false, elvisHeroShown: true, elvisMotionEnabled: false,
    publicOrdering: { deliveryFee: 0, pickupEnabled: false },
    escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  for (const preview of [true, false]) {
    context.elvisPreview = preview;
    const output = context.renderElvisPreviewHero();
    assert.equal((output.match(/Lanches &lt;&amp; &quot;Casa&quot;&gt;/g) || []).length, 4);
    assert.match(output, /textLength="680"/);
    assert.doesNotMatch(output, /ELVIS NA CHAPA/);
  }
  context.state.storeName = " ";
  assert.match(context.renderElvisPreviewHero(), /Minha loja/);
});

test("availability refresh updates the public store name", async () => {
  const source = publicFunction("async function refreshPublicAvailability(", "async function initializeAuth(");
  let renders = 0;
  const query = {
    select: () => query, eq: () => query,
    maybeSingle: async () => ({
      data: { menu: { storeName: "Nome atualizado", storeSettings: {}, acceptingOrders: true } }, error: null
    })
  };
  const context = {
    state: { storeName: "Nome anterior", storeSettings: {} },
    publicOrdering: { acceptingOrders: true }, publicBusinessId: "store",
    publicStoreOpen: true, publicNextOpening: null,
    publicSupportsRemovedIngredients: true, publicSupportsItemNotes: true,
    supportedDigitalPaymentMethods: ["cash_on_delivery"],
    supabaseClient: {
      from: () => query,
      functions: { invoke: async () => ({ data: { storeOpen: true, paymentMethods: ["cash_on_delivery"], supportsRemovedIngredients: true, supportsItemNotes: true }, error: null }) }
    },
    document: { getElementById: () => null }, renderPublicMenu: () => { renders++; }, console
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.refreshPublicAvailability();
  assert.equal(context.state.storeName, "Nome atualizado");
  assert.equal(renders, 1);
  await context.refreshPublicAvailability();
  assert.equal(renders, 1);
});

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
    state: { products: [product] }, elvisVisual: true,
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
    state: { products: [product] }, elvisVisual: true,
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

test("item notes are independent and apply to the selected quantity", () => {
  const source = publicFunction("function addDigitalItem(", "async function submitDigitalOrder(");
  const product = { id: "p1", name: "Lanche", category: "lanche", active: true, price: 18, addons: [], ingredients: [] };
  let note = "  Bem passado  ";
  const card = {
    querySelector(selector) {
      if (selector === "[data-preview-quantity]") return { value: "2", reportValidity: () => true };
      if (selector === "[data-public-option]") return { value: "0" };
      if (selector === "[data-item-notes]") return { value: note };
      return null;
    },
    querySelectorAll: () => []
  };
  const context = {
    state: { products: [product] }, elvisVisual: true,
    document: { querySelector: () => card },
    productOptions: p => [{ name: "Padrão", price: p.price }],
    number: Number, roundMoney: value => value, productCost: () => 0,
    digitalCart: [], showToast: () => {}, renderPublicMenu: () => {},
    currentOrderConfirmation: "", currentPixPayment: null, pixPaymentStatusTimer: null
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.addDigitalItem("p1");
  note = "Outro ponto";
  context.addDigitalItem("p1");
  assert.equal(context.digitalCart[0].notes, "Bem passado");
  assert.equal(context.digitalCart[0].quantity, 2);
  assert.equal(context.digitalCart[1].notes, "Outro ponto");
  assert.equal(context.digitalCart[0].price, 18);
});

test("checkout refuses to discard item notes when server support is unavailable", async () => {
  const source = publicFunction("async function submitDigitalOrder(", "function startPixPaymentStatusPolling(");
  let requests = 0;
  const messages = [];
  const context = {
    elvisPreview: false, elvisVisual: true, publicSupportsRemovedIngredients: true,
    publicSupportsItemNotes: false, digitalCart: [{ notes: "Sem sal" }],
    supabaseClient: { functions: { invoke: () => { requests++; } } },
    showToast: message => messages.push(message)
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.submitDigitalOrder({ preventDefault: () => {} });
  assert.equal(requests, 0);
  assert.match(messages[0], /Não foi possível enviar as observações/);
});

test("real checkout sends item notes for cash and Pix", async () => {
  const source = publicFunction("async function submitDigitalOrder(", "function startPixPaymentStatusPolling(");
  for (const paymentMethod of ["cash_on_delivery", "pix"]) {
    let sent;
    const form = { reportValidity: () => true, querySelector: () => ({}) };
    const context = {
      elvisPreview: false, elvisVisual: true, publicSupportsRemovedIngredients: true,
      publicSupportsItemNotes: true, publicBusinessId: "store",
      digitalPaymentMethod: paymentMethod, digitalFulfillment: "delivery",
      supportedDigitalPaymentMethods: [paymentMethod],
      digitalCart: [{ productId: "p1", optionName: "Padrão", quantity: 2, notes: "Bem passado" }],
      supabaseClient: { functions: { invoke: async (_, request) => {
        sent = request.body;
        return { data: { orderId: "order1", paymentStatus: "pending", pix: { qrCode: "simulado" } } };
      } } },
      FormData: class { get() { return ""; } },
      document: { getElementById: () => null }, renderPublicMenu: () => {}, showToast: () => {},
      startPixPaymentStatusPolling: () => {}, console
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    await context.submitDigitalOrder({ preventDefault: () => {}, currentTarget: form });
    assert.equal(sent.paymentMethod, paymentMethod);
    assert.equal(sent.items[0].notes, "Bem passado");
    assert.equal(sent.items[0].quantity, 2);
  }
});

test("online receipt includes removed ingredients and escaped item notes", () => {
  const source = publicFunction("function printReceipt(", "function orderCanTriggerAlert(");
  let htmlOutput = "";
  const receiptWindow = {
    document: { open: () => {}, write: value => { htmlOutput = value; }, close: () => {} },
    addEventListener: () => {}
  };
  const context = {
    seedData: { receiptSettings: {} }, state: { receiptSettings: {} },
    window: { open: () => receiptWindow },
    number: Number, saleLineTotal: item => item.price * item.quantity,
    money: value => `R$ ${value}`, escapeHtml: value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    receiptPaymentStatus: () => "A receber", setTimeout: () => {}
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.printReceipt({
    id: "order1", createdAt: "2026-01-01T00:00:00Z",
    items: [{ name: "Lanche", price: 18, quantity: 1, removedIngredients: ["Cebola"], notes: "<bem passado>", addons: [] }]
  });
  assert.match(htmlOutput, /Sem Cebola/);
  assert.match(htmlOutput, /Obs\.: &lt;bem passado&gt;/);
});
