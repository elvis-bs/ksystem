import { TabletQueue } from "./tablet-queue.mjs";

const byId = id => document.getElementById(id);
let identity = null;
let catalog = null;
let tables = [];
let busy = false;
let photoUrl = null;
let photoRequest = 0;

async function api(path, body) {
  const headers = { "x-local-request": "1" };
  if (identity) headers.authorization = `Bearer ${identity.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const result = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers, body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit", cache: "no-store"
  });
  const data = await result.json();
  if (!result.ok) throw new Error(data.error || "Falha na comunicação com a loja.");
  return data;
}

const queue = new TabletQueue(localStorage, command => api("/api/table-items", command));
function message(value) { byId("message").textContent = value; }
function option(select, value, label) {
  const entry = document.createElement("option");
  entry.value = value;
  entry.textContent = label;
  select.append(entry);
}
function pendingState() {
  const pending = queue.read();
  byId("pending").hidden = !pending;
  byId("send").disabled = !!pending || busy;
  byId("retry").disabled = busy;
}
function selectedProduct() {
  return catalog?.products.find(product => product.id === byId("product").value);
}
function renderExtras() {
  const product = selectedProduct();
  const flavors = byId("flavors");
  const border = byId("border");
  flavors.replaceChildren();
  border.replaceChildren();
  byId("borderLabel").hidden = product?.category !== "pizza";
  if (!product || product.category !== "pizza") return;
  const size = byId("option").value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const title = document.createElement("p");
  title.textContent = "Sabores";
  flavors.append(title);
  for (const flavor of catalog.products.filter(item => item.category === "pizza"
    && item.sizes.some(entry => entry.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === size))) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = flavor.id;
    input.checked = flavor.id === product.id;
    label.append(input, document.createTextNode(flavor.name));
    flavors.append(label);
  }
  option(border, "", "Sem borda");
  product.borderOptions.forEach((entry, index) => option(border, String(index), `${entry.name} (+ R$ ${Number(entry.price).toFixed(2)})`));
}
function renderProduct() {
  const product = selectedProduct();
  showPhoto(product);
  const select = byId("option");
  select.replaceChildren();
  const addons = byId("addons");
  addons.replaceChildren();
  const legend = document.createElement("legend");
  legend.textContent = "Adicionais";
  addons.append(legend);
  if (!product) { renderExtras(); return; }
  const sizes = product.category === "pizza" ? product.sizes : [{ name: "Padrão", price: product.price }];
  sizes.forEach(entry => option(select, entry.name, `${entry.name} — R$ ${Number(entry.price).toFixed(2)}`));
  product.addons.forEach((entry, index) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(index);
    label.append(input, document.createTextNode(` ${entry.name} (+ R$ ${Number(entry.price).toFixed(2)})`));
    addons.append(label);
  });
  renderExtras();
}
async function showPhoto(product) {
  const sequence = ++photoRequest;
  const image = byId("productPhoto");
  image.hidden = true;
  image.removeAttribute("src");
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  byId("photoStatus").textContent = "";
  if (!product?.hasPhoto) return;
  try {
    const result = await fetch("/api/product-photo", {
      method: "POST", cache: "no-store", credentials: "omit",
      headers: { "content-type": "application/json", "x-local-request": "1", authorization: `Bearer ${identity.token}` },
      body: JSON.stringify({ productId: product.id })
    });
    if (!result.ok || !result.headers.get("content-type")?.startsWith("image/jpeg")) {
      throw new Error("Foto não disponível neste computador.");
    }
    const blob = await result.blob();
    if (sequence !== photoRequest) return;
    photoUrl = URL.createObjectURL(blob);
    image.src = photoUrl;
    image.hidden = false;
  } catch (error) {
    if (sequence === photoRequest) byId("photoStatus").textContent = error.message;
  }
}
function renderTable() {
  const table = tables.find(entry => entry.id === byId("table").value);
  const target = byId("tableItems");
  target.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = table?.order ? "Itens na comanda" : "Mesa sem comanda aberta";
  target.append(title);
  for (const item of table?.order?.items || []) {
    const line = document.createElement("p");
    line.textContent = `${item.quantity} × ${item.name} · ${item.optionName || "Padrão"}`;
    target.append(line);
  }
}
async function refresh() {
  const [nextCatalog, nextTables] = await Promise.all([api("/api/catalog"), api("/api/tables")]);
  catalog = nextCatalog;
  tables = nextTables.tables;
  const table = byId("table");
  const previous = table.value;
  table.replaceChildren();
  tables.forEach(entry => option(table, entry.id, entry.name));
  if (tables.some(entry => entry.id === previous)) table.value = previous;
  const products = byId("product");
  products.replaceChildren();
  catalog.products.forEach(entry => option(products, entry.id, entry.name));
  renderProduct();
  renderTable();
}
async function runSend() {
  busy = true;
  try {
    pendingState();
    const result = await queue.retry(identity);
    message(`Item enviado. Total da comanda: R$ ${result.total.toFixed(2)}.`);
    await refresh();
  } catch (error) {
    message(`${error.message} O pedido continua pendente; confira com o responsável antes de repetir.`);
  } finally {
    busy = false;
    try { pendingState(); } catch (error) { message(error.message); }
  }
}
async function withSendLock(action) {
  if (!navigator.locks) throw new Error("Este navegador não oferece proteção contra envios simultâneos.");
  return navigator.locks.request("bora-tablet-order", { ifAvailable: true }, async lock => {
    if (!lock) throw new Error("Outro envio está em andamento neste tablet.");
    return action();
  });
}
byId("login").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const data = new FormData(form);
    identity = await api("/api/login", { username: data.get("username"), password: data.get("password") });
    form.reset();
    byId("staffName").textContent = identity.name;
    form.hidden = true;
    byId("workspace").hidden = false;
    pendingState();
    await refresh();
    message("Conectado à loja.");
  } catch (error) {
    message(error.message);
  }
});
byId("logout").addEventListener("click", async () => {
  try { await api("/api/logout", {}); } catch (error) { message(`Não foi possível encerrar no servidor: ${error.message}`); }
  identity = null;
  await showPhoto(null);
  byId("workspace").hidden = true;
  byId("login").hidden = false;
});
byId("refresh").addEventListener("click", async () => {
  try { await refresh(); message("Mesas e cardápio atualizados."); } catch (error) { message(error.message); }
});
byId("product").addEventListener("change", renderProduct);
byId("option").addEventListener("change", renderExtras);
byId("table").addEventListener("change", renderTable);
byId("retry").addEventListener("click", async () => {
  try { await withSendLock(runSend); } catch (error) { message(error.message); }
});
window.addEventListener("storage", () => {
  try { pendingState(); } catch (error) { byId("send").disabled = true; message(error.message); }
});
byId("order").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  try {
    const table = tables.find(entry => entry.id === byId("table").value);
    const product = selectedProduct();
    if (!table || !product) throw new Error("Escolha uma mesa e um produto.");
    const item = {
      productId: product.id, optionName: byId("option").value,
      quantity: Number(byId("quantity").value),
      addonIndexes: [...byId("addons").querySelectorAll("input:checked")].map(input => Number(input.value))
    };
    if (product.category === "pizza") {
      item.flavorIds = [...byId("flavors").querySelectorAll("input:checked")].map(input => input.value);
      if (byId("border").value !== "") item.borderIndex = Number(byId("border").value);
      if (!item.flavorIds.length) throw new Error("Escolha pelo menos um sabor.");
    }
    await withSendLock(async () => {
      queue.prepare(identity, {
        commandId: crypto.randomUUID(), tableId: table.id, expectedOrderId: table.order?.id || null, items: [item]
      });
      await runSend();
    });
  } catch (error) { message(error.message); }
});
