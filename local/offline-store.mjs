import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
}

function assertRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
}

function serializeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("snapshot must be an object");
  }
  const json = JSON.stringify(snapshot);
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed.products) || !Array.isArray(parsed.ingredients)
    || !Array.isArray(parsed.sales) || !Array.isArray(parsed.cashSessions)) {
    throw new TypeError("snapshot must contain product, ingredient, sale and cash-session arrays");
  }
  return json;
}

function moneyCents(value, name, { signed = false, allowString = false } = {}) {
  const parsed = allowString && typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || (!signed && parsed < 0)
    || !Number.isSafeInteger(Math.round(parsed * 100))
    || Math.abs(parsed * 100 - Math.round(parsed * 100)) > 1e-7) {
    throw new Error(`Invalid ${name}`);
  }
  return Math.round(parsed * 100);
}

function validateOnlineCloseResult(pending, commandId, result) {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || result.status !== "closed" || typeof result.operationId !== "string"
    || (result.operationId !== commandId && !(uuidPattern.test(commandId) && uuidPattern.test(result.operationId)
      && result.operationId.toLowerCase() === commandId.toLowerCase()))
    || result.sessionId !== pending.request.sessionId
    || !Number.isSafeInteger(result.revision) || result.revision !== pending.remoteRevision + 1
    || !result.snapshot || typeof result.snapshot !== "object" || Array.isArray(result.snapshot)
    || !Array.isArray(result.snapshot.cashSessions)) {
    throw new Error("Invalid online cash close result");
  }
  const matches = result.snapshot.cashSessions.filter(session => session && session.id === pending.request.sessionId);
  const originals = pending.snapshot.cashSessions.filter(session => session && session.id === pending.request.sessionId);
  if (matches.length !== 1 || originals.length !== 1) throw new Error("Invalid closed cash session");
  const session = matches[0];
  const original = originals[0];
  const fields = ["closedAt", "expectedCash", "countedCash", "difference", "receivedTotalAtClose",
    "receivedByMethodAtClose", "closeNotes"];
  if (fields.some(field => Object.hasOwn(original, field))
    || typeof session.closedAt !== "string" || !Number.isFinite(Date.parse(session.closedAt))
    || Date.parse(session.closedAt) < Date.parse(original.openedAt)
    || session.closeNotes !== pending.request.notes
    || moneyCents(session.countedCash, "counted cash") !== moneyCents(pending.request.counted, "counted cash")
    || !Array.isArray(session.receivedByMethodAtClose)) {
    throw new Error("Invalid closed cash session");
  }
  const expected = moneyCents(session.expectedCash, "expected cash", { signed: true });
  const received = moneyCents(session.receivedTotalAtClose, "received total");
  const difference = moneyCents(session.difference, "cash difference", { signed: true });
  const counted = moneyCents(session.countedCash, "counted cash");
  let methodTotal = 0;
  const methods = new Set();
  for (const item of session.receivedByMethodAtClose) {
    if (!item || typeof item.payment !== "string" || !item.payment.trim() || methods.has(item.payment)) {
      throw new Error("Invalid closed cash payment methods");
    }
    methods.add(item.payment);
    methodTotal += moneyCents(item.amount, "payment total");
    if (!Number.isSafeInteger(methodTotal)) throw new Error("Cash total too large");
  }
  let movements = 0;
  if (original.cashMovements !== undefined && !Array.isArray(original.cashMovements)) throw new Error("Invalid cash movements");
  for (const movement of original.cashMovements || []) {
    if (!movement || !["addition", "withdrawal"].includes(movement.type)) throw new Error("Invalid cash movement");
    movements += (movement.type === "addition" ? 1 : -1) * moneyCents(movement.amount, "cash movement", { allowString: true });
    if (!Number.isSafeInteger(movements)) throw new Error("Cash total too large");
  }
  const computedExpected = moneyCents(original.openingAmount, "opening amount", { allowString: true }) + received + movements;
  if (!Number.isSafeInteger(computedExpected) || !Number.isSafeInteger(counted - expected)
    || methodTotal !== received || computedExpected !== expected || counted - expected !== difference) {
    throw new Error("Inconsistent closed cash totals");
  }
  const restored = JSON.parse(serializeSnapshot(result.snapshot));
  const index = restored.cashSessions.findIndex(item => item && item.id === pending.request.sessionId);
  restored.cashSessions[index] = original;
  const extraSession = { ...session };
  for (const field of fields) delete extraSession[field];
  if (!isDeepStrictEqual(extraSession, original) || !isDeepStrictEqual(restored, pending.snapshot)) {
    throw new Error("Online cash close changed unrelated data");
  }
}

