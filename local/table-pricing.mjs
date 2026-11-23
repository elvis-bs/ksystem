export class PricingInputError extends TypeError {}
export class PricingDataError extends Error {}

function text(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new PricingInputError(`Invalid ${field}`);
  return value;
}

function finite(value, field) {
  const parsed = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(parsed) || parsed < 0) {
    throw new PricingInputError(`Invalid ${field}`);
  }
  return parsed;
}

function money(value, field) {
  const amount = finite(value, field);
  if (!Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
    throw new PricingInputError(`Invalid ${field}`);
  }
  return Math.round(amount * 100) / 100;
}

function normalized(value) {
  return text(value, "size").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
}

function flavorLimit(snapshot, option) {
  const shared = Array.isArray(snapshot.pizzaSizes)
    ? snapshot.pizzaSizes.find(size => normalized(size.name) === normalized(option.name)) : null;
  const configured = Number(shared?.flavorLimit || option.flavorLimit);
  if (Number.isInteger(configured) && configured > 0) return Math.min(20, configured);
  const name = normalized(option.name);
  if (/\b(broto|pequena|pequeno|individual|mini|p)\b/.test(name)) return 1;
  if (/\b(media|medio|m)\b/.test(name)) return 2;
  if (/\b(grande|familia|gigante|g)\b/.test(name)) return 3;
  return 1;
}

function productCost(snapshot, product, option) {
  if (product.category === "bebida") return money(product.cost, "product cost");
  if (!Array.isArray(product.recipe)) throw new PricingDataError("Invalid product recipe");
  const factor = product.category === "pizza" ? finite(option.factor || 1, "size factor") : 1;
  const total = product.recipe.reduce((sum, entry) => {
    const matches = snapshot.ingredients.filter(ingredient => ingredient.id === entry.ingredientId);
    if (matches.length !== 1) throw new PricingDataError("Ingredient not found or duplicated");
    return sum + finite(entry.quantity, "ingredient quantity") * finite(matches[0].cost, "ingredient cost") * factor;
  }, 0);
  if (!Number.isFinite(total) || !Number.isSafeInteger(Math.round(total * 100))) throw new PricingDataError("Invalid product cost");
  return total;
}

function selectedOptions(options, indexes, field) {
  if (!Array.isArray(options) || !Array.isArray(indexes) || indexes.length > 20
    || new Set(indexes).size !== indexes.length) throw new PricingInputError(`Invalid ${field}`);
  return indexes.map(index => {
    if (!Number.isInteger(index) || index < 0 || index >= options.length) throw new PricingInputError(`Invalid ${field}`);
    const option = options[index];
    return { name: text(option.name, field), price: money(option.price, `${field} price`), cost: money(option.cost ?? 0, `${field} cost`) };
  });
}

export function priceTableItems(snapshot, requests) {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 20) throw new PricingInputError("Invalid items");
  return requests.map(request => {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new PricingInputError("Invalid item");
    const allowed = ["productId", "optionName", "quantity", "flavorIds", "addonIndexes", "borderIndex"];
    if (Object.keys(request).some(key => !allowed.includes(key))) throw new PricingInputError("Unexpected item field");
    const id = text(request.productId, "product ID");
    const matches = snapshot.products.filter(product => product.id === id);
    if (matches.length !== 1 || matches[0].active !== true) throw new PricingDataError("Product unavailable");
    const product = matches[0];
    if (!["pizza", "lanche", "bebida"].includes(product.category)) throw new PricingDataError("Unsupported product category");
    if (!Number.isSafeInteger(request.quantity) || request.quantity < 1 || request.quantity > 10000) {
      throw new PricingInputError("Invalid quantity");
    }
    const optionName = text(request.optionName, "option");
    const pizza = product.category === "pizza";
    if (pizza && snapshot.pizzaEnabled !== true) throw new PricingDataError("Pizza unavailable");
    const options = pizza ? product.sizes : [{ name: "Padrão", price: product.price, factor: 1 }];
    if (!Array.isArray(options)) throw new PricingDataError("Invalid product sizes");
    const matchingOptions = options.filter(option => normalized(option.name) === normalized(optionName));
    if (matchingOptions.length !== 1) throw new PricingDataError("Product option unavailable");
    const option = matchingOptions[0];
    let flavors = [{ product, option }];
    if (pizza) {
      if (!Array.isArray(request.flavorIds) || !request.flavorIds.length
        || new Set(request.flavorIds).size !== request.flavorIds.length
        || request.flavorIds.length > flavorLimit(snapshot, option)) throw new PricingInputError("Invalid pizza flavors");
      const selected = new Set(request.flavorIds.map(id => text(id, "flavor ID")));
      for (const flavorId of selected) {
        if (snapshot.products.filter(item => item.id === flavorId).length !== 1) {
          throw new PricingDataError("Pizza flavor unavailable or duplicated");
        }
      }
      flavors = [product, ...snapshot.products.filter(item => item.id !== product.id)]
        .filter(item => selected.has(item.id)).map(item => {
          if (item.category !== "pizza" || item.active !== true || !Array.isArray(item.sizes)) {
            throw new PricingDataError("Pizza flavor unavailable");
          }
          const sizes = item.sizes.filter(size => normalized(size.name) === normalized(option.name));
          if (sizes.length !== 1) throw new PricingDataError("Pizza flavor size unavailable");
          return { product: item, option: sizes[0] };
        });
      if (flavors.length !== selected.size) throw new PricingDataError("Pizza flavor unavailable or duplicated");
    } else if (request.flavorIds !== undefined || request.borderIndex !== undefined) {
      throw new PricingInputError("Pizza selections not allowed");
    }
    const addons = selectedOptions(product.addons ?? [], request.addonIndexes === undefined ? [] : request.addonIndexes, "addons");
    const border = pizza && request.borderIndex !== undefined && request.borderIndex !== null
      ? selectedOptions(product.borderOptions ?? [], [request.borderIndex], "border")[0] : null;
    const prices = flavors.map(item => money(item.option.price, "product price"));
    const price = pizza && snapshot.pizzaPricingMode === "highest" ? Math.max(...prices) : prices[0];
    const cost = Math.round((flavors.reduce((sum, item) => sum + productCost(snapshot, item.product, item.option), 0)
      / flavors.length + Number.EPSILON) * 100) / 100;
    return {
      productId: product.id,
      name: flavors.map(item => text(item.product.name, "product name")).join(" / "),
      flavors: flavors.map(item => item.product.name),
      category: product.category,
      optionName: option.name,
      price,
      cost,
      quantity: request.quantity,
      border,
      addons
    };
  });
}
