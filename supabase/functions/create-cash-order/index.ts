import {
  adminClient,
  createMercadoPagoPixPayment,
  reconcilePayment,
  type MercadoPagoPixPayment
} from "../_shared/mercadopago.ts";
import { storeAvailability } from "../_shared/store-hours.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

type JsonRecord = Record<string, unknown>;

function jsonResponse(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cents(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round((numberValue + Number.EPSILON) * 100) : -1;
}

function sizeOption(product: JsonRecord, name: string): JsonRecord | null {
  if (product.category !== "pizza") return name === "Padrão" ? { name: "Padrão", price: product.price } : null;
  if (!Array.isArray(product.sizes)) return null;
  return product.sizes.find((option: JsonRecord) => option.name === name) || null;
}

function pizzaLimit(option: JsonRecord): number {
  const configured = Number(option.flavorLimit);
  if (Number.isInteger(configured) && configured > 0) return configured;
  const normalized = String(option.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(broto|pequena|pequeno|individual|mini|p)\b/.test(normalized)) return 1;
  if (/\b(media|medio|m)\b/.test(normalized)) return 2;
  if (/\b(grande|familia|gigante|g)\b/.test(normalized)) return 3;
  return 1;
}

function safeProductName(product: JsonRecord): string {
  return text(product.name, 100);
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") {
    const configured = Boolean(Deno.env.get("SUPABASE_URL") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    return jsonResponse({
      configured,
      paymentMethods: configured ? ["cash_on_delivery", "cash_on_pickup"] : []
    });
  }
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const body = await request.json() as JsonRecord;
    const businessId = text(body.businessId, 50);
    if (!/^[0-9a-f-]{36}$/i.test(businessId)) return jsonResponse({ error: "Invalid store." }, 400);
    const client = adminClient();
    const { data: business, error: businessError } = await client
      .from("business_data")
      .select("data")
      .eq("user_id", businessId)
      .maybeSingle();
    if (businessError) throw businessError;
    const businessData = business?.data as JsonRecord | undefined;
    const sessions = businessData?.cashSessions;
    const cashOpen = Array.isArray(sessions) && sessions.some(session => session && !session.closedAt);
    const availability = storeAvailability(businessData?.storeSettings as JsonRecord | undefined);
    if (!cashOpen || !availability.open) {
      return body.action === "payment_methods"
        ? jsonResponse({ paymentMethods: [], storeOpen: false, nextOpening: availability.nextOpening })
        : jsonResponse({ error: "A loja está fechada para pedidos no momento." }, 409);
    }
    if (body.action === "payment_methods") {
      const { data: publication, error: menuError } = await client
        .from("public_menus")
        .select("menu,pickup_enabled,published")
        .eq("user_id", businessId)
        .eq("published", true)
        .maybeSingle();
      if (menuError) throw menuError;
      if (!publication || (publication.menu as JsonRecord).acceptingOrders !== true) {
        return jsonResponse({ paymentMethods: [], storeOpen: false, nextOpening: availability.nextOpening });
      }

      const paymentMethods = ["cash_on_delivery"];
      if (publication.pickup_enabled) paymentMethods.push("cash_on_pickup");
      const mpConfigured = Boolean(
        Deno.env.get("MP_CLIENT_ID")
        && Deno.env.get("MP_CLIENT_SECRET")
        && Deno.env.get("MP_WEBHOOK_SECRET")
      );
      if (mpConfigured) {
        const { data: connection, error: connectionError } = await client
          .from("mercadopago_connections")
          .select("business_id")
          .eq("business_id", businessId)
          .maybeSingle();
        if (connectionError) throw connectionError;
        if (connection) paymentMethods.push("pix");
      }
      return jsonResponse({ paymentMethods, storeOpen: true, supportsRemovedIngredients: true });
    }

    const customer = body.customer as JsonRecord;
    const fulfillment = text(body.fulfillment, 20);
    const paymentMethod = text(body.paymentMethod, 40);
    if (!customer || typeof customer !== "object") return jsonResponse({ error: "Customer information is required." }, 400);
    const customerName = text(customer.name, 70);
    const customerPhone = text(customer.phone, 25);
    const customerEmail = text(customer.email, 254).toLowerCase();
    const address = text(customer.address, 180);
    const notes = text(customer.notes, 300);
    if (!["delivery", "pickup"].includes(fulfillment)) return jsonResponse({ error: "Invalid order fulfillment." }, 400);
    const allowedPaymentMethods = paymentMethod === "pix"
      ? ["pix"]
      : fulfillment === "pickup" ? ["cash_on_pickup"] : ["cash_on_delivery"];
    if (!allowedPaymentMethods.includes(paymentMethod)) return jsonResponse({ error: "Invalid payment method for this fulfillment option." }, 400);
    if (customerName.length < 2 || customerPhone.length < 8) {
      return jsonResponse({ error: "Enter a valid name and phone number." }, 400);
    }
    if (paymentMethod === "pix" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return jsonResponse({ error: "Enter a valid email address for Pix payment." }, 400);
    }
    if (fulfillment === "delivery" && address.length < 6) return jsonResponse({ error: "Enter a delivery address." }, 400);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
      return jsonResponse({ error: "The order must contain between 1 and 20 items." }, 400);
    }

    const { data: publication, error: menuError } = await client
      .from("public_menus")
      .select("menu,delivery_fee,pickup_enabled,published")
      .eq("user_id", businessId)
      .eq("published", true)
      .maybeSingle();
    if (menuError) throw menuError;
    if (!publication) return jsonResponse({ error: "This store is not accepting online orders." }, 404);
    if ((publication.menu as JsonRecord).acceptingOrders !== true) {
      return jsonResponse({ error: "This store is not accepting online orders." }, 404);
    }
    if (fulfillment === "pickup" && !publication.pickup_enabled) {
      return jsonResponse({ error: "Pickup is not available for this store." }, 400);
    }
    if (paymentMethod === "pix") {
      const mpConfigured = Boolean(
        Deno.env.get("MP_CLIENT_ID")
        && Deno.env.get("MP_CLIENT_SECRET")
        && Deno.env.get("MP_WEBHOOK_SECRET")
      );
      if (!mpConfigured) return jsonResponse({ error: "Pix online is not configured for this store." }, 503);
      const { data: connection, error: connectionError } = await client
        .from("mercadopago_connections")
        .select("business_id")
        .eq("business_id", businessId)
        .maybeSingle();
      if (connectionError) throw connectionError;
      if (!connection) return jsonResponse({ error: "Pix online is not connected for this store." }, 400);
    }

    const menu = publication.menu as JsonRecord;
    if (fulfillment === "pickup" && text(menu.pickupAddress, 180).length < 6) {
      return jsonResponse({ error: "Store pickup address is not configured." }, 400);
    }
    const products = Array.isArray(menu.products) ? menu.products as JsonRecord[] : [];
    const activeProducts = products.filter(product => product.active && (product.category !== "pizza" || menu.pizzaEnabled));
    const orderItems: JsonRecord[] = [];
    let subtotalCents = 0;

    for (const rawItem of body.items as JsonRecord[]) {
      const product = activeProducts.find(candidate => candidate.id === rawItem.productId);
      if (!product) return jsonResponse({ error: "One of the selected products is unavailable." }, 400);
      const quantity = Number(rawItem.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        return jsonResponse({ error: "Invalid item quantity." }, 400);
      }

      const optionName = text(rawItem.optionName, 50);
      const option = sizeOption(product, optionName);
      if (!option || cents(option.price) <= 0) return jsonResponse({ error: "The selected size or option is unavailable." }, 400);
      let flavorProducts = [product];
      let unitPriceCents = cents(option.price);

      if (product.category === "pizza") {
        const flavorIds = Array.isArray(rawItem.flavorIds) ? [...new Set(rawItem.flavorIds.map(id => text(id, 80)))] : [];
        const limit = pizzaLimit(option);
        if (flavorIds.length < 1 || flavorIds.length > limit) {
          return jsonResponse({ error: `Choose between 1 and ${limit} flavors for this size.` }, 400);
        }
        flavorProducts = flavorIds.map(id => activeProducts.find(candidate => candidate.id === id && candidate.category === "pizza")).filter(Boolean) as JsonRecord[];
        if (flavorProducts.length !== flavorIds.length) return jsonResponse({ error: "One of the selected flavors is unavailable." }, 400);
        const flavorOptions = flavorProducts.map(flavor => sizeOption(flavor, optionName));
        if (flavorOptions.some(flavorOption => !flavorOption || cents(flavorOption.price) <= 0)) {
          return jsonResponse({ error: "A selected flavor is not available in this size." }, 400);
        }
        const flavorPrices = flavorOptions.map(flavorOption => cents(flavorOption!.price));
        unitPriceCents = menu.pizzaPricingMode === "highest" ? Math.max(...flavorPrices) : flavorPrices[0];
      }

      let border: JsonRecord | null = null;
      if (product.category === "pizza") {
        const borders = Array.isArray(product.borderOptions) ? product.borderOptions as JsonRecord[] : [];
        border = borders.find(candidate => candidate.name === rawItem.borderName) || null;
        if (rawItem.borderName && rawItem.borderName !== "Sem borda" && !border) {
          return jsonResponse({ error: "The selected crust is unavailable." }, 400);
        }
      }

      const addons = Array.isArray(product.addons) ? product.addons as JsonRecord[] : [];
      const addonIndexes = Array.isArray(rawItem.addonIndexes) ? rawItem.addonIndexes : [];
      if (addonIndexes.length > 20 || addonIndexes.some(index => !Number.isInteger(index) || Number(index) < 0 || Number(index) >= addons.length)) {
        return jsonResponse({ error: "One of the selected add-ons is unavailable." }, 400);
      }
      const selectedAddons = [...new Set(addonIndexes.map(Number))].map(index => addons[index]);
      const removedIngredients = rawItem.removedIngredients === undefined ? [] : rawItem.removedIngredients;
      const ingredients = Array.isArray(product.ingredients) ? product.ingredients : [];
      if (!Array.isArray(removedIngredients) || removedIngredients.length > 50
        || (removedIngredients.length > 0 && product.category !== "lanche")
        || removedIngredients.some(name => typeof name !== "string" || !ingredients.includes(name))) {
        return jsonResponse({ error: "Um ingrediente selecionado não está disponível. Atualize o cardápio e tente novamente." }, 400);
      }
      const borderCents = cents(border?.price ?? 0);
      const addonsCents = selectedAddons.reduce((sum, addon) => sum + Math.max(0, cents(addon.price)), 0);
      const lineTotalCents = (unitPriceCents + borderCents + addonsCents) * quantity;
      if (lineTotalCents <= 0 || lineTotalCents > 1_000_000) return jsonResponse({ error: "Invalid item total." }, 400);
      subtotalCents += lineTotalCents;
      if (subtotalCents > 1_000_000) return jsonResponse({ error: "Order total is above the supported limit." }, 400);

      const flavorNames = flavorProducts.map(safeProductName);
      orderItems.push({
        productId: String(product.id),
        name: flavorNames.join(" / "),
        flavors: flavorNames,
        category: String(product.category),
        optionName,
        price: unitPriceCents / 100,
        quantity,
        border: border ? { name: text(border.name, 60), price: borderCents / 100 } : null,
        addons: selectedAddons.map(addon => ({ name: text(addon.name, 60), price: cents(addon.price) / 100 })),
        removedIngredients: [...new Set(removedIngredients)]
      });
    }

    const deliveryFeeCents = fulfillment === "delivery" ? Math.max(0, cents(publication.delivery_fee)) : 0;
    const totalCents = subtotalCents + deliveryFeeCents;
    if (totalCents <= 0 || totalCents > 1_000_000) return jsonResponse({ error: "Invalid order total." }, 400);
    const forwardedIp = request.headers.get("cf-connecting-ip")
      || request.headers.get("x-real-ip")
      || request.headers.get("x-forwarded-for")?.split(",")[0].trim()
      || "unknown";
    const rateLimitDigest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${businessId}:${forwardedIp}`)
    ));
    const rateLimitKey = [...rateLimitDigest].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const { data: allowed, error: rateLimitError } = await client.rpc("consume_online_order_slot", {
      p_bucket_key: rateLimitKey,
      p_limit: 10
    });
    if (rateLimitError) throw rateLimitError;
    if (!allowed) return jsonResponse({ error: "Muitas tentativas de pedido. Aguarde um minuto e tente novamente." }, 429);

    const { data: order, error: insertError } = await client
      .from("online_orders")
      .insert({
        business_id: businessId,
        payment_status: "pending",
        status: paymentMethod === "pix" ? "Aguardando Pix" : "Recebido",
        total: totalCents / 100,
        order_data: {
          customerName,
          customerPhone,
          customerEmail,
          address: fulfillment === "delivery" ? address : "",
          pickupAddress: fulfillment === "pickup" ? text(menu.pickupAddress, 180) : "",
          notes,
          fulfillment,
          paymentMethod,
          deliveryFee: deliveryFeeCents / 100,
          items: orderItems
        }
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    if (paymentMethod === "pix") {
      let payment: MercadoPagoPixPayment;
      try {
        payment = await createMercadoPagoPixPayment(
          client,
          businessId,
          String(order.id),
          totalCents / 100,
          `Pedido online ${String(order.id).slice(0, 8)}`,
          customerEmail
        );
      } catch (error) {
        const { error: updateError } = await client
          .from("online_orders")
          .update({ payment_status: "failed", status: "Cancelado", updated_at: new Date().toISOString() })
          .eq("id", order.id)
          .eq("payment_status", "pending");
        if (updateError) console.error("Could not mark failed Pix order:", updateError);
        throw error;
      }

      const paymentResult = await reconcilePayment(client, payment, businessId);
      const transactionData = payment.point_of_interaction?.transaction_data;
      if (!transactionData?.qr_code) throw new Error("Mercado Pago returned an empty Pix code.");
      return jsonResponse({
        orderId: order.id,
        total: totalCents / 100,
        paymentMethod,
        paymentStatus: paymentResult.paymentStatus,
        pix: {
          qrCode: transactionData.qr_code,
          qrCodeBase64: transactionData.qr_code_base64 || "",
          ticketUrl: transactionData.ticket_url || ""
        }
      }, 201);
    }

    return jsonResponse({
      orderId: order.id,
      total: totalCents / 100,
      paymentMethod
    }, 201);
  } catch (error) {
    console.error("Could not create online order:", error);
    return jsonResponse({ error: "Não foi possível criar o pedido. Tente novamente." }, 500);
  }
});
