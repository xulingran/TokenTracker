import { useEffect, useState } from "react";
import { isLocalDashboardHost } from "../lib/host-mode";
import { readModelPricing } from "../lib/model-pricing-api";

/** Probe the local pricing API without loading the full catalog on Settings. */
export function useModelPricingSettings() {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLocalDashboardHost()) {
      setAvailable(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    readModelPricing({ limit: 1 })
      .then(() => {
        if (!cancelled) setAvailable(true);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { available, loading };
}
