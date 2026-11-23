import React, { useEffect, useState } from "react";
import { Loader2, Pencil, Plus, RotateCcw, Search } from "lucide-react";
import { copy } from "../../lib/copy";
import {
  deleteModelPricingOverride,
  readModelPricing,
  setModelPricingOverride,
} from "../../lib/model-pricing-api";
import { Button } from "../../ui/components/Button.jsx";
import { SectionCard, SETTINGS_INPUT_CLASS } from "./Controls.jsx";

const PAGE_SIZE = 50;
const RATE_FIELDS = ["input", "output", "cache_read", "cache_write"];
const EMPTY_CATALOG = { items: [], total: 0, revision: 0, override_count: 0 };

function itemKey(item) {
  return `${item.source || ""}\0${item.model}`;
}

function hasOwnOverride(item) {
  return item.pricing_source === "user:source-exact" ||
    (item.pricing_source === "user:exact" && !item.source);
}

function blankEditor() {
  return {
    isNew: true,
    model: "",
    source: "",
    input: "0",
    output: "0",
    cache_read: "0",
    cache_write: "0",
  };
}

function formatRate(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 10 });
}

function validateDraft(draft) {
  if (!draft.model.trim()) return copy("settings.model_pricing.error.model");
  if (draft.source.trim() && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(draft.source.trim())) {
    return copy("settings.model_pricing.error.source");
  }
  for (const field of RATE_FIELDS) {
    const raw = String(draft[field]).trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
      return copy("settings.model_pricing.error.rate", { field: copy(`settings.model_pricing.${field}`) });
    }
  }
  return null;
}

