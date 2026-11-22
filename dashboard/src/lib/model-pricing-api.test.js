import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteModelPricingOverride,
  readModelPricing,
  setModelPricingOverride,
} from "./model-pricing-api.js";
import { getLocalApiAuthHeaders } from "./local-api-auth";

vi.mock("./local-api-auth", () => ({
  getLocalApiAuthHeaders: vi.fn(async () => ({ "x-tokentracker-local-auth": "token" })),
}));

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("model pricing API", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getLocalApiAuthHeaders.mockResolvedValue({ "x-tokentracker-local-auth": "token" });
  });

  it("encodes catalog filters and validates the response", async () => {
    const fetchSpy = vi.fn(async () => response({ items: [], total: 0 }));
    vi.stubGlobal("fetch", fetchSpy);
    await readModelPricing({ q: "claude opus", source: "claude", origin: "custom", limit: 25, offset: 50 });
    const url = new URL(fetchSpy.mock.calls[0][0], "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "claude opus", source: "claude", origin: "custom", limit: "25", offset: "50" });
  });

  it("adds local auth to set and delete mutations", async () => {
    const fetchSpy = vi.fn(async () => response({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    await setModelPricingOverride({ model: "foo", source: null, input: 1, output: 2, cache_read: 0, cache_write: 0 });
    await deleteModelPricingOverride({ model: "foo", source: null });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchSpy.mock.calls) {
      expect(url).toBe("/functions/tokentracker-model-pricing");
      expect(options.method).toBe("POST");
      expect(options.headers["x-tokentracker-local-auth"]).toBe("token");
    }
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).action).toBe("set");
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body).action).toBe("delete");
  });

  it("surfaces backend errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ok: false, error: "invalid rate" }, 400)));
    await expect(setModelPricingOverride({ model: "foo" })).rejects.toThrow("invalid rate");
  });
});
