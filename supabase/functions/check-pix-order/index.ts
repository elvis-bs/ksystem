import {
  adminClient,
  cancelMercadoPagoPayment,
  fetchMercadoPagoPayment,
  getMercadoPagoAccessToken,
  reconcilePayment
} from "../_shared/mercadopago.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") {
    const configured = Boolean(Deno.env.get("MP_CLIENT_ID") && Deno.env.get("MP_CLIENT_SECRET") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    return Response.json({ configured }, { headers: corsHeaders });
  }
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405, headers: corsHeaders });

  try {
    const body = await request.json() as { action?: unknown; orderId?: unknown };
    const action = body.action === undefined ? "check" : body.action;
    if (action !== "check" && action !== "cancel") {
      return Response.json({ error: "Invalid action." }, { status: 400, headers: corsHeaders });
    }
    const orderId = typeof body.orderId === "string" ? body.orderId : "";
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
      return Response.json({ error: "Invalid order." }, { status: 400, headers: corsHeaders });
    }
    const client = adminClient();
    const { data: order, error } = await client
      .from("online_orders")
      .select("id,business_id,payment_id,payment_status,total")
      .eq("id", orderId)
      .maybeSingle();
    if (error) throw error;
    if (!order) return Response.json({ error: "Order not found." }, { status: 404, headers: corsHeaders });
    if (order.payment_status !== "pending") {
      return Response.json({ status: order.payment_status }, { headers: corsHeaders });
    }
    if (!order.payment_id) {
      if (action === "cancel") {
        return Response.json({ error: "Pix ainda está sendo preparado. Tente novamente." }, { status: 409, headers: corsHeaders });
      }
      return Response.json({ status: order.payment_status }, { headers: corsHeaders });
    }

    const accessToken = await getMercadoPagoAccessToken(client, order.business_id);
    const payment = await fetchMercadoPagoPayment(accessToken, String(order.payment_id));
    if (payment.external_reference !== order.id) throw new Error("Payment reference does not match the order.");
    const result = await reconcilePayment(client, payment, order.business_id);
    if (action === "cancel" && result.paymentStatus === "pending") {
      const cancelledPayment = await cancelMercadoPagoPayment(accessToken, String(order.payment_id));
      if (String(cancelledPayment.id) !== String(order.payment_id) || cancelledPayment.external_reference !== order.id) {
        throw new Error("Cancelled payment does not match the order.");
      }
      const cancellationResult = await reconcilePayment(client, cancelledPayment, order.business_id);
      if (cancellationResult.paymentStatus === "pending") {
        throw new Error("Mercado Pago did not cancel the pending payment.");
      }
      return Response.json({ status: cancellationResult.paymentStatus }, { headers: corsHeaders });
    }
    return Response.json({ status: result.paymentStatus }, { headers: corsHeaders });
  } catch (error) {
    console.error("Could not check Pix order:", error);
    return Response.json({ error: "Could not check payment status." }, { status: 500, headers: corsHeaders });
  }
});
