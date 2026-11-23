const KEY = "bora-owner-pending-v1";
const paths = new Set(["/api/owner/open-cash", "/api/owner/provisional-close-cash",
  "/api/owner/sale", "/api/owner/quoted-sale", "/api/owner/quoted-open-cash",
  "/api/owner/quoted-provisional-close", "/api/owner/create-table", "/api/owner/close-table",
  "/api/owner/cash-decision"]);

function validResult(path, command, result) {
  if (!result || typeof result !== "object") return false;
  if (path === "/api/owner/cash-decision") return ["recorded", "conflict"].includes(result.status)
    && result.operationId === command.commandId && result.eventId === command.eventId;
  if (path === "/api/owner/quoted-open-cash" || path === "/api/owner/quoted-provisional-close") {
    if (result.status === "rejected") return ["changed", "cash-changed", "online-close-unavailable"].includes(result.reason);
    if (path === "/api/owner/quoted-open-cash") {
      return result.status === "opened" && typeof result.cashSessionId === "string" && !!result.cashSessionId;
    }
    return result.status === "provisional" && result.sessionId === command.sessionId
      && Number.isFinite(result.localExpected) && Number.isFinite(result.localReceived);
  }
  if (path === "/api/owner/open-cash") return typeof result.cashSessionId === "string" && !!result.cashSessionId;
  if (path === "/api/owner/provisional-close-cash") return result.status === "rejected"
    ? result.reason === "online-close-unavailable"
    : result.sessionId === command.sessionId && result.status === "provisional"
      && Number.isFinite(result.localExpected) && Number.isFinite(result.localReceived);
  if (path === "/api/owner/create-table") return typeof result.tableId === "string" && !!result.tableId;
  if (path === "/api/owner/quoted-sale") {
    if (result.status === "rejected") return ["changed", "cash-changed", "price-changed", "invalid-items"].includes(result.reason);
    return result.status === "recorded" && typeof result.saleId === "string" && !!result.saleId
      && result.total === command.expectedTotal
      && (command.paid ? result.cashSessionId === command.expectedSessionId : result.cashSessionId === null);
  }
  if (path === "/api/owner/sale") return typeof result.saleId === "string" && !!result.saleId
    && typeof result.total === "number" && Number.isFinite(result.total) && result.total >= 0
    && (command.paid ? typeof result.cashSessionId === "string" && !!result.cashSessionId : result.cashSessionId === null);
  return result.tableId === command.tableId && result.orderId === command.orderId
    && typeof result.saleId === "string" && !!result.saleId
    && typeof result.total === "number" && Number.isFinite(result.total) && result.total >= 0;
}

export class OwnerQueue {
  constructor(storage, send) {
    this.storage = storage;
    this.send = send;
    this.running = false;
  }
  read() {
    const raw = this.storage.getItem(KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value.businessId !== "string" || !value.businessId
      || !paths.has(value.path) || !value.command || typeof value.command.commandId !== "string"
      || !value.command.commandId) throw new Error("Operação pendente inválida; solicite conferência.");
    return value;
  }
  prepare(businessId, path, command) {
    if (this.read()) throw new Error("Há uma operação pendente; confira antes de continuar.");
    if (typeof businessId !== "string" || !businessId || !paths.has(path)
      || !command || typeof command.commandId !== "string" || !command.commandId) throw new TypeError("Operação inválida.");
    this.storage.setItem(KEY, JSON.stringify({ businessId, path, command }));
  }
  async retry(businessId) {
    if (this.running) throw new Error("Operação já em andamento.");
    const pending = this.read();
    if (!pending) throw new Error("Não há operação pendente.");
    if (pending.businessId !== businessId) throw new Error("Entre na mesma loja que iniciou a operação.");
    this.running = true;
    try {
      const result = await this.send(pending.path, pending.command);
      if (!validResult(pending.path, pending.command, result)) throw new Error("Resposta inválida; operação permanece pendente.");
      if (JSON.stringify(this.read()) !== JSON.stringify(pending)) throw new Error("Operação pendente alterada; solicite conferência.");
      this.storage.removeItem(KEY);
      return result;
    } finally { this.running = false; }
  }
}
