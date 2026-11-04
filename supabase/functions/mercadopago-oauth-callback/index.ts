import { adminClient } from "../_shared/mercadopago.ts";

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  user_id?: number | string;
  expires_in?: number;
};

function appRedirect(result: string): Response {
  const appUrl = Deno.env.get("MP_OAUTH_APP_URL");
  if (!appUrl) return new Response("Mercado Pago connection return URL is not configured.", { status: 503 });
  const redirect = new URL(appUrl);
  redirect.searchParams.set("mp_oauth", result);
  return Response.redirect(redirect, 302);
}

async function hashState(state: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async request => {
  if (request.method !== "GET") return new Response("Method not allowed.", { status: 405 });
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    if (!state || state.length > 200) return appRedirect("error");

    const client = adminClient();
    const stateHash = await hashState(state);
    const { data: oauthState, error: stateError } = await client
      .from("mercadopago_oauth_states")
      .delete()
      .eq("state_hash", stateHash)
      .gt("expires_at", new Date().toISOString())
      .select("business_id,code_verifier")
      .maybeSingle();
    if (stateError) throw stateError;
    if (!oauthState) return appRedirect("expired");
    if (url.searchParams.has("error") || !code) return appRedirect("denied");

    const clientId = Deno.env.get("MP_CLIENT_ID");
    const clientSecret = Deno.env.get("MP_CLIENT_SECRET");
    const redirectUri = Deno.env.get("MP_OAUTH_REDIRECT_URI");
    if (!clientId || !clientSecret || !redirectUri) throw new Error("Mercado Pago OAuth is not configured.");

    const tokenResponse = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: oauthState.code_verifier,
        ...(Deno.env.get("MP_TEST_MODE") === "true" ? { test_token: true } : {})
      })
    });
    if (!tokenResponse.ok) {
      console.error("Mercado Pago authorization exchange failed:", tokenResponse.status);
      return appRedirect("error");
    }

    const token = await tokenResponse.json() as OAuthTokenResponse;
    if (!token.access_token || !token.refresh_token || !token.user_id || !token.expires_in) {
      throw new Error("Mercado Pago returned incomplete OAuth credentials.");
    }
    const now = new Date().toISOString();
    const { error: saveError } = await client.from("mercadopago_connections").upsert({
      business_id: oauthState.business_id,
      mp_user_id: String(token.user_id),
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      refresh_lock_until: null,
      connected_at: now,
      updated_at: now
    }, { onConflict: "business_id" });
    if (saveError) throw saveError;
    return appRedirect("connected");
  } catch (error) {
    console.error("Could not complete Mercado Pago authorization:", error);
    return appRedirect("error");
  }
});
