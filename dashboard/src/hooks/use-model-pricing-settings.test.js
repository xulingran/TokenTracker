import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModelPricingSettings } from "./use-model-pricing-settings.js";

function setHostname(hostname) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, hostname },
    writable: true,
    configurable: true,
  });
}

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

describe("useModelPricingSettings", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    vi.unstubAllGlobals();
  });

  it("does not fetch on a public dashboard host", async () => {
    setHostname("www.tokentracker.cc");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { result } = renderHook(() => useModelPricingSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("probes only one catalog row on localhost", async () => {
    setHostname("localhost");
    const fetchSpy = vi.fn(async () => response({ items: [], total: 0 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { result } = renderHook(() => useModelPricingSettings());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith("/functions/tokentracker-model-pricing?limit=1&offset=0", expect.objectContaining({ cache: "no-store" }));
  });

  it("stays unavailable without logging when the probe fails", async () => {
    setHostname("127.0.0.1");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { result } = renderHook(() => useModelPricingSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(false);
  });
});
