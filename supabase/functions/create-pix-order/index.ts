import { adminClient, getMercadoPagoAccessToken } from "../_shared/mercadopago.ts";

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
    const configured = Boolean(
      Deno.env.get("MP_CLIENT_ID") &&
      Deno.env.get("MP_CLIENT_SECRET") &&
      Deno.env.get("MP_WEBHOOK_SECRET") &&
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    );
    return jsonResponse({
      configured,
      paymentMethods: ["pix", "cash_on_delivery", "card_on_delivery", "cash_on_pickup", "card_on_pickup"]
    });
  }
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const body = await request.json() as JsonRecord;
    const businessId = text(body.businessId, 50);
    const customer = body.customer as JsonRecord;
    const fulfillment = text(body.fulfillment, 20);
    const paymentMethod = text(body.paymentMethod, 40);
    if (!/^[0-9a-f-]{36}$/i.test(businessId)) return jsonResponse({ error: "Invalid store." }, 400);
    if (!customer || typeof customer !== "object") return jsonResponse({ error: "Customer information is required." }, 400);
    const customerName = text(customer.name, 70);
    const customerPhone = text(customer.phone, 25);
    const customerEmail = text(customer.email, 254).toLowerCase();
    const address = text(customer.address, 180);
    const notes = text(customer.notes, 300);
    if (!["delivery", "pickup"].includes(fulfillment)) return jsonResponse({ error: "Invalid order fulfillment." }, 400);
    const allowedPaymentMethods = fulfillment === "pickup"
      ? ["pix", "cash_on_pickup", "card_on_pickup"]
      : ["pix", "cash_on_delivery", "card_on_delivery"];
    if (!allowedPaymentMethods.includes(paymentMethod)) return jsonResponse({ error: "Invalid payment method for this fulfillment option." }, 400);
    if (customerName.length < 2 || customerPhone.length < 8
      || (paymentMethod === "pix" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))
      || (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))) {
      return jsonResponse({
        error: paymentMethod === "pix"
          ? "Enter a valid name, phone, and email for Pix payment."
          : "Enter a valid name and phone number."
      }, 400);
    }
    if (fulfillment === "delivery" && address.length < 6) return jsonResponse({ error: "Enter a delivery address." }, 400);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
      return jsonResponse({ error: "The order must contain between 1 and 20 items." }, 400);
    }

    const client = adminClient();
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
        addons: selectedAddons.map(addon => ({ name: text(addon.name, 60), price: cents(addon.price) / 100 }))
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

    const accessToken = paymentMethod === "pix" ? await getMercadoPagoAccessToken(client, businessId) : "";
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

    if (paymentMethod !== "pix") {
      return jsonResponse({
        orderId: order.id,
        total: totalCents / 100,
        paymentMethod
      }, 201);
    }

    const projectUrl = Deno.env.get("SUPABASE_URL");
    if (!projectUrl) throw new Error("Supabase URL is not configured.");
    const notificationUrl = new URL(`${projectUrl}/functions/v1/mercadopago-webhook`);
    notificationUrl.searchParams.set("business_id", businessId);
    const paymentResponse = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": String(order.id)
      },
      body: JSON.stringify({
        transaction_amount: totalCents / 100,
        description: `Pedido online ${String(order.id).slice(0, 8)}`,
        payment_method_id: "pix",
        external_reference: order.id,
        date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        notification_url: notificationUrl.toString(),
        payer: { email: customerEmail, first_name: customerName }
      })
    });
    const payment = await paymentResponse.json() as JsonRecord;
    if (!paymentResponse.ok) {
      console.error("Mercado Pago Pix creation failed:", paymentResponse.status);
      await client.from("online_orders").update({
        payment_status: "failed",
        status: "Cancelado",
        updated_at: new Date().toISOString()
      }).eq("id", order.id);
      return jsonResponse({ error: "Não foi possível gerar o Pix. Confira os dados da conta Mercado Pago e tente novamente." }, 502);
    }

    const pointOfInteraction = payment.point_of_interaction as JsonRecord | undefined;
    const transactionData = pointOfInteraction?.transaction_data as JsonRecord | undefined;
    const paymentId = payment.id;
    const qrCode = text(transactionData?.qr_code, 5000);
    const qrCodeBase64 = text(transactionData?.qr_code_base64, 100_000);
    if (!paymentId || (!qrCode && !qrCodeBase64)) throw new Error("Mercado Pago did not return Pix payment instructions.");
    const { error: updateError } = await client.from("online_orders").update({
      payment_id: String(paymentId),
      updated_at: new Date().toISOString()
    }).eq("id", order.id);
    if (updateError) throw updateError;

    return jsonResponse({
      orderId: order.id,
      total: totalCents / 100,
      pixCopyPaste: qrCode,
      pixQrBase64: qrCodeBase64,
      ticketUrl: text(transactionData?.ticket_url, 1000)
    }, 201);
  } catch (error) {
    console.error("Could not create online order:", error);
    const message = error instanceof Error ? error.message : "Unexpected error.";
    if (message.includes("not configured")) {
      return jsonResponse({ error: "O pagamento Pix ainda não está configurado. Fale com a loja ou escolha pagar no recebimento." }, 500);
    }
    if (message.includes("not connected")) {
      return jsonResponse({ error: "A loja ainda não conectou o Mercado Pago. Escolha pagar no recebimento." }, 503);
    }
    return jsonResponse({ error: "Não foi possível criar o pedido. Tente novamente." }, 500);
  }
});
