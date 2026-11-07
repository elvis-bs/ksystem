import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const sql = readFileSync(new URL("../product-photos.sql", import.meta.url), "utf8");
const userId = "11111111-1111-1111-1111-111111111111";
const oldPhoto = `${userId}/22222222-2222-2222-2222-222222222222.jpg`;
const newPhoto = `${userId}/33333333-3333-3333-3333-333333333333.jpg`;

function extract(name, next) {
  const start = html.indexOf(`      ${name}`);
  const end = html.indexOf(`      ${next}`, start);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}

function setup({ file = null, remove = false, sync = true, uploadError = null } = {}) {
  const calls = [];
  const messages = [];
  const button = { disabled: false };
  const form = { querySelector: selector => selector === "#productPhoto" ? { files: file ? [file] : [] } : button };
  const recipeRow = { querySelector: selector => ({ value: selector.includes("recipeIngredient") ? "i1" : "1" }) };
  const context = {
    state: { products: [{ id: "p1", category: "lanche", photoPath: oldPhoto }], pizzaSizes: [] },
    editingId: "p1", currentUser: { id: userId }, onlineMenuReady: true, PHOTO_BUCKET: "product-photos",
    FormData: class {
      get(key) { return { name: "Lanche", category: "lanche", active: "true", price: "18" }[key]; }
      has(key) { return key === "removePhoto" && remove; }
    },
    document: { querySelectorAll: selector => selector.includes("recipeRows") ? [recipeRow] : [] },
    number: Number, showToast: message => messages.push(message),
    compressProductPhoto: async () => ({ size: 100 }),
    crypto: { randomUUID: () => "33333333-3333-3333-3333-333333333333" },
    supabaseClient: { storage: { from: () => ({
      upload: async (path, blob, options) => { calls.push(["upload", path, blob.size, options.contentType]); return { error: uploadError }; },
      remove: async paths => { calls.push(["remove", ...paths]); return { error: null }; }
    }) } },
    productPhotoUrl: path => path ? `https://example.test/${path}` : "",
    saveState: () => true, syncQueue: Promise.resolve(sync),
    closeModal: () => {}, render: () => {}, console
  };
  vm.createContext(context);
  vm.runInContext(extract("async function deleteProductPhoto(", "function saveIngredient("), context);
  return { context, form, calls, messages, button };
}

test("photo replacement uploads compressed image and removes old file only after sync", async () => {
  const { context, form, calls, button } = setup({ file: { type: "image/png" } });
  await context.saveProduct(form);
  assert.equal(context.state.products[0].photoPath, newPhoto);
  assert.deepEqual(calls, [["upload", newPhoto, 100, "image/jpeg"], ["remove", oldPhoto]]);
  assert.equal(button.disabled, false);
});

test("failed synchronization keeps both photos and reports failure", async () => {
  const { context, form, calls, messages } = setup({ file: { type: "image/png" }, sync: false });
  await context.saveProduct(form);
  assert.deepEqual(calls, [["upload", newPhoto, 100, "image/jpeg"]]);
  assert.match(messages.at(-1), /não foi sincronizada/);
});

test("removal deletes old photo only after synchronization", async () => {
  const { context, form, calls } = setup({ remove: true });
  await context.saveProduct(form);
  assert.equal(context.state.products[0].photoPath, undefined);
  assert.deepEqual(calls, [["remove", oldPhoto]]);
});

test("editing product without a photo change preserves its photo", async () => {
  const { context, form, calls } = setup();
  await context.saveProduct(form);
  assert.equal(context.state.products[0].photoPath, oldPhoto);
  assert.equal(calls.length, 0);
});

test("upload failure leaves existing product untouched", async () => {
  const { context, form, messages } = setup({ file: { type: "image/png" }, uploadError: new Error("upload failed") });
  await context.saveProduct(form);
  assert.equal(context.state.products[0].photoPath, oldPhoto);
  assert.match(messages.at(-1), /upload failed/);
});

test("public URLs accept only owned-style JPEG paths, not arbitrary URLs", () => {
  const context = { SUPABASE_URL: "https://example.test", PHOTO_BUCKET: "product-photos" };
  vm.createContext(context);
  vm.runInContext(extract("function productPhotoUrl(", "async function syncPublicMenu("), context);
  assert.equal(context.productPhotoUrl(oldPhoto), `https://example.test/storage/v1/object/public/product-photos/${oldPhoto}`);
  assert.equal(context.productPhotoUrl("https://example.test/file.jpg"), "");
  assert.equal(context.productPhotoUrl(`${userId}/../../secret.jpg`), "");
});

test("compression limits dimensions and retries quality until under 512 KB", async () => {
  const revoked = [];
  const qualities = [];
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ fillRect() {}, drawImage() {} }),
    toBlob: (callback, type, quality) => {
      assert.equal(type, "image/jpeg");
      qualities.push(quality);
      callback({ size: qualities.length === 1 ? 600_000 : 200_000 });
    }
  };
  class ImageMock {
    naturalWidth = 2400;
    naturalHeight = 1200;
    async decode() {}
  }
  const context = {
    PHOTO_MAX_BYTES: 512 * 1024, Image: ImageMock,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: value => revoked.push(value) },
    document: { createElement: () => canvas }
  };
  vm.createContext(context);
  vm.runInContext(extract("async function compressProductPhoto(", "async function deleteProductPhoto("), context);
  assert.equal((await context.compressProductPhoto({ type: "image/png", size: 2_000_000 })).size, 200_000);
  assert.equal(canvas.width, 1200);
  assert.equal(canvas.height, 600);
  assert.deepEqual(qualities, [0.82, 0.7]);
  assert.deepEqual(revoked, ["blob:test"]);
  await assert.rejects(context.compressProductPhoto({ type: "image/gif", size: 10 }), /JPG, PNG ou WebP/);
  await assert.rejects(context.compressProductPhoto({ type: "image/jpeg", size: 11 * 1024 * 1024 }), /10 MB/);
});

test("storage policies limit mutations to authenticated owners", () => {
  assert.match(sql, /file_size_limit, allowed_mime_types/);
  assert.match(sql, /524288, array\['image\/jpeg'\]/);
  assert.match(sql, /for insert to authenticated/);
  assert.match(sql, /for delete to authenticated/);
  assert.equal((sql.match(/\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/g) || []).length, 3);
});
