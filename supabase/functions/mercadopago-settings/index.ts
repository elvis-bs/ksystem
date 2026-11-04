import { createClient } from "npm:@supabase/supabase-js@2";
import { adminClient } from "../_shared/mercadopago.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const authorization = request.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!authorization?.startsWith("Bearer ") || !supabaseUrl || !publishableKey) {
      return jsonResponse({ error: "Authentication is required." }, 401);
    }

    const userClient = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authorization } }
    });
    const jwt = authorization.slice("Bearer ".length);
    const { data: userData, error: userError } = await userClient.auth.getUser(jwt);
    if (userError || !userData.user) return jsonResponse({ error: "Authentication is required." }, 401);

    const body = await request.json() as { action?: unknown };
    const action = body.action;
    const client = adminClient();
    if (action === "status") {
      const { data: connection, error } = await client
        .from("mercadopago_connections")
        .select("mp_user_id,expires_at,connected_at")
        .eq("business_id", userData.user.id)
        .maybeSingle();
      if (error) throw error;
      return jsonResponse({
        configured: Boolean(
          Deno.env.get("MP_CLIENT_ID") &&
          Deno.env.get("MP_CLIENT_SECRET") &&
          Deno.env.get("MP_OAUTH_REDIRECT_URI") &&
          Deno.env.get("MP_OAUTH_APP_URL") &&
          Deno.env.get("MP_WEBHOOK_SECRET")
        ),
        environment: Deno.env.get("MP_TEST_MODE") === "true" ? "test" : "production",
        connected: Boolean(connection),
        sellerId: connection?.mp_user_id || null,
        expiresAt: connection?.expires_at || null,
        connectedAt: connection?.connected_at || null
      });
    }

    if (action !== "connect") return jsonResponse({ error: "Invalid action." }, 400);
    const clientId = Deno.env.get("MP_CLIENT_ID");
    const redirectUri = Deno.env.get("MP_OAUTH_REDIRECT_URI");
    if (!clientId || !redirectUri) return jsonResponse({ error: "Mercado Pago OAuth is not configured." }, 503);

    const randomBytes = crypto.getRandomValues(new Uint8Array(48));
    const verifier = base64Url(randomBytes);
    const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const stateHash = [...await sha256(state)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const challenge = base64Url(await sha256(verifier));
    const { error: cleanupError } = await client
      .from("mercadopago_oauth_states")
      .delete()
      .lt("expires_at", new Date().toISOString());
    if (cleanupError) throw cleanupError;
    const { error: stateError } = await client.from("mercadopago_oauth_states").insert({
      state_hash: stateHash,
      business_id: userData.user.id,
      code_verifier: verifier,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    });
    if (stateError) throw stateError;

    const authorizationUrl = new URL("https://auth.mercadopago.com/authorization");
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      platform_id: "mp",
      state,
      redirect_uri: redirectUri,
      scope: "offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256"
    }).toString();
    return jsonResponse({ authorizationUrl: authorizationUrl.toString() });
  } catch (error) {
    console.error("Could not manage Mercado Pago connection:", error);
    return jsonResponse({ error: "Não foi possível iniciar a conexão com o Mercado Pago." }, 500);
  }
});
