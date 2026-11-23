import { createClient } from "npm:@supabase/supabase-js@2";
import { adminClient } from "../_shared/supabase.ts";

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

    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "Invalid request body." }, 400);
    }
    const input = body as Record<string, unknown>;
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (name.length < 2 || name.length > 80) return jsonResponse({ error: "Informe um nome entre 2 e 80 caracteres." }, 400);
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ error: "Informe um e-mail válido." }, 400);
    }
    if (password.length < 8 || password.length > 128) {
      return jsonResponse({ error: "A senha deve ter entre 8 e 128 caracteres." }, 400);
    }

    const client = adminClient();
    const { data: business, error: businessError } = await userClient
      .from("business_data")
      .select("user_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (businessError) throw businessError;
    if (!business) return jsonResponse({ error: "Somente uma conta de loja pode cadastrar entregadores." }, 403);

    const { data: driverSession, error: driverSessionError } = await client
      .from("delivery_drivers")
      .select("user_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (driverSessionError) throw driverSessionError;
    if (driverSession) return jsonResponse({ error: "Contas de entregador não podem cadastrar outros entregadores." }, 403);

    const { data: created, error: createError } = await client.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name }
    });
    if (createError) return jsonResponse({ error: createError.message }, 409);
    if (!created.user) throw new Error("Supabase did not return the created driver account.");

    const { error: profileError } = await client.from("delivery_drivers").insert({
      user_id: created.user.id,
      business_id: userData.user.id,
      name,
      email,
      active: true
    });
    if (profileError) {
      const { error: cleanupError } = await client.auth.admin.deleteUser(created.user.id);
      if (cleanupError) console.error("Could not remove driver account after profile creation failed:", cleanupError);
      throw profileError;
    }

    return jsonResponse({ user_id: created.user.id, name, email, active: true });
  } catch (error) {
    console.error("Could not create delivery driver:", error);
    return jsonResponse({ error: "Não foi possível cadastrar o entregador. Verifique a configuração do Supabase." }, 500);
  }
});
