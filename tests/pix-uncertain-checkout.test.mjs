import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("      async function submitDigitalOrder(");
const end = html.indexOf("      function startPixPaymentStatusPolling(", start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end);

async function submit(method, invoke) {
  const messages = [];
  const button = { disabled: false, textContent: "" };
  const form = { reportValidity: () => true, querySelector: () => button };
  const context = {
    digitalCart: [{ productId: "p1", optionName: "Padrão", quantity: 1 }],
    elvisPreview: false, elvisVisual: false, digitalPaymentMethod: method,
    supportedDigitalPaymentMethods: [method], publicBusinessId: "business",
    digitalFulfillment: "pickup", publicOrdering: { deliveryFee: 0 },
    supabaseClient: { functions: { invoke } },
    showToast: message => messages.push(message),
    FormData: class { get() { return ""; } },
    saleLineTotal: () => 10, roundMoney: value => value, money: value => String(value),
    console: { error() {} }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.submitDigitalOrder({ preventDefault() {}, currentTarget: form });
  return { messages, button };
}

test("Pix network failures ask customers to verify with the store before retrying", async () => {
  for (const invoke of [
    async () => { throw new Error("network lost"); },
    async () => ({ data: null, error: { message: "network lost" } })
  ]) {
    const result = await submit("pix", invoke);
    assert.match(result.messages[0], /Antes de tentar novamente, verifique com a loja/);
    assert.equal(result.button.disabled, false);
  }
});

test("server's uncertain Pix response is shown and cash failures keep their existing message", async () => {
  const warning = "Pedido #12345678: confirme com a loja antes de repetir.";
  const pix = await submit("pix", async () => ({
    data: null, error: { context: { status: 503, json: async () => ({ error: warning }) } }
  }));
  assert.equal(pix.messages[0], warning);
  const cash = await submit("cash_on_pickup", async () => { throw new Error("network lost"); });
  assert.match(cash.messages[0], /Verifique sua conexão e tente novamente/);
});