export class OfflineStore {
  constructor(filename) {
    assertText(filename, "filename");
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS offline_business (
        business_id TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        local_revision INTEGER NOT NULL CHECK (local_revision >= 0),
        synced_revision INTEGER NOT NULL CHECK (synced_revision >= 0 AND synced_revision <= local_revision),
        remote_revision INTEGER NOT NULL CHECK (remote_revision >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS offline_sync_outbox (
        business_id TEXT PRIMARY KEY REFERENCES offline_business(business_id),
        operation_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        local_revision INTEGER NOT NULL CHECK (local_revision > 0),
        remote_revision INTEGER NOT NULL CHECK (remote_revision >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS offline_commands (
        business_id TEXT NOT NULL REFERENCES offline_business(business_id),
        command_id TEXT NOT NULL,
        request TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (business_id, command_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS offline_cash_checkpoints (
        business_id TEXT NOT NULL REFERENCES offline_business(business_id),
        session_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL UNIQUE,
        closed_at TEXT NOT NULL,
        PRIMARY KEY (business_id, session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS offline_cash_checkpoint_baselines (
        business_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        local_revision INTEGER NOT NULL CHECK (local_revision >= 0),
        snapshot TEXT NOT NULL,
        PRIMARY KEY (business_id, session_id),
        FOREIGN KEY (business_id, session_id)
          REFERENCES offline_cash_checkpoints (business_id, session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS offline_cash_close_baselines (
        business_id TEXT NOT NULL REFERENCES offline_business(business_id),
        session_id TEXT NOT NULL,
        local_revision INTEGER NOT NULL CHECK (local_revision >= 0),
        snapshot TEXT NOT NULL,
        PRIMARY KEY (business_id, session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS offline_online_cash_close_pending (
        business_id TEXT PRIMARY KEY REFERENCES offline_business(business_id),
        command_id TEXT NOT NULL,
        request TEXT NOT NULL,
        local_revision INTEGER NOT NULL CHECK (local_revision >= 0),
        remote_revision INTEGER NOT NULL CHECK (remote_revision >= 0),
        snapshot TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('prepared', 'dispatched'))
      ) STRICT;
      PRAGMA foreign_keys = ON;
    `);
  }

  close() {
    this.db.close();
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  read(businessId) {
    assertText(businessId, "businessId");
    const row = this.db.prepare(`
      SELECT snapshot, local_revision, synced_revision, remote_revision
      FROM offline_business WHERE business_id = ?
    `).get(businessId);
    if (!row) return null;
    return {
      snapshot: JSON.parse(row.snapshot),
      localRevision: row.local_revision,
      syncedRevision: row.synced_revision,
      remoteRevision: row.remote_revision,
      pending: row.local_revision !== row.synced_revision
    };
  }

  initialize(businessId, snapshot, remoteRevision, beforeCommit = null) {
    assertText(businessId, "businessId");
    assertRevision(remoteRevision, "remoteRevision");
    const json = serializeSnapshot(snapshot);
    if (beforeCommit !== null && typeof beforeCommit !== "function") throw new TypeError("Invalid commit callback");
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO offline_business (business_id, snapshot, local_revision, synced_revision, remote_revision)
        VALUES (?, ?, 0, 0, ?)
      `).run(businessId, json, remoteRevision);
      if (beforeCommit) beforeCommit();
      return this.read(businessId);
    });
  }

  save(businessId, snapshot, expectedLocalRevision) {
    assertText(businessId, "businessId");
    assertRevision(expectedLocalRevision, "expectedLocalRevision");
    const json = serializeSnapshot(snapshot);
    return this.transaction(() => {
      this.assertNoPendingOnlineCashClose(businessId);
      const result = this.db.prepare(`
        UPDATE offline_business
        SET snapshot = ?, local_revision = local_revision + 1
        WHERE business_id = ? AND local_revision = ?
      `).run(json, businessId, expectedLocalRevision);
      if (result.changes !== 1) throw new Error("Local snapshot changed or does not exist");
      return this.read(businessId);
    });
  }

  executeCommand(businessId, commandId, command, apply, authorize = null, options = {}) {
    assertText(businessId, "businessId");
    assertText(commandId, "commandId");
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new TypeError("command must be an object");
    }
    if (typeof apply !== "function") throw new TypeError("apply must be a function");
    if (authorize !== null && typeof authorize !== "function") throw new TypeError("authorize must be a function");
    if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some(key => !["cashCloseSessionId", "readOnlyResult"].includes(key))) {
      throw new TypeError("Invalid command options");
    }
    if (options.cashCloseSessionId !== undefined) assertText(options.cashCloseSessionId, "cashCloseSessionId");
    if (options.readOnlyResult !== undefined && typeof options.readOnlyResult !== "function") {
      throw new TypeError("Invalid read-only result predicate");
    }
    const request = JSON.stringify(command);
    if (!request) throw new TypeError("command must be serializable");
    return this.transaction(() => {
      if (authorize) authorize();
      const current = this.read(businessId);
      if (!current) throw new Error("Local snapshot does not exist");
      const previous = this.db.prepare(`
        SELECT request, result FROM offline_commands WHERE business_id = ? AND command_id = ?
      `).get(businessId, commandId);
      if (previous) {
        if (previous.request !== request) throw new Error("Command ID already used with different data");
        return JSON.parse(previous.result);
      }
      this.assertNoPendingOnlineCashClose(businessId);
      const originalSnapshot = options.readOnlyResult ? serializeSnapshot(current.snapshot) : null;
      const result = apply(current.snapshot, current.localRevision);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new TypeError("command result must be an object");
      }
      const json = serializeSnapshot(current.snapshot);
      const resultJson = JSON.stringify(result);
      const readOnly = options.readOnlyResult ? options.readOnlyResult(result) === true : false;
      if (readOnly && json !== originalSnapshot) {
        throw new Error("Read-only command changed the snapshot");
      }
      if (!readOnly && options.cashCloseSessionId !== undefined) {
        const sessions = current.snapshot.cashSessions.filter(session => session.id === options.cashCloseSessionId);
        if (sessions.length !== 1 || sessions[0].offlineClosureStatus !== "provisional"
          || typeof sessions[0].closedAt !== "string" || !Number.isFinite(Date.parse(sessions[0].closedAt))) {
          throw new Error("Cannot capture invalid provisional cash close");
        }
        this.db.prepare(`
          INSERT INTO offline_cash_close_baselines (business_id, session_id, local_revision, snapshot)
          VALUES (?, ?, ?, ?)
        `).run(businessId, options.cashCloseSessionId, current.localRevision + 1, json);
      }
      if (!readOnly) {
        this.db.prepare(`
          UPDATE offline_business SET snapshot = ?, local_revision = local_revision + 1
          WHERE business_id = ? AND local_revision = ?
        `).run(json, businessId, current.localRevision);
      }
      this.db.prepare(`
        INSERT INTO offline_commands (business_id, command_id, request, result)
        VALUES (?, ?, ?, ?)
      `).run(businessId, commandId, request, resultJson);
      return JSON.parse(resultJson);
    });
  }

  acceptRemote(businessId, snapshot, expectedRemoteRevision, newRemoteRevision, beforeCommit = null) {
    assertText(businessId, "businessId");
    assertRevision(expectedRemoteRevision, "expectedRemoteRevision");
    assertRevision(newRemoteRevision, "newRemoteRevision");
    if (newRemoteRevision <= expectedRemoteRevision) throw new RangeError("Remote revision must increase");
    if (beforeCommit !== null && typeof beforeCommit !== "function") throw new TypeError("Invalid commit callback");
    const json = serializeSnapshot(snapshot);
    return this.transaction(() => {
      this.assertNoPendingOnlineCashClose(businessId);
      const result = this.db.prepare(`
        UPDATE offline_business
        SET snapshot = ?, local_revision = local_revision + 1,
            synced_revision = local_revision + 1, remote_revision = ?
        WHERE business_id = ? AND remote_revision = ? AND local_revision = synced_revision
          AND NOT EXISTS (SELECT 1 FROM offline_sync_outbox WHERE business_id = ?)
      `).run(json, newRemoteRevision, businessId, expectedRemoteRevision, businessId);
      if (result.changes !== 1) throw new Error("Remote snapshot conflicts with local changes or revision");
      if (beforeCommit) beforeCommit();
      return this.read(businessId);
    });
  }

  pendingUpload(businessId) {
    assertText(businessId, "businessId");
    const row = this.db.prepare(`
      SELECT operation_id, snapshot, local_revision, remote_revision
      FROM offline_sync_outbox WHERE business_id = ?
    `).get(businessId);
    if (!row) return null;
    return {
      operationId: row.operation_id,
      snapshot: JSON.parse(row.snapshot),
      localRevision: row.local_revision,
      remoteRevision: row.remote_revision
    };
  }

  pendingOnlineCashClose(businessId) {
    assertText(businessId, "businessId");
    const row = this.db.prepare(`
      SELECT command_id, request, local_revision, remote_revision, snapshot, phase
      FROM offline_online_cash_close_pending WHERE business_id = ?
    `).get(businessId);
    if (!row) return null;
    return { commandId: row.command_id, request: JSON.parse(row.request),
      localRevision: row.local_revision, remoteRevision: row.remote_revision,
      snapshot: JSON.parse(row.snapshot), phase: row.phase };
  }

  assertNoPendingOnlineCashClose(businessId) {
    if (this.pendingOnlineCashClose(businessId)) {
      throw new Error("Online cash close is awaiting confirmation");
    }
  }

  prepareOnlineCashClose(businessId, commandId, request, expectedLocalRevision, authorize = null) {
    assertText(businessId, "businessId");
    assertText(commandId, "commandId");
    assertRevision(expectedLocalRevision, "expectedLocalRevision");
    if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some(key => !["sessionId", "counted", "notes"].includes(key))
      || typeof request.sessionId !== "string" || !request.sessionId.trim()
      || typeof request.counted !== "number" || !Number.isFinite(request.counted) || request.counted < 0
      || !Number.isSafeInteger(Math.round(request.counted * 100))
      || Math.abs(request.counted * 100 - Math.round(request.counted * 100)) > 1e-7
      || typeof request.notes !== "string" || request.notes.length > 1000 || request.notes !== request.notes.trim()) {
      throw new TypeError("Invalid online cash close request");
    }
    if (authorize !== null && typeof authorize !== "function") throw new TypeError("Invalid authorization callback");
    const json = JSON.stringify({ sessionId: request.sessionId, counted: request.counted, notes: request.notes });
    return this.transaction(() => {
      if (authorize) authorize();
      const previous = this.pendingOnlineCashClose(businessId);
      if (previous) {
        if (previous.commandId !== commandId || JSON.stringify(previous.request) !== json
          || previous.localRevision !== expectedLocalRevision) {
          throw new Error("Another online cash close is awaiting confirmation");
        }
        return previous;
      }
      const current = this.read(businessId);
      if (!current || current.localRevision !== expectedLocalRevision) throw new Error("Local snapshot changed");
      if (this.db.prepare("SELECT 1 FROM offline_commands WHERE business_id = ? AND command_id = ?")
        .get(businessId, commandId)) throw new Error("Command ID already used");
      if (current.pending || this.pendingUpload(businessId)) throw new Error("Local changes must be synchronized first");
      if (current.snapshot.cashSessions.some(session => session.offlineClosureStatus === "provisional")) {
        throw new Error("Existing provisional cash close requires reconciliation");
      }
      const open = current.snapshot.cashSessions.filter(session => !session.closedAt);
      if (open.length !== 1 || open[0].id !== request.sessionId
        || current.snapshot.cashSessions.filter(session => session.id === request.sessionId).length !== 1
        || typeof open[0].openedAt !== "string" || !Number.isFinite(Date.parse(open[0].openedAt))) {
        throw new Error("Exactly one matching open cash session is required");
      }
      this.db.prepare(`
        INSERT INTO offline_online_cash_close_pending
          (business_id, command_id, request, local_revision, remote_revision, snapshot, phase)
        VALUES (?, ?, ?, ?, ?, ?, 'prepared')
      `).run(businessId, commandId, json, current.localRevision, current.remoteRevision, serializeSnapshot(current.snapshot));
      return this.pendingOnlineCashClose(businessId);
    });
  }

  markOnlineCashCloseDispatched(businessId, commandId, authorize = null) {
    assertText(businessId, "businessId");
    assertText(commandId, "commandId");
    if (authorize !== null && typeof authorize !== "function") throw new TypeError("Invalid authorization callback");
    return this.transaction(() => {
      if (authorize) authorize();
      const current = this.pendingOnlineCashClose(businessId);
      if (!current || current.commandId !== commandId) throw new Error("Online cash close reservation not found");
      if (current.phase === "prepared") {
        this.db.prepare(`
          UPDATE offline_online_cash_close_pending SET phase = 'dispatched'
          WHERE business_id = ? AND command_id = ? AND phase = 'prepared'
        `).run(businessId, commandId);
      }
      return this.pendingOnlineCashClose(businessId);
    });
  }

  completeOnlineCashClose(businessId, commandId, result, authorize = null) {
    assertText(businessId, "businessId");
    assertText(commandId, "commandId");
    if (authorize !== null && typeof authorize !== "function") throw new TypeError("Invalid authorization callback");
    return this.transaction(() => {
      if (authorize) authorize();
      const previous = this.db.prepare(`
        SELECT request, result FROM offline_commands WHERE business_id = ? AND command_id = ?
      `).get(businessId, commandId);
      if (previous) {
        const request = JSON.parse(previous.request);
        const saved = JSON.parse(previous.result);
        if (request.action !== "completeOnlineCashClose" || !isDeepStrictEqual(saved, result)) {
          throw new Error("Command ID already used with different data");
        }
        return saved;
      }
      const pending = this.pendingOnlineCashClose(businessId);
      if (!pending || pending.commandId !== commandId || pending.phase !== "dispatched") {
        throw new Error("Dispatched online cash close reservation not found");
      }
      validateOnlineCloseResult(pending, commandId, result);
      const current = this.read(businessId);
      if (!current || current.localRevision !== pending.localRevision || current.pending
        || current.remoteRevision !== pending.remoteRevision
        || !isDeepStrictEqual(current.snapshot, pending.snapshot) || this.pendingUpload(businessId)
        || !Number.isSafeInteger(current.localRevision + 1)) {
        throw new Error("Online cash close conflicts with local data");
      }
      const json = serializeSnapshot(result.snapshot);
      const updated = this.db.prepare(`
        UPDATE offline_business SET snapshot = ?, local_revision = local_revision + 1,
          synced_revision = local_revision + 1, remote_revision = ?
        WHERE business_id = ? AND local_revision = ? AND synced_revision = ? AND remote_revision = ?
      `).run(json, result.revision, businessId, pending.localRevision, pending.localRevision, pending.remoteRevision);
      if (updated.changes !== 1) throw new Error("Online cash close conflicts with local data");
      this.db.prepare(`
        INSERT INTO offline_commands (business_id, command_id, request, result) VALUES (?, ?, ?, ?)
      `).run(businessId, commandId, JSON.stringify({ action: "completeOnlineCashClose", request: pending.request }),
        JSON.stringify(result));
      const deleted = this.db.prepare(`
        DELETE FROM offline_online_cash_close_pending
        WHERE business_id = ? AND command_id = ? AND phase = 'dispatched'
      `).run(businessId, commandId);
      if (deleted.changes !== 1) throw new Error("Online cash close reservation changed");
      return result;
    });
  }

  cancelPreparedOnlineCashClose(businessId, commandId, authorize = null) {
    assertText(businessId, "businessId");
    assertText(commandId, "commandId");
    if (authorize !== null && typeof authorize !== "function") throw new TypeError("Invalid authorization callback");
    return this.transaction(() => {
      if (authorize) authorize();
      const current = this.pendingOnlineCashClose(businessId);
      if (!current || current.commandId !== commandId) throw new Error("Online cash close reservation not found");
      if (current.phase !== "prepared") throw new Error("Dispatched online cash close must be reconciled");
      const deleted = this.db.prepare(`
        DELETE FROM offline_online_cash_close_pending
        WHERE business_id = ? AND command_id = ? AND phase = 'prepared'
      `).run(businessId, commandId);
      if (deleted.changes !== 1) throw new Error("Online cash close reservation changed");
    });
  }

  cashCheckpoint(businessId, sessionId, authorize = null) {
    assertText(businessId, "businessId");
    assertText(sessionId, "sessionId");
    if (authorize !== null && typeof authorize !== "function") throw new TypeError("Invalid authorization callback");
    return this.transaction(() => {
      if (authorize) authorize();
      const current = this.read(businessId);
      if (!current) throw new Error("Local snapshot does not exist");
      const sessions = current.snapshot.cashSessions.filter(session => session.id === sessionId);
      if (sessions.length !== 1 || sessions[0].offlineClosureStatus !== "provisional"
        || typeof sessions[0].closedAt !== "string" || !Number.isFinite(Date.parse(sessions[0].closedAt))) {
        throw new Error("Valid provisional cash session is required");
      }
      const existing = this.db.prepare(`
        SELECT checkpoint_id, closed_at FROM offline_cash_checkpoints WHERE business_id = ? AND session_id = ?
      `).get(businessId, sessionId);
      if (existing) {
        if (existing.closed_at !== sessions[0].closedAt) throw new Error("Cash session changed after checkpoint");
        return { checkpointId: existing.checkpoint_id, sessionId, closedAt: existing.closed_at };
      }
      const checkpointId = randomUUID();
      this.db.prepare(`
        INSERT INTO offline_cash_checkpoints (business_id, session_id, checkpoint_id, closed_at) VALUES (?, ?, ?, ?)
      `).run(businessId, sessionId, checkpointId, sessions[0].closedAt);
      this.db.prepare(`
        INSERT INTO offline_cash_checkpoint_baselines (business_id, session_id, local_revision, snapshot)
        VALUES (?, ?, ?, ?)
      `).run(businessId, sessionId, current.localRevision, serializeSnapshot(current.snapshot));
      return { checkpointId, sessionId, closedAt: sessions[0].closedAt };
    });
  }

  cashCheckpointBaseline(businessId, sessionId) {
    assertText(businessId, "businessId");
    assertText(sessionId, "sessionId");
    const row = this.db.prepare(`
      SELECT snapshot, local_revision FROM offline_cash_checkpoint_baselines
      WHERE business_id = ? AND session_id = ?
    `).get(businessId, sessionId);
    if (!row) return null;
    return { snapshot: JSON.parse(row.snapshot), localRevision: row.local_revision };
  }

  cashCloseBaseline(businessId, sessionId) {
    assertText(businessId, "businessId");
    assertText(sessionId, "sessionId");
    const row = this.db.prepare(`
      SELECT snapshot, local_revision FROM offline_cash_close_baselines
      WHERE business_id = ? AND session_id = ?
    `).get(businessId, sessionId);
    if (!row) return null;
    return { snapshot: JSON.parse(row.snapshot), localRevision: row.local_revision };
  }

  prepareUpload(businessId) {
    assertText(businessId, "businessId");
    return this.transaction(() => {
      this.assertNoPendingOnlineCashClose(businessId);
      const current = this.read(businessId);
      if (!current) throw new Error("Local snapshot does not exist");
      if (current.snapshot.cashSessions.some(session => session.offlineClosureStatus === "provisional")) {
        throw new Error("Provisional cash closure requires online reconciliation before synchronization");
      }
      const existing = this.pendingUpload(businessId);
      if (existing) return existing;
      if (!current.pending) return null;
      this.db.prepare(`
        INSERT INTO offline_sync_outbox
          (business_id, operation_id, snapshot, local_revision, remote_revision)
        VALUES (?, ?, ?, ?, ?)
      `).run(businessId, randomUUID(), serializeSnapshot(current.snapshot),
        current.localRevision, current.remoteRevision);
      return this.pendingUpload(businessId);
    });
  }

  acknowledgeUpload(businessId, operationId, remoteRevision) {
    assertText(businessId, "businessId");
    assertText(operationId, "operationId");
    assertRevision(remoteRevision, "remoteRevision");
    return this.transaction(() => {
      const pending = this.pendingUpload(businessId);
      if (!pending || pending.operationId !== operationId) throw new Error("Unknown sync operation");
      if (remoteRevision !== pending.remoteRevision + 1) throw new Error("Unexpected remote revision");
      const result = this.db.prepare(`
        UPDATE offline_business SET synced_revision = ?, remote_revision = ?
        WHERE business_id = ? AND remote_revision = ?
          AND synced_revision < ? AND local_revision >= ?
      `).run(pending.localRevision, remoteRevision, businessId, pending.remoteRevision,
        pending.localRevision, pending.localRevision);
      if (result.changes !== 1) throw new Error("Acknowledgement conflicts with local changes or revision");
      this.db.prepare("DELETE FROM offline_sync_outbox WHERE business_id = ? AND operation_id = ?")
        .run(businessId, operationId);
      return this.read(businessId);
    });
  }
}
