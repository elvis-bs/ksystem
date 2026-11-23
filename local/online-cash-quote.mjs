import { isDeepStrictEqual } from "node:util";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createOnlineCashQuoteRemote(client, credential) {
  if (!client || typeof client.rpc !== "function") throw new TypeError("Supabase client is required");
  if (typeof credential !== "string" || !/^[0-9a-f]{64}$/.test(credential)) throw new TypeError("Invalid device credential");
  return {
    async quote({ operationId, sessionId, expectedRevision }) {
      if (typeof operationId !== "string" || !uuid.test(operationId)
        || typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new TypeError("Invalid online cash quote input");
      }
      const { data, error } = await client.rpc("experimental_quote_online_cash_close", {
        p_credential: credential, p_operation_id: operationId,
        p_session_id: sessionId, p_expected_revision: expectedRevision
      });
      if (error) throw new Error(`Online cash quote failed: ${error.message}`, { cause: error });
      if (!data || !["ready", "conflict", "invalid-session"].includes(data.status)
        || typeof data.operationId !== "string" || data.operationId.toLowerCase() !== operationId.toLowerCase()
        || !Number.isSafeInteger(data.revision) || data.revision < 0
        || (data.status === "conflict" ? data.revision === expectedRevision : data.revision !== expectedRevision)) {
        throw new Error("Invalid online cash quote response");
      }
      if (data.status !== "ready") return data;
      if (data.sessionId !== sessionId || typeof data.quotedAt !== "string" || !Number.isFinite(Date.parse(data.quotedAt))
        || !data.snapshot || typeof data.snapshot !== "object" || Array.isArray(data.snapshot)
        || !Array.isArray(data.orders) || data.orders.length > 10000) {
        throw new Error("Invalid online cash quote response");
      }
      const ids = new Set();
      for (const order of data.orders) {
        if (!order || typeof order.id !== "string" || !order.id || ids.has(order.id)
          || typeof order.paymentMethod !== "string" || !order.paymentMethod
          || typeof order.paymentStatus !== "string" || !order.paymentStatus
          || typeof order.status !== "string" || !order.status
          || typeof order.total !== "number" || !Number.isFinite(order.total) || order.total <= 0
          || !Number.isSafeInteger(Math.round(order.total * 100))
          || Math.abs(order.total * 100 - Math.round(order.total * 100)) > 1e-7
          || typeof order.createdAt !== "string" || !Number.isFinite(Date.parse(order.createdAt))
          || !(order.paidAt === null || typeof order.paidAt === "string" && Number.isFinite(Date.parse(order.paidAt)))
          || !(order.paymentIdHash === null || typeof order.paymentIdHash === "string" && /^[0-9a-f]{64}$/.test(order.paymentIdHash))) {
          throw new Error("Invalid order in online cash quote");
        }
        ids.add(order.id);
      }
      return data;
    }
  };
}

export async function readReservedOnlineCashQuote(store, businessId, commandId, request, localRevision, remote, authorize = null) {
  if (!remote || typeof remote.quote !== "function") throw new TypeError("Online cash quote remote is required");
  const pending = store.prepareOnlineCashClose(businessId, commandId, request, localRevision, authorize);
  if (pending.phase !== "prepared") throw new Error("Dispatched online cash close must be reconciled");
  const result = await remote.quote({ operationId: commandId, sessionId: pending.request.sessionId,
    expectedRevision: pending.remoteRevision });
  if (authorize) authorize();
  const after = store.pendingOnlineCashClose(businessId);
  if (!isDeepStrictEqual(pending, after)) throw new Error("Online cash close reservation changed during quote");
  if (!result || !["ready", "conflict", "invalid-session"].includes(result.status)
    || typeof result.operationId !== "string" || result.operationId.toLowerCase() !== commandId.toLowerCase()
    || !Number.isSafeInteger(result.revision)
    || result.revision < 0 || (result.status === "conflict"
      ? result.revision === pending.remoteRevision : result.revision !== pending.remoteRevision)) {
    throw new Error("Invalid online cash quote response");
  }
  if (result.status === "ready" && !isDeepStrictEqual(result.snapshot, pending.snapshot)) {
    throw new Error("Online cash quote snapshot differs from synchronized local data");
  }
  return result;
}
