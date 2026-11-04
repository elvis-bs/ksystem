import { adminClient, fetchMercadoPagoPayment, getMercadoPagoAccessToken, reconcilePayment } from "../_shared/mercadopago.ts";

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
    const body = await request.json() as { orderId?: unknown };
    const orderId = typeof body.orderId === "string" ? body.orderId : "";
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
      return Response.json({ error: "Invalid order." }, { status: 400, headers: corsHeaders });
    }
    const client = adminClient();
    const { data: order, error } = await client
      .from("online_orders")
      .select("id,business_id,payment_id,payment_status")
      .eq("id", orderId)
      .maybeSingle();
    if (error) throw error;
    if (!order) return Response.json({ error: "Order not found." }, { status: 404, headers: corsHeaders });
    if (!order.payment_id || order.payment_status !== "pending") {
      return Response.json({ status: order.payment_status }, { headers: corsHeaders });
    }

    const accessToken = await getMercadoPagoAccessToken(client, order.business_id);
    const payment = await fetchMercadoPagoPayment(accessToken, String(order.payment_id));
    if (payment.external_reference !== order.id) throw new Error("Payment reference does not match the order.");
    const result = await reconcilePayment(client, payment, order.business_id);
    return Response.json({ status: result.paymentStatus }, { headers: corsHeaders });
  } catch (error) {
    console.error("Could not check Pix order:", error);
    return Response.json({ error: "Could not check payment status." }, { status: 500, headers: corsHeaders });
  }
});
