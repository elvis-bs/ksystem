function amount(value, field) {
  const parsed = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isSafeInteger(Math.round(parsed * 100))
    || Math.abs(parsed * 100 - Math.round(parsed * 100)) > 1e-7) throw new Error(`Invalid ${field}`);
  return Math.round(parsed * 100);
}

function sessionForDate(sessions, date) {
  if (typeof date !== "string" || !date) throw new Error("Invalid receipt date");
  const at = new Date(date).getTime();
  if (!Number.isFinite(at)) throw new Error("Invalid receipt date");
  const matches = sessions.filter(session => {
    const opened = new Date(session.openedAt).getTime();
    const closed = session.closedAt ? new Date(session.closedAt).getTime() : Infinity;
    if (!Number.isFinite(opened) || !Number.isFinite(closed) && closed !== Infinity) throw new Error("Invalid cash session date");
    return at >= opened && at <= closed;
  });
  if (matches.length > 1) throw new Error("Ambiguous receipt cash session");
  return matches[0]?.id ?? null;
}

export function provisionalCashSummary(snapshot, session, closedAt) {
  if (!Array.isArray(snapshot.sales) || !Array.isArray(snapshot.financeEntries)
    || !Array.isArray(snapshot.cashSessions)) throw new Error("Incomplete local cash data");
  const totals = new Map();
  const sessions = snapshot.cashSessions.map(item => item === session ? { ...item, closedAt } : item);
  const add = (method, value) => {
    if (typeof method !== "string" || !method) throw new Error("Invalid receipt payment method");
    const normalized = method === "Pix online" ? "Pix"
      : ["Dinheiro na entrega", "Dinheiro na retirada"].includes(method) ? "Dinheiro" : method;
    const next = (totals.get(normalized) || 0) + amount(value, "receipt amount");
    if (!Number.isSafeInteger(next)) throw new Error("Cash total too large");
    totals.set(normalized, next);
  };
  const receivableSales = new Set(snapshot.financeEntries
    .filter(entry => entry.kind === "receivable" && entry.saleId).map(entry => entry.saleId));
  for (const sale of snapshot.sales) {
    if (!sale.paid || receivableSales.has(sale.id)) continue;
    const id = sale.cashSessionId || sessionForDate(sessions, sale.paidAt || sale.createdAt);
    if (id === session.id) add(sale.payment || "A combinar", sale.total);
  }
  for (const entry of snapshot.financeEntries) {
    if (entry.kind !== "receivable") continue;
    if (entry.payments !== undefined && !Array.isArray(entry.payments)) throw new Error("Invalid receivable payments");
    for (const payment of entry.payments || []) {
      const id = payment.cashSessionId || (entry.saleId ? sessionForDate(sessions, payment.date) : null);
      if (id === session.id) add(payment.method || "A combinar", payment.amount);
    }
  }
  if (session.cashMovements !== undefined && !Array.isArray(session.cashMovements)) throw new Error("Invalid cash movements");
  let movements = 0;
  for (const movement of session.cashMovements || []) {
    if (!["addition", "withdrawal"].includes(movement.type)) throw new Error("Invalid cash movement");
    movements += (movement.type === "addition" ? 1 : -1) * amount(movement.amount, "movement amount");
    if (!Number.isSafeInteger(movements)) throw new Error("Cash total too large");
  }
  const received = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const expected = amount(session.openingAmount, "opening amount") + received + movements;
  if (!Number.isSafeInteger(received) || !Number.isSafeInteger(expected)) throw new Error("Cash total too large");
  return { received: received / 100, expected: expected / 100,
    byMethod: [...totals].map(([payment, value]) => ({ payment, amount: value / 100 })) };
}
