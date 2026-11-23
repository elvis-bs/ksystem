import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { checkPassword, passwordHash } from "./password-verifier.mjs";

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

function emailAddress(value) {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new TypeError("Invalid email");
  }
  return value.trim().toLowerCase();
}

export class OfflineAuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = "OfflineAuthenticationError";
  }
}

export class OfflineAuth {
  constructor(filename) {
    if (filename instanceof DatabaseSync) {
      this.db = filename;
      this.ownsConnection = false;
    } else {
      if (typeof filename !== "string" || !filename.trim()) throw new TypeError("filename is required");
      this.db = new DatabaseSync(filename);
      this.ownsConnection = true;
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS offline_credentials (
        email TEXT PRIMARY KEY,
        business_id TEXT NOT NULL UNIQUE,
        salt BLOB NOT NULL CHECK (length(salt) = 16),
        verifier BLOB NOT NULL CHECK (length(verifier) = 32),
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        locked_until INTEGER NOT NULL DEFAULT 0 CHECK (locked_until >= 0)
      ) STRICT;
    `);
  }

  close() {
    if (this.ownsConnection) this.db.close();
  }

  async provision(email, password, client) {
    const normalizedEmail = emailAddress(email);
    checkPassword(password);
    if (!client || typeof client.auth?.signInWithPassword !== "function") {
      throw new TypeError("Online authentication client is required");
    }
    const { data, error } = await client.auth.signInWithPassword({ email: normalizedEmail, password });
    if (error) throw new OfflineAuthenticationError("Online authentication failed");
    const user = data?.user;
    if (!data?.session || !user || data.session.user?.id !== user.id || typeof user.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)
      || typeof user.email !== "string" || user.email.trim().toLowerCase() !== normalizedEmail) {
      throw new OfflineAuthenticationError("Online authentication returned an invalid account");
    }
    const salt = randomBytes(16);
    const verifier = await passwordHash(password, salt);
    try {
      this.db.prepare(`
        INSERT INTO offline_credentials (email, business_id, salt, verifier)
        VALUES (?, ?, ?, ?)
      `).run(normalizedEmail, user.id, salt, verifier);
    } finally {
      verifier.fill(0);
    }
    return { businessId: user.id, email: normalizedEmail };
  }

  async authenticate(email, password, { session = false } = {}) {
    const normalizedEmail = emailAddress(email);
    checkPassword(password);
    const initial = this.db.prepare(`
      SELECT salt, verifier FROM offline_credentials WHERE email = ?
    `).get(normalizedEmail);
    if (!initial) throw new OfflineAuthenticationError("Invalid credentials");
    const candidate = await passwordHash(password, initial.salt);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.db.prepare(`
          SELECT business_id, salt, verifier, failed_attempts, locked_until
          FROM offline_credentials WHERE email = ?
        `).get(normalizedEmail);
        if (!row || !timingSafeEqual(row.salt, initial.salt)
          || !timingSafeEqual(row.verifier, initial.verifier)) {
          throw new OfflineAuthenticationError("Credentials changed; try again");
        }
        const now = Date.now();
        if (row.locked_until > now) throw new OfflineAuthenticationError("Account temporarily locked");
        if (!timingSafeEqual(candidate, row.verifier)) {
          const attempts = row.locked_until ? 1 : row.failed_attempts + 1;
          this.db.prepare(`
            UPDATE offline_credentials SET failed_attempts = ?, locked_until = ? WHERE email = ?
          `).run(attempts, attempts >= MAX_ATTEMPTS ? now + LOCKOUT_MS : 0, normalizedEmail);
          this.db.exec("COMMIT");
          throw new OfflineAuthenticationError("Invalid credentials");
        }
        this.db.prepare(`
          UPDATE offline_credentials SET failed_attempts = 0, locked_until = 0 WHERE email = ?
        `).run(normalizedEmail);
        this.db.exec("COMMIT");
        const identity = { businessId: row.business_id, email: normalizedEmail };
        if (session) identity.credentialTag = credentialTag(row.salt, row.verifier);
        return identity;
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      candidate.fill(0);
    }
  }

  isCurrent(identity) {
    if (!identity || typeof identity.email !== "string" || typeof identity.businessId !== "string"
      || typeof identity.credentialTag !== "string") return false;
    const row = this.db.prepare(`
      SELECT business_id, salt, verifier FROM offline_credentials WHERE email = ?
    `).get(identity.email);
    return Boolean(row && row.business_id === identity.businessId
      && credentialTag(row.salt, row.verifier) === identity.credentialTag);
  }
}

function credentialTag(salt, verifier) {
  return createHash("sha256").update(salt).update(verifier).digest("hex");
}