export function PricingSection({ active = true }) {
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState("");
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [editor, setEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingReset, setPendingReset] = useState("");

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    setLoading(true);
    setError("");
    readModelPricing({ q: query, origin, limit: PAGE_SIZE, offset })
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError?.message || String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, query, origin, offset, reload]);

  function submitSearch(event) {
    event.preventDefault();
    setEditor(null);
    setOffset(0);
    setQuery(queryDraft.trim());
  }

  function selectOrigin(next) {
    setEditor(null);
    setOffset(0);
    setOrigin(next);
  }

  function openEditor(item) {
    setError("");
    setStatus("");
    setPendingReset("");
    setEditor(item ? {
      isNew: false,
      model: item.model,
      source: item.source || "",
      input: String(item.input ?? 0),
      output: String(item.output ?? 0),
      cache_read: String(item.cache_read ?? 0),
      cache_write: String(item.cache_write ?? 0),
    } : blankEditor());
  }

  async function saveEditor(event) {
    event.preventDefault();
    const validationError = validateDraft(editor);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError("");
    setStatus("");
    try {
      await setModelPricingOverride({
        model: editor.model.trim(),
        source: editor.source.trim() ? editor.source.trim().toLowerCase() : null,
        ...Object.fromEntries(RATE_FIELDS.map((field) => [field, Number(editor[field])])),
      });
      window.dispatchEvent(new Event("tt:model-pricing-changed"));
      setEditor(null);
      setStatus(copy("settings.model_pricing.saved"));
      setReload((value) => value + 1);
    } catch (saveError) {
      setError(saveError?.message || String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function resetOverride(item) {
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const result = await deleteModelPricingOverride(item);
      if (!result.deleted) {
        setPendingReset("");
        setReload((value) => value + 1);
        return;
      }
      window.dispatchEvent(new Event("tt:model-pricing-changed"));
      setPendingReset("");
      setEditor(null);
      setStatus(copy("settings.model_pricing.restored"));
      setReload((value) => value + 1);
    } catch (resetError) {
      setError(resetError?.message || String(resetError));
    } finally {
      setSaving(false);
    }
  }

  const from = catalog.total ? offset + 1 : 0;
  const to = Math.min(offset + PAGE_SIZE, catalog.total);

  return (
    <div className="space-y-4">
      <SectionCard
        title={copy("settings.section.model_pricing")}
        subtitle={copy("settings.model_pricing.subtitle")}
        action={(
          <Button type="button" variant="secondary" size="sm" className="gap-1.5" onClick={() => openEditor(null)}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {copy("settings.model_pricing.add")}
          </Button>
        )}
      >
        <p className="py-3 text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
          {copy("settings.model_pricing.scope")}
        </p>
        {catalog.storage_error ? (
          <p role="alert" className="py-2 text-xs text-red-600 dark:text-red-400">
            {copy("settings.model_pricing.storage_error", { error: catalog.storage_error })}
          </p>
        ) : null}
        <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <form className="flex min-w-0 flex-1 gap-2" onSubmit={submitSearch}>
            <input
              type="search"
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder={copy("settings.model_pricing.search_placeholder")}
              aria-label={copy("settings.model_pricing.search_label")}
              className={SETTINGS_INPUT_CLASS}
            />
            <Button type="submit" variant="secondary" size="sm" className="shrink-0 gap-1.5">
              <Search className="h-3.5 w-3.5" aria-hidden />
              {copy("settings.model_pricing.search")}
            </Button>
          </form>
          <div className="inline-flex items-center gap-1 rounded-md border border-oai-gray-200 p-0.5 dark:border-oai-gray-800">
            {["", "custom"].map((value) => (
              <button
                key={value || "all"}
                type="button"
                aria-pressed={origin === value}
                onClick={() => selectOrigin(value)}
                className={`rounded px-2.5 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500 ${origin === value ? "bg-oai-gray-100 text-oai-black dark:bg-oai-gray-800 dark:text-white" : "text-oai-gray-500 dark:text-oai-gray-400"}`}
              >
                {copy(value ? "settings.model_pricing.custom_only" : "settings.model_pricing.all")}
              </button>
            ))}
          </div>
        </div>

        {editor ? (
          <form className="rounded-lg border border-oai-gray-200 bg-oai-gray-50 p-4 dark:border-oai-gray-800 dark:bg-oai-gray-900" onSubmit={saveEditor}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
                {copy("settings.model_pricing.model")}
                <input
                  value={editor.model}
                  onChange={(event) => setEditor({ ...editor, model: event.target.value })}
                  disabled={!editor.isNew || saving}
                  aria-label={copy("settings.model_pricing.model")}
                  placeholder={copy("settings.model_pricing.model_placeholder")}
                  className={`${SETTINGS_INPUT_CLASS} mt-1.5`}
                />
              </label>
              <label className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
                {copy("settings.model_pricing.provider_optional")}
                <input
                  value={editor.source}
                  onChange={(event) => setEditor({ ...editor, source: event.target.value })}
                  disabled={!editor.isNew || saving}
                  aria-label={copy("settings.model_pricing.provider_optional")}
                  placeholder={copy("settings.model_pricing.provider_placeholder")}
                  className={`${SETTINGS_INPUT_CLASS} mt-1.5`}
                />
              </label>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {RATE_FIELDS.map((field) => (
                <label key={field} className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
                  {copy(`settings.model_pricing.${field}`)}
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={editor[field]}
                    onChange={(event) => setEditor({ ...editor, [field]: event.target.value })}
                    disabled={saving}
                    aria-label={copy(`settings.model_pricing.${field}`)}
                    className={`${SETTINGS_INPUT_CLASS} mt-1.5`}
                  />
                </label>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => setEditor(null)}>
                {copy("settings.model_pricing.cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={saving} className="gap-1.5">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                {copy(saving ? "settings.model_pricing.saving" : "settings.model_pricing.save")}
              </Button>
            </div>
          </form>
        ) : null}

        {error ? <p role="alert" className="py-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        {status ? <p role="status" className="py-3 text-xs text-emerald-600 dark:text-emerald-400">{status}</p> : null}

        <div className="overflow-x-auto py-2">
          <table className="w-full min-w-[680px] border-collapse text-left text-xs md:min-w-0 md:table-fixed">
            <colgroup>
              <col className="md:w-[27%]" />
              <col className="md:w-[11%]" />
              <col className="md:w-[8%]" />
              <col className="md:w-[8%]" />
              <col className="md:w-[8%]" />
              <col className="md:w-[8%]" />
              <col className="md:w-[12%]" />
              <col className="md:w-[18%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-oai-gray-200 text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
                {["model", "provider", "input", "output", "cache_read", "cache_write", "price_source", "actions"].map((field) => (
                  <th key={field} scope="col" className={`px-2 py-2 font-medium ${RATE_FIELDS.includes(field) ? "whitespace-nowrap md:px-1" : ""}`}>{copy(`settings.model_pricing.${field}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody className={loading ? "opacity-50" : undefined}>
              {catalog.items.map((item) => {
                const key = itemKey(item);
                const resettable = item.overridden && hasOwnOverride(item);
                return (
                  <tr key={key} className="border-b border-oai-gray-100 last:border-0 dark:border-oai-gray-800/70">
                    <td className="px-2 py-3 font-mono text-oai-gray-900 dark:text-oai-gray-200">
                      <span className="break-all">{item.model}</span>
                    </td>
                    <td className="break-words px-2 py-3 text-oai-gray-500 dark:text-oai-gray-400">{item.source || copy("settings.model_pricing.all_providers")}</td>
                    {RATE_FIELDS.map((field) => <td key={field} className="break-all px-2 py-3 tabular-nums text-oai-gray-700 dark:text-oai-gray-300 md:px-1">{formatRate(item[field])}</td>)}
                    <td className="px-2 py-3">
                      <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${item.overridden ? "bg-oai-brand-50 text-oai-brand-700 dark:bg-oai-brand-950 dark:text-oai-brand-300" : "bg-oai-gray-100 text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300"}`}>
                        {copy(`settings.model_pricing.origin.${item.origin}`)}
                      </span>
                    </td>
                    <td className="px-2 py-3">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <Button type="button" variant="ghost" size="sm" className="!h-7 !w-7 !p-0" onClick={() => openEditor(item)} aria-label={`${copy("settings.model_pricing.edit")} ${item.model}`} title={copy("settings.model_pricing.edit")}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        {resettable && pendingReset !== key ? (
                          <Button type="button" variant="ghost" size="sm" className="!h-7 !w-7 !p-0" disabled={saving} onClick={() => setPendingReset(key)} aria-label={`${copy("settings.model_pricing.restore_default")} ${item.model}`} title={copy("settings.model_pricing.restore_default")}>
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        ) : null}
                        {resettable && pendingReset === key ? (
                          <>
                            <Button type="button" variant="secondary" size="sm" className="!h-7 !px-2 !text-xs" disabled={saving} onClick={() => resetOverride(item)}>{copy("settings.model_pricing.confirm_restore")}</Button>
                            <Button type="button" variant="ghost" size="sm" className="!h-7 !px-2 !text-xs" disabled={saving} onClick={() => setPendingReset("")}>{copy("settings.model_pricing.cancel")}</Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && !error && catalog.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("settings.model_pricing.empty")}</p>
          ) : null}
          {loading ? (
            <p role="status" className="flex items-center justify-center gap-2 py-4 text-xs text-oai-gray-500 dark:text-oai-gray-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {copy("settings.model_pricing.loading")}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-3 py-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          <span>{copy("settings.model_pricing.page_status", { from, to, total: catalog.total })}</span>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={loading || offset === 0} onClick={() => { setEditor(null); setOffset(Math.max(0, offset - PAGE_SIZE)); }}>{copy("settings.model_pricing.previous")}</Button>
            <Button type="button" variant="secondary" size="sm" disabled={loading || to >= catalog.total} onClick={() => { setEditor(null); setOffset(offset + PAGE_SIZE); }}>{copy("settings.model_pricing.next")}</Button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
