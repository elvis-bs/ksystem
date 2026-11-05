import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { adminClient } from "./supabase.ts";

export { adminClient };

export type MercadoPagoPayment = {
  id: number | string;
  status: string;
  external_reference?: string;
  transaction_amount?: number;
  currency_id?: string;
};

export type MercadoPagoPixPayment = MercadoPagoPayment & {
  point_of_interaction?: {
    transaction_data?: {
      qr_code?: string;
      qr_code_base64?: string;
      ticket_url?: string;
    };
  };
};

type MercadoPagoConnection = {
  business_id: string;
  mp_user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  user_id?: number | string;
  expires_in?: number;
};

async function loadConnection(client: SupabaseClient, businessId: string): Promise<MercadoPagoConnection> {
  const { data, error } = await client
    .from("mercadopago_connections")
    .select("business_id,mp_user_id,access_token,refresh_token,expires_at")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Mercado Pago is not connected for this store.");
  return data as MercadoPagoConnection;
}

function isAccessTokenUsable(connection: MercadoPagoConnection): boolean {
  return new Date(connection.expires_at).getTime() > Date.now() + 5 * 60 * 1000;
}

async function refreshMercadoPagoToken(
  client: SupabaseClient,
  connection: MercadoPagoConnection
): Promise<MercadoPagoConnection> {
  const clientId = Deno.env.get("MP_CLIENT_ID");
  const clientSecret = Deno.env.get("MP_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Mercado Pago OAuth credentials are not configured.");

  const response = await fetch("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token
    })
  });
  if (!response.ok) {
    console.error("Mercado Pago token refresh failed:", response.status);
    throw new Error("Could not renew the Mercado Pago connection.");
  }

  const token = await response.json() as OAuthTokenResponse;
  if (!token.access_token || !token.refresh_token || !token.expires_in) {
    throw new Error("Mercado Pago returned an incomplete OAuth token.");
  }
  const refreshed = {
    ...connection,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString()
  };
  const { data: saved, error } = await client
    .from("mercadopago_connections")
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
      refresh_lock_until: null,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", connection.business_id)
    .select("business_id")
    .maybeSingle();
  if (error) throw error;
  if (!saved) throw new Error("Mercado Pago token was not saved.");
  return refreshed;
}

export async function getMercadoPagoAccessToken(client: SupabaseClient, businessId: string): Promise<string> {
  let connection = await loadConnection(client, businessId);
  if (isAccessTokenUsable(connection)) return connection.access_token;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const now = new Date();
    const { data: claim, error: claimError } = await client
      .from("mercadopago_connections")
      .update({ refresh_lock_until: new Date(now.getTime() + 30_000).toISOString() })
      .eq("business_id", businessId)
      .or(`refresh_lock_until.is.null,refresh_lock_until.lt.${now.toISOString()}`)
      .select("business_id")
      .maybeSingle();
    if (claimError) throw claimError;

    if (claim) {
      try {
        connection = await loadConnection(client, businessId);
        if (isAccessTokenUsable(connection)) {
          const { error: unlockError } = await client
            .from("mercadopago_connections")
            .update({ refresh_lock_until: null })
            .eq("business_id", businessId);
          if (unlockError) throw unlockError;
          return connection.access_token;
        }
        return (await refreshMercadoPagoToken(client, connection)).access_token;
      } catch (error) {
        const { error: unlockError } = await client
          .from("mercadopago_connections")
          .update({ refresh_lock_until: null })
          .eq("business_id", businessId);
        if (unlockError) console.error("Could not release Mercado Pago token refresh lock:", unlockError);
        throw error;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 500));
    connection = await loadConnection(client, businessId);
    if (isAccessTokenUsable(connection)) return connection.access_token;
  }

  throw new Error("Mercado Pago connection renewal is taking too long. Try again shortly.");
}

export async function fetchMercadoPagoPayment(accessToken: string, paymentId: string): Promise<MercadoPagoPayment> {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    console.error("Mercado Pago payment lookup failed:", response.status);
    throw new Error("Could not verify the payment with Mercado Pago.");
  }
  return await response.json() as MercadoPagoPayment;
}

