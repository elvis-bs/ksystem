const KEY = "bora-tablet-pending-v1";

export class TabletQueue {
  constructor(storage, send) {
    this.storage = storage;
    this.send = send;
    this.running = false;
  }

  read() {
    const raw = this.storage.getItem(KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || typeof value.businessId !== "string"
      || typeof value.staffId !== "string" || !value.command || typeof value.command.commandId !== "string") {
      throw new Error("Pedido pendente inválido; não envie outro até o responsável verificar.");
    }
    return value;
  }

  prepare(identity, command) {
    if (this.read()) throw new Error("Há um pedido pendente; resolva-o antes de enviar outro.");
    const pending = { businessId: identity.businessId, staffId: identity.staffId, command };
    this.storage.setItem(KEY, JSON.stringify(pending));
    return pending;
  }

  async retry(identity) {
    if (this.running) throw new Error("Envio já está em andamento.");
    const pending = this.read();
    if (!pending) throw new Error("Não há pedido pendente.");
    if (pending.businessId !== identity.businessId || pending.staffId !== identity.staffId) {
      throw new Error("Entre com o mesmo funcionário e na mesma loja que enviou o pedido.");
    }
    this.running = true;
    try {
      const result = await this.send(pending.command);
      if (!result || typeof result.orderId !== "string" || result.tableId !== pending.command.tableId
        || typeof result.total !== "number" || !Number.isFinite(result.total)) {
        throw new Error("Resposta inválida; o pedido continua pendente.");
      }
      const current = this.read();
      if (!current || JSON.stringify(current) !== JSON.stringify(pending)) {
        throw new Error("Pedido pendente foi alterado; solicite ajuda ao responsável.");
      }
      this.storage.removeItem(KEY);
      return result;
    } finally {
      this.running = false;
    }
  }
}
