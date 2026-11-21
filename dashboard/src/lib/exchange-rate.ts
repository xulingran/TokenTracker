import { isValidRate, SUPPORTED_CURRENCY_CODES } from "./currency";

// Daily Currency API data served by npmmirror's mainland-China-accessible CDN.
// No API key is required and Origin-aware CORS supports NAS dashboard origins.
// Failure is graceful — callers fall back to cached or bundled-default rates.
export const EXCHANGE_RATE_API_URL =
  "https://registry.npmmirror.com/@fawazahmed0/currency-api/latest/files/v1/currencies/usd.json";

export const EXCHANGE_RATE_TTL_MS = 24 * 60 * 60 * 1000;
export const EXCHANGE_RATE_FETCH_TIMEOUT_MS = 5000;

export interface FetchedRates {
  rates: Record<string, number>;
  fetchedAt: number;
}

export function shouldRefetch(
  fetchedAt: number | null | undefined,
  ttlMs: number = EXCHANGE_RATE_TTL_MS,
  now: number = Date.now(),
): boolean {
  if (!fetchedAt || !Number.isFinite(fetchedAt)) return true;
  return now - fetchedAt > ttlMs;
}

interface FetchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  url?: string;
  codes?: readonly string[];
}

export async function fetchUsdRates(opts: FetchOptions = {}): Promise<FetchedRates> {
  const {
    timeoutMs = EXCHANGE_RATE_FETCH_TIMEOUT_MS,
    fetchImpl,
    url = EXCHANGE_RATE_API_URL,
    codes = SUPPORTED_CURRENCY_CODES,
  } = opts;

  const f = fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
  if (!f) throw new Error("fetch is not available");

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const res = await f(url, controller ? { signal: controller.signal } : undefined);
    if (!res || !res.ok) {
      throw new Error(`exchange rate fetch failed: ${res?.status ?? "no-response"}`);
    }
    const data = await res.json();
    const apiRates = data?.usd;
    if (!apiRates || typeof apiRates !== "object") {
      throw new Error("exchange rate response missing rates");
    }
    const picked: Record<string, number> = { USD: 1 };
    for (const code of codes) {
      if (code === "USD") continue;
      const v = (apiRates as any)[code.toLowerCase()];
      if (isValidRate(v)) picked[code] = v;
    }
    if (Object.keys(picked).length <= 1) {
      throw new Error("no supported currency rates in response");
    }
    return { rates: picked, fetchedAt: Date.now() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
