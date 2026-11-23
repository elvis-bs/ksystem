const PHOTO_PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f-]{36}\.jpg$/i;
const MAX_PHOTO_SIZE = 512 * 1024;
const MAX_TOTAL_SIZE = 64 * 1024 * 1024;

function photoPaths(businessId, snapshot) {
  const paths = new Set();
  for (const product of snapshot.products) {
    if (product.category !== "lanche" || !product.photoPath) continue;
    const match = typeof product.photoPath === "string" && PHOTO_PATH.exec(product.photoPath);
    if (!match || match[1].toLowerCase() !== businessId.toLowerCase()) {
      throw new Error("Invalid product photo path");
    }
    paths.add(product.photoPath);
  }
  return [...paths];
}

function checkedPhoto(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > MAX_PHOTO_SIZE
    || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new Error("Invalid product photo");
  }
  return bytes;
}

export class PhotoCache {
  constructor(store) {
    if (!store?.db || typeof store.read !== "function") throw new TypeError("Store is required");
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS offline_photos (
        business_id TEXT NOT NULL REFERENCES offline_business(business_id),
        photo_path TEXT NOT NULL,
        content BLOB NOT NULL CHECK (length(content) BETWEEN 4 AND 524288),
        PRIMARY KEY (business_id, photo_path)
      ) STRICT;
    `);
  }

  async stage(businessId, snapshot, download) {
    if (typeof businessId !== "string" || !snapshot || !Array.isArray(snapshot.products)
      || typeof download !== "function") throw new TypeError("Invalid photo refresh");
    const paths = photoPaths(businessId, snapshot);
    const pending = [];
    let total = 0;
    for (const path of paths) {
      const cached = this.store.db.prepare(
        "SELECT content FROM offline_photos WHERE business_id = ? AND photo_path = ?"
      ).get(businessId, path);
      if (cached) {
        total += checkedPhoto(cached.content).length;
      } else {
        const content = Buffer.from(checkedPhoto(await download(path)));
        total += content.length;
        pending.push({ path, content });
      }
      if (total > MAX_TOTAL_SIZE) throw new Error("Photo cache size limit exceeded");
    }
    return { paths, pending };
  }

  commit(businessId, staged) {
    const insert = this.store.db.prepare(`
      INSERT INTO offline_photos (business_id, photo_path, content) VALUES (?, ?, ?)
      ON CONFLICT (business_id, photo_path) DO NOTHING
    `);
    for (const photo of staged.pending) insert.run(businessId, photo.path, photo.content);
    for (const path of staged.paths) {
      const row = this.store.db.prepare(
        "SELECT content FROM offline_photos WHERE business_id = ? AND photo_path = ?"
      ).get(businessId, path);
      if (!row) throw new Error("Photo disappeared during preparation");
      checkedPhoto(row.content);
      const downloaded = staged.pending.find(photo => photo.path === path);
      if (downloaded && !Buffer.from(row.content).equals(downloaded.content)) {
        throw new Error("Photo changed during preparation");
      }
    }
    return { photoCount: staged.paths.length, downloaded: staged.pending.length };
  }

  async refresh(businessId, download) {
    const snapshot = this.store.read(businessId);
    if (!snapshot) throw new Error("Local snapshot does not exist");
    const staged = await this.stage(businessId, snapshot.snapshot, download);
    return this.store.transaction(() => {
      const current = this.store.read(businessId);
      if (!current || current.localRevision !== snapshot.localRevision) throw new Error("Local snapshot changed during photo download");
      return this.commit(businessId, staged);
    });
  }

  getForProduct(businessId, productId) {
    const local = this.store.read(businessId);
    if (!local) throw new Error("Local snapshot does not exist");
    const matches = local.snapshot.products.filter(product => product.id === productId && product.active === true);
    if (matches.length !== 1 || matches[0].category !== "lanche" || !matches[0].photoPath) return null;
    const path = matches[0].photoPath;
    photoPaths(businessId, { products: [matches[0]] });
    const row = this.store.db.prepare(
      "SELECT content FROM offline_photos WHERE business_id = ? AND photo_path = ?"
    ).get(businessId, path);
    if (!row) throw new Error("Product photo is not available locally");
    return Buffer.from(checkedPhoto(row.content));
  }
}

export function createSupabasePhotoDownloader(client) {
  if (!client?.storage || typeof client.storage.from !== "function") throw new TypeError("Storage client is required");
  return async path => {
    if (typeof path !== "string" || !PHOTO_PATH.test(path)) throw new TypeError("Invalid photo path");
    const { data, error } = await client.storage.from("product-photos").download(path);
    if (error) throw new Error(`Photo download failed: ${error.message}`, { cause: error });
    if (!data || !Number.isSafeInteger(data.size) || data.size > MAX_PHOTO_SIZE
      || typeof data.arrayBuffer !== "function") throw new Error("Invalid photo download");
    return new Uint8Array(await data.arrayBuffer());
  };
}