export async function cancelMercadoPagoPayment(accessToken: string, paymentId: string): Promise<MercadoPagoPayment> {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ status: "cancelled" })
  });
  if (!response.ok) {
    console.error("Mercado Pago payment cancellation failed:", response.status);
    throw new Error("Could not cancel the Mercado Pago payment.");
  }
  return await response.json() as MercadoPagoPayment;
}

export async function createMercadoPagoPixPayment(
  client: SupabaseClient,
  businessId: string,
  orderId: string,
  amount: number,
  description: string,
  payerEmail: string
): Promise<MercadoPagoPixPayment> {
  const accessToken = await getMercadoPagoAccessToken(client, businessId);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) throw new Error("Supabase URL is not configured.");
  const notificationUrl = new URL("/functions/v1/mercadopago-webhook", supabaseUrl);
  notificationUrl.searchParams.set("business_id", businessId);

  const response = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": orderId
    },
    body: JSON.stringify({
      transaction_amount: amount,
      description,
      payment_method_id: "pix",
      external_reference: orderId,
      notification_url: notificationUrl.toString(),
      payer: { email: payerEmail }
    })
  });
  if (!response.ok) {
    console.error("Mercado Pago Pix creation failed:", response.status);
    throw new Error("Could not create the Mercado Pago Pix payment.");
  }

  const payment = await response.json() as MercadoPagoPixPayment;
  const transactionData = payment.point_of_interaction?.transaction_data;
  if (!payment.id || !payment.status || !transactionData?.qr_code || payment.currency_id !== "BRL") {
    throw new Error("Mercado Pago returned incomplete Pix payment details.");
  }
  return payment;
}

export async function reconcilePayment(
  client: SupabaseClient,
  payment: MercadoPagoPayment,
  expectedBusinessId?: string
): Promise<{ orderId: string; paymentStatus: string }> {
  if (!payment.external_reference) throw new Error("Payment has no external order reference.");

  const { data: order, error: lookupError } = await client
    .from("online_orders")
    .select("id,business_id,total,status,payment_id,payment_status,paid_at")
    .eq("id", payment.external_reference)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!order) throw new Error("Online order was not found.");
  if (expectedBusinessId && order.business_id !== expectedBusinessId) {
    throw new Error("Payment does not belong to the specified store.");
  }

  if (
    payment.currency_id !== "BRL" ||
    Math.abs(Number(payment.transaction_amount) - Number(order.total)) > 0.01
  ) {
    throw new Error("Payment amount or currency does not match the order.");
  }
  if (order.payment_id && String(order.payment_id) !== String(payment.id)) {
    throw new Error("Payment ID does not match the order.");
  }

  const statusMap: Record<string, string> = {
    approved: "approved",
    pending: "pending",
    in_process: "pending",
    authorized: "pending",
    rejected: "rejected",
    cancelled: "cancelled",
    refunded: "refunded",
    charged_back: "refunded"
  };
  let paymentStatus = statusMap[payment.status] || "pending";
  if (order.payment_status === "approved" && paymentStatus === "pending") paymentStatus = "approved";
  if (order.payment_status === "refunded") paymentStatus = "refunded";
  let orderStatus = String(order.status);
  if (paymentStatus === "approved" && orderStatus === "Aguardando Pix") orderStatus = "Recebido";
  if (["rejected", "cancelled", "refunded"].includes(paymentStatus)) orderStatus = "Cancelado";

  let updateQuery = client
    .from("online_orders")
    .update({
      payment_id: String(payment.id),
      payment_status: paymentStatus,
      status: orderStatus,
      paid_at: paymentStatus === "approved" ? order.paid_at || new Date().toISOString() : order.paid_at,
      updated_at: new Date().toISOString()
    })
    .eq("id", order.id);
  if (paymentStatus !== "approved") updateQuery = updateQuery.neq("payment_status", "approved");
  if (paymentStatus !== "refunded") updateQuery = updateQuery.neq("payment_status", "refunded");
  const { error: updateError } = await updateQuery;
  if (updateError) throw updateError;

  return { orderId: String(order.id), paymentStatus };
}
