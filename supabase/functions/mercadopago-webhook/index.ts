import { adminClient, fetchMercadoPagoPayment, getMercadoPagoAccessToken, reconcilePayment } from "../_shared/mercadopago.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};

function hex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function validSignature(request: Request, dataId: string): Promise<boolean> {
  const secret = Deno.env.get("MP_WEBHOOK_SECRET");
  const signature = request.headers.get("x-signature");
  const requestId = request.headers.get("x-request-id");
  if (!secret || !signature || !requestId) return false;
  const parts = Object.fromEntries(signature.split(",").map(part => part.trim().split("=", 2)));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest)));
  const expected = hex(digest);
  if (expected.length !== parts.v1.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ parts.v1.charCodeAt(index);
  return difference === 0;
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") {
    const configured = Boolean(
      Deno.env.get("MP_CLIENT_ID") &&
      Deno.env.get("MP_CLIENT_SECRET") &&
      Deno.env.get("MP_WEBHOOK_SECRET") &&
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    );
    return Response.json({ configured }, { headers: corsHeaders });
  }
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
  try {
    const body = await request.json() as { type?: unknown; data?: { id?: unknown } };
    const url = new URL(request.url);
    const topic = url.searchParams.get("type") || body.type;
    const dataId = String(body.data?.id || "");
    if (topic !== "payment" || !dataId) return new Response("Ignored.", { status: 200 });
    const businessId = url.searchParams.get("business_id") || "";
    if (!/^[0-9a-f-]{36}$/i.test(businessId)) return new Response("Invalid store.", { status: 400 });
    if (!await validSignature(request, dataId)) {
      console.warn("Rejected Mercado Pago webhook with invalid signature.");
      return new Response("Invalid signature.", { status: 401 });
    }

    const client = adminClient();
    const accessToken = await getMercadoPagoAccessToken(client, businessId);
    const payment = await fetchMercadoPagoPayment(accessToken, dataId);
    if (String(payment.id) !== dataId) throw new Error("Payment ID does not match webhook.");
    await reconcilePayment(client, payment, businessId);
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Could not process Mercado Pago webhook:", error);
    return new Response("Webhook processing failed.", { status: 500 });
  }
});
