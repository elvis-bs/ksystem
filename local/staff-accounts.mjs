import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { checkPassword, passwordHash } from "./password-verifier.mjs";

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

function business(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new TypeError("Invalid business ID");
  return value;
}

function username(value) {
  if (typeof value !== "string" || !/^[a-z0-9._-]{3,40}$/i.test(value)) throw new TypeError("Invalid username");
  return value.toLowerCase();
}

function name(value) {
  if (typeof value !== "string" || value.trim().length < 2 || value.length > 80) throw new TypeError("Invalid name");
  return value.trim();
}

export class StaffAuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = "StaffAuthenticationError";
  }
}

export class StaffAccounts {
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
      CREATE TABLE IF NOT EXISTS offline_staff (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        username TEXT NOT NULL,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        salt BLOB NOT NULL CHECK (length(salt) = 16),
        verifier BLOB NOT NULL CHECK (length(verifier) = 32),
        credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        locked_until INTEGER NOT NULL DEFAULT 0 CHECK (locked_until >= 0),
        UNIQUE (business_id, username)
      ) STRICT;
    `);
  }

  close() {
    if (this.ownsConnection) this.db.close();
  }

  async create(businessId, account, password) {
    businessId = business(businessId);
    if (!account || typeof account !== "object") throw new TypeError("Invalid staff account");
    const login = username(account.username);
    const displayName = name(account.name);
    checkPassword(password, 8);
    const salt = randomBytes(16);
    const verifier = await passwordHash(password, salt);
    const id = randomUUID();
    try {
      this.db.prepare(`
        INSERT INTO offline_staff (id, business_id, username, name, salt, verifier)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, businessId, login, displayName, salt, verifier);
    } finally {
      verifier.fill(0);
    }
    return { id, username: login, name: displayName, active: true };
  }

  list(businessId) {
    businessId = business(businessId);
    return this.db.prepare(`
      SELECT id, username, name, active FROM offline_staff
      WHERE business_id = ? ORDER BY name, username
    `).all(businessId).map(row => ({ ...row, active: row.active === 1 }));
  }

  setActive(businessId, id, active) {
    businessId = business(businessId);
    if (typeof id !== "string" || !id || typeof active !== "boolean") throw new TypeError("Invalid account status");
    const result = this.db.prepare(`
      UPDATE offline_staff SET active = ?, credential_version = credential_version + 1
      WHERE business_id = ? AND id = ? AND active <> ?
    `).run(active ? 1 : 0, businessId, id, active ? 1 : 0);
    if (result.changes !== 1) throw new Error("Staff account not found or status unchanged");
  }

  async resetPassword(businessId, id, password) {
    businessId = business(businessId);
    if (typeof id !== "string" || !id) throw new TypeError("Invalid staff ID");
    checkPassword(password, 8);
    const salt = randomBytes(16);
    const verifier = await passwordHash(password, salt);
    try {
      const result = this.db.prepare(`
        UPDATE offline_staff SET salt = ?, verifier = ?, credential_version = credential_version + 1,
          failed_attempts = 0, locked_until = 0 WHERE business_id = ? AND id = ?
      `).run(salt, verifier, businessId, id);
      if (result.changes !== 1) throw new Error("Staff account not found");
    } finally {
      verifier.fill(0);
    }
  }

  async authenticate(businessId, login, password) {
    businessId = business(businessId);
    login = username(login);
    checkPassword(password);
    const initial = this.db.prepare(`
      SELECT salt, verifier, credential_version FROM offline_staff WHERE business_id = ? AND username = ?
    `).get(businessId, login);
    if (!initial) throw new StaffAuthenticationError("Invalid credentials");
    const candidate = await passwordHash(password, initial.salt);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.db.prepare(`
          SELECT id, name, active, salt, verifier, credential_version, failed_attempts, locked_until
          FROM offline_staff WHERE business_id = ? AND username = ?
        `).get(businessId, login);
        if (!row || row.credential_version !== initial.credential_version
          || !timingSafeEqual(row.salt, initial.salt) || !timingSafeEqual(row.verifier, initial.verifier)) {
          throw new StaffAuthenticationError("Credentials changed; try again");
        }
        if (!row.active) throw new StaffAuthenticationError("Account inactive");
        const now = Date.now();
        if (row.locked_until > now) throw new StaffAuthenticationError("Account temporarily locked");
        if (!timingSafeEqual(candidate, row.verifier)) {
          const attempts = row.locked_until ? 1 : row.failed_attempts + 1;
          this.db.prepare(`
            UPDATE offline_staff SET failed_attempts = ?, locked_until = ? WHERE id = ?
          `).run(attempts, attempts >= MAX_ATTEMPTS ? now + LOCKOUT_MS : 0, row.id);
          this.db.exec("COMMIT");
          throw new StaffAuthenticationError("Invalid credentials");
        }
        this.db.prepare("UPDATE offline_staff SET failed_attempts = 0, locked_until = 0 WHERE id = ?").run(row.id);
        this.db.exec("COMMIT");
        return { businessId, id: row.id, username: login, name: row.name, credentialVersion: row.credential_version };
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      candidate.fill(0);
    }
  }

  isCurrent(identity) {
    if (!identity || typeof identity !== "object" || typeof identity.id !== "string"
      || !Number.isSafeInteger(identity.credentialVersion) || identity.credentialVersion < 1) {
      throw new TypeError("Invalid staff identity");
    }
    const row = this.db.prepare(`
      SELECT 1 AS current FROM offline_staff
      WHERE business_id = ? AND id = ? AND active = 1 AND credential_version = ?
    `).get(business(identity.businessId), identity.id, identity.credentialVersion);
    return Boolean(row);
  }
}
