import { getLocalApiAuthHeaders } from "./local-api-auth";

const MODEL_PRICING_PATH = "/functions/tokentracker-model-pricing";

async function payload(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `Model pricing request failed with HTTP ${response.status}`);
  }
  return data;
}

export async function readModelPricing({ q = "", source = "", origin = "", limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (q) params.set("q", q);
  if (source) params.set("source", source);
  if (origin) params.set("origin", origin);
  const response = await fetch(`${MODEL_PRICING_PATH}?${params}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const data = await payload(response);
  if (!Array.isArray(data.items)) throw new Error("Invalid model pricing response");
  return data;
}

async function mutate(body) {
  const auth = await getLocalApiAuthHeaders();
  const response = await fetch(MODEL_PRICING_PATH, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...auth },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  return payload(response);
}

export function setModelPricingOverride(override) {
  return mutate({ action: "set", override });
}

export function deleteModelPricingOverride({ model, source = null }) {
  return mutate({ action: "delete", override: { model, source } });
}
