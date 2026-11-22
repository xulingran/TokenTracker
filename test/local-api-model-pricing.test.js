"use strict";

// Local API surface for model pricing: public catalog reads, authenticated
// override mutations, persistence/reload behavior, and cost recalculation in
// the usage statistics endpoints.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");
const pricing = require("../src/lib/pricing");
const overrides = require("../src/lib/pricing/overrides");

const BASE_RATES = { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 };

let tmpDir;
let queuePath;

beforeEach(() => {
  pricing.resetPricingForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-model-pricing-api-"));
  queuePath = path.join(tmpDir, "queue.jsonl");
  fs.writeFileSync(queuePath, "");
});

afterEach(() => {
  pricing.resetPricingForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freshHandler() {
  return createLocalApiHandler({ queuePath, trackerDataDir: tmpDir });
}

function pricingStorePath() {
  return overrides.resolvePricingOverridesPath(tmpDir);
}

function writeQueue(rows) {
  fs.writeFileSync(queuePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function makeReq({ method = "GET", urlObj, headers = {}, body } = {}) {
  const base = Readable.from(body != null ? [Buffer.from(body)] : []);
  base.method = method;
  base.url = urlObj.pathname + urlObj.search;
  base.headers = { host: "localhost", ...headers };
  return base;
}

function makeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    setHeader(key, value) {
      headers[key.toLowerCase()] = value;
    },
    writeHead(status, extra) {
      this.statusCode = status;
      if (extra) for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value;
    },
    write(chunk) {
      chunks.push(chunk);
    },
    end(body) {
      if (body) chunks.push(body);
    },
    body() {
      return chunks.join("");
    },
    json() {
      return JSON.parse(chunks.join(""));
    },
  };
}

async function call(handler, opts) {
  const urlObj = new URL(`http://localhost${opts.endpoint}`);
  const req = makeReq({ ...opts, urlObj });
  const res = makeRes();
  const handled = await handler(req, res, urlObj);
  assert.ok(handled, `endpoint must be handled: ${opts.endpoint}`);
  return res;
}

async function authToken(handler) {
  const res = await call(handler, { endpoint: "/api/local-auth" });
  return res.json().token;
}

function headersFor(token, extra = {}) {
  return {
    "content-type": "application/json",
    "x-tokentracker-local-auth": token,
    ...extra,
  };
}

async function postPricing(handler, token, body, extraHeaders = {}) {
  return call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-model-pricing",
    headers: headersFor(token, extraHeaders),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function findCatalogItem(payload, model, source) {
  return payload.items.find((item) => item.model === model && item.source === source);
}

function ratesOfLive(model, source) {
  const value = pricing.getModelPricing(model, source ? { source } : undefined);
  return {
    input: value.input,
    output: value.output,
    cache_read: value.cache_read,
    cache_write: value.cache_write,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET catalog

test("GET model pricing catalog is public and applies search, pagination and clamps", async () => {
  const handler = freshHandler();

  const res = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=kiro-cli-agent&limit=1&offset=0",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.loaded, false);
  assert.equal(body.pricing_source, "seed-snapshot:sync");
  assert.equal(typeof body.revision, "number");
  assert.equal(body.override_count, 0);
  assert.equal(body.storage_error, null);
  assert.equal(body.total, 1);
  assert.equal(body.limit, 1);
  assert.equal(body.offset, 0);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].model, "kiro-cli-agent");
  assert.equal(body.items[0].source, null);
  assert.equal(body.items[0].origin, "curated");
  assert.equal(body.items[0].overridden, false);
  assert.equal(body.items[0].pricing_source, "curated:exact");
  assert.equal(body.items[0].input, 3);
  assert.equal(body.items[0].output, 15);

  const zeroLimit = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=kiro-cli-agent&limit=0",
  });
  assert.equal(zeroLimit.json().limit, 1);

  const hugeLimit = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?limit=9999",
  });
  assert.equal(hugeLimit.json().limit, 200);
  assert.equal(hugeLimit.json().items.length, 200);

  const defaults = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?limit=abc&offset=-5",
  });
  assert.equal(defaults.json().limit, 100);
  assert.equal(defaults.json().offset, 0);

  const empty = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=tt-no-such-model-anywhere",
  });
  assert.equal(empty.json().total, 0);
  assert.deepEqual(empty.json().items, []);
});

test("GET reports a corrupt override store as storage_error and recovers after a write", async () => {
  fs.writeFileSync(pricingStorePath(), "{not json", "utf8");
  const handler = freshHandler();

  const broken = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=kiro-cli-agent",
  });
  assert.equal(broken.statusCode, 200);
  assert.match(broken.json().storage_error, /corrupted/);
  assert.equal(broken.json().override_count, 0);
  assert.equal(broken.json().total, 1);
  const revisionBefore = broken.json().revision;

  const token = await authToken(handler);
  const saved = await postPricing(handler, token, {
    action: "set",
    override: { model: "corrupt-recovery-model", ...BASE_RATES },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().ok, true);
  assert.equal(saved.json().revision, revisionBefore + 1);

  const recovered = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=corrupt-recovery-model",
  });
  assert.equal(recovered.json().storage_error, null);
  assert.equal(recovered.json().override_count, 1);
  assert.equal(recovered.json().total, 1);
  assert.equal(recovered.json().items[0].origin, "custom");
  assert.equal(recovered.json().items[0].input, 1);

  const backups = fs.readdirSync(tmpDir)
    .filter((name) => name.startsWith("pricing-overrides.json.corrupt-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(
    ratesOfLive("corrupt-recovery-model"),
    { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST authentication and method handling

test("POST requires local auth and a loopback origin", async () => {
  const handler = freshHandler();
  const token = await authToken(handler);
  const body = { action: "set", override: { model: "auth-model", ...BASE_RATES } };

  const before = await call(handler, { endpoint: "/functions/tokentracker-model-pricing?q=auth-model" });
  const revisionBefore = before.json().revision;

  const unauthenticated = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-model-pricing",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().ok, false);
  assert.match(unauthenticated.json().error, /Unauthorized/);

  const wrongToken = await postPricing(handler, "not-the-token", body);
  assert.equal(wrongToken.statusCode, 401);

  const crossSiteOrigin = await postPricing(handler, token, body, {
    origin: "https://evil.example",
  });
  assert.equal(crossSiteOrigin.statusCode, 401);

  const crossSiteReferer = await postPricing(handler, token, body, {
    referer: "https://evil.example/page",
  });
  assert.equal(crossSiteReferer.statusCode, 401);

  const nonLoopbackOrigin = await postPricing(handler, token, body, {
    origin: "http://example.com",
  });
  assert.equal(nonLoopbackOrigin.statusCode, 401);

  const unchanged = await call(handler, { endpoint: "/functions/tokentracker-model-pricing?q=auth-model" });
  assert.equal(unchanged.json().override_count, 0);
  assert.equal(unchanged.json().revision, revisionBefore);
  assert.equal(fs.existsSync(pricingStorePath()), false);

  const allowed = await postPricing(handler, token, body, {
    origin: "http://localhost:5173",
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().revision, revisionBefore + 1);

  // A same-origin WebView may authenticate with the cookie instead of the
  // header, and a non-browser local client may omit Origin entirely.
  const cookieAllowed = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-model-pricing",
    headers: {
      "content-type": "application/json",
      cookie: `tokentracker_local_auth=${token}`,
      origin: "http://127.0.0.1:4173",
    },
    body: JSON.stringify({
      action: "set",
      override: { model: "cookie-auth-model", ...BASE_RATES },
    }),
  });
  assert.equal(cookieAllowed.statusCode, 200);

  const noOriginAllowed = await postPricing(handler, token, {
    action: "set",
    override: { model: "no-origin-model", ...BASE_RATES },
  });
  assert.equal(noOriginAllowed.statusCode, 200);

  const badCookie = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-model-pricing",
    headers: { "content-type": "application/json", cookie: "tokentracker_local_auth=wrong" },
    body: JSON.stringify(body),
  });
  assert.equal(badCookie.statusCode, 401);

  const put = await call(handler, {
    method: "PUT",
    endpoint: "/functions/tokentracker-model-pricing",
    headers: headersFor(token),
    body: JSON.stringify(body),
  });
  assert.equal(put.statusCode, 405);
});

test("an override persisted through POST is loaded by a restarted handler", async () => {
  const first = freshHandler();
  const token = await authToken(first);
  const saved = await postPricing(first, token, {
    action: "set",
    override: { model: "restart-persisted-model", source: "claude", ...BASE_RATES },
  });
  assert.equal(saved.statusCode, 200);

  // Simulate a process restart: drop in-memory pricing state and build a new
  // handler over the same tracker directory.
  pricing.resetPricingForTests();
  const restarted = freshHandler();

  const catalog = await call(restarted, {
    endpoint: "/functions/tokentracker-model-pricing?q=restart-persisted-model&source=claude",
  });
  assert.equal(catalog.json().override_count, 1);
  assert.equal(catalog.json().storage_error, null);
  assert.equal(catalog.json().total, 1);
  assert.equal(catalog.json().items[0].origin, "custom");
  assert.equal(catalog.json().items[0].pricing_source, "user:source-exact");
  assert.equal(catalog.json().items[0].input, 1);
  assert.equal(catalog.json().items[0].output, 2);
  assert.deepEqual(
    ratesOfLive("restart-persisted-model", "claude"),
    { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST set

test("POST set persists an override and the catalog plus live pricing reflect it", async () => {
  const handler = freshHandler();
  const token = await authToken(handler);

  const initial = await call(handler, { endpoint: "/functions/tokentracker-model-pricing?limit=1" });
  const revisionBefore = initial.json().revision;

  const saved = await postPricing(handler, token, {
    action: "set",
    override: { model: "claude-sonnet-4-6", source: "claude", ...BASE_RATES },
  });
  assert.equal(saved.statusCode, 200);
  const savedBody = saved.json();
  assert.equal(savedBody.ok, true);
  assert.equal(savedBody.revision, revisionBefore + 1);
  assert.equal(savedBody.override.model, "claude-sonnet-4-6");
  assert.equal(savedBody.override.source, "claude");
  assert.equal(savedBody.override.input, 1);
  assert.ok(savedBody.override.createdAt);

  const store = JSON.parse(fs.readFileSync(pricingStorePath(), "utf8"));
  assert.equal(store.version, 1);
  assert.deepEqual(store.items, [savedBody.override]);

  const catalog = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=claude-sonnet-4-6&source=claude",
  });
  assert.equal(catalog.json().override_count, 1);
  assert.equal(catalog.json().revision, savedBody.revision);
  assert.equal(catalog.json().total, 1);
  assert.equal(catalog.json().items[0].origin, "custom");
  assert.equal(catalog.json().items[0].overridden, true);
  assert.equal(catalog.json().items[0].source, "claude");
  assert.equal(catalog.json().items[0].pricing_source, "user:source-exact");
  assert.equal(catalog.json().items[0].input, 1);
  assert.equal(catalog.json().items[0].output, 2);

  assert.deepEqual(
    ratesOfLive("claude-sonnet-4-6", "claude"),
    { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
  );

  // A flat body (no `override` wrapper) is accepted too.
  const flat = await postPricing(handler, token, {
    action: "set",
    model: "claude-sonnet-4-6",
    source: "claude",
    ...BASE_RATES,
    input: 4,
    output: 8,
  });
  assert.equal(flat.statusCode, 200);
  assert.equal(flat.json().override.input, 4);
  assert.equal(flat.json().override.createdAt, savedBody.override.createdAt);
  assert.equal(flat.json().override.updatedAt >= savedBody.override.updatedAt, true);
  assert.equal(JSON.parse(fs.readFileSync(pricingStorePath(), "utf8")).items.length, 1);

  // Identity matching is case-insensitive, so a re-cased model replaces the
  // same record instead of adding a duplicate.
  const recased = await postPricing(handler, token, {
    action: "set",
    override: { model: "  CLAUDE-SONNET-4-6  ", source: "CLAUDE", ...BASE_RATES },
  });
  assert.equal(recased.statusCode, 200);
  assert.equal(recased.json().override.model, "CLAUDE-SONNET-4-6");
  assert.equal(recased.json().override.source, "claude");
  assert.equal(JSON.parse(fs.readFileSync(pricingStorePath(), "utf8")).items.length, 1);
  assert.deepEqual(
    ratesOfLive("claude-sonnet-4-6", "claude"),
    { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
  );
  assert.equal(recased.json().revision, savedBody.revision + 2);
});

test("concurrent POST sets persist every override and converge the catalog", async () => {
  const handler = freshHandler();
  const token = await authToken(handler);
  const models = Array.from({ length: 12 }, (_, index) => `concurrent-api-model-${index}`);

  const responses = await Promise.all(models.map((model, index) => postPricing(handler, token, {
    action: "set",
    override: { model, ...BASE_RATES, input: index },
  })));
  for (const response of responses) assert.equal(response.statusCode, 200);

  const catalog = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=concurrent-api-model&limit=50",
  });
  assert.equal(catalog.json().override_count, models.length);
  assert.equal(catalog.json().total, models.length);
  assert.deepEqual(
    catalog.json().items.map((item) => item.model).sort(),
    [...models].sort(),
  );
  for (const [index, model] of models.entries()) {
    assert.equal(catalog.json().items.find((item) => item.model === model).input, index, model);
    assert.equal(ratesOfLive(model).input, index, model);
  }

  const store = JSON.parse(fs.readFileSync(pricingStorePath(), "utf8"));
  assert.equal(store.items.length, models.length);
});

test("concurrent POST mutations apply the committed snapshot without an out-of-lock re-read", async () => {
  const handler = freshHandler();
  const token = await authToken(handler);
  // Resolve the handler's startup override load before replacing the reader.
  await call(handler, { endpoint: "/functions/tokentracker-model-pricing?limit=1" });

  const models = ["snapshot-lock-model-a", "snapshot-lock-model-b"];
  const realList = overrides.listPricingOverrides;
  let listCalls = 0;
  // Reproduce the old race: the first post-write list read returns its snapshot
  // late, so an earlier request could apply stale state after a newer one.
  overrides.listPricingOverrides = async (args) => {
    listCalls += 1;
    const snapshot = await realList(args);
    if (listCalls === 1) await new Promise((resolve) => setTimeout(resolve, 150));
    return snapshot;
  };

  let setResponses = [];
  let deleteResponses = [];
  let afterSets;
  let afterDeletes;
  let liveAfterSets = [];
  try {
    setResponses = await Promise.all(models.map((model) => postPricing(handler, token, {
      action: "set",
      override: { model, ...BASE_RATES },
    })));
    afterSets = await call(handler, {
      endpoint: "/functions/tokentracker-model-pricing?q=snapshot-lock-model&limit=10",
    });
    liveAfterSets = models.map((model) => ratesOfLive(model).input);
    deleteResponses = await Promise.all(models.map((model) => postPricing(handler, token, {
      action: "delete",
      override: { model },
    })));
    afterDeletes = await call(handler, {
      endpoint: "/functions/tokentracker-model-pricing?q=snapshot-lock-model&limit=10",
    });
  } finally {
    overrides.listPricingOverrides = realList;
  }

  // Mutations apply the snapshot handed to onCommitted inside the file lock;
  // they must never re-read the store outside it.
  assert.equal(listCalls, 0, "set/delete must not call listPricingOverrides again");
  for (const response of setResponses) assert.equal(response.statusCode, 200);
  for (const response of deleteResponses) assert.equal(response.statusCode, 200);
  for (const response of deleteResponses) assert.equal(response.json().deleted, true);

  assert.equal(afterSets.json().override_count, 2);
  assert.equal(afterSets.json().total, 2);
  for (const [index, model] of models.entries()) {
    const item = findCatalogItem(afterSets.json(), model, null);
    assert.ok(item, model);
    assert.equal(item.origin, "custom", model);
    assert.equal(item.input, 1, model);
    assert.equal(liveAfterSets[index], 1, model);
  }

  assert.equal(afterDeletes.json().override_count, 0);
  assert.equal(afterDeletes.json().total, 0);
  for (const model of models) {
    assert.equal(ratesOfLive(model).input, 0, model);
  }
  assert.deepEqual(
    JSON.parse(fs.readFileSync(pricingStorePath(), "utf8")).items,
    [],
  );
});

test("POST set rejects invalid parameters without mutating the store", async () => {
  const handler = freshHandler();
  const token = await authToken(handler);
  const before = await call(handler, { endpoint: "/functions/tokentracker-model-pricing?limit=1" });
  const revisionBefore = before.json().revision;

  const cases = [
    [{ action: "set", override: { model: "x", input: 1, output: 2, cache_read: 0 } }, /cache_write/],
    [{ action: "set", override: { model: "", ...BASE_RATES } }, /model is required/],
    [{ action: "set", override: { model: "x", source: "bad source", ...BASE_RATES } }, /provider id/],
    [{ action: "set", override: { model: "x", ...BASE_RATES, input: -1 } }, /input must be a finite number/],
    [{ action: "set", override: "nope" }, /must be an object/],
    [{ action: "set", override: [] }, /must be an object/],
    [{ action: "delete", override: { model: 42 } }, /model must be a string/],
    [{ action: "delete", override: {} }, /model must be a string/],
    [{ action: "nope" }, /Unknown model-pricing action/],
    [{}, /Unknown model-pricing action/],
  ];

  for (const [body, pattern] of cases) {
    const res = await postPricing(handler, token, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    const payload = res.json();
    assert.equal(payload.ok, false);
    assert.match(payload.error, pattern, JSON.stringify(body));
  }

  const malformed = await postPricing(handler, token, "{not json");
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().ok, false);
  assert.equal(typeof malformed.json().error, "string");

  const after = await call(handler, { endpoint: "/functions/tokentracker-model-pricing?limit=1" });
  assert.equal(after.json().override_count, 0);
  assert.equal(after.json().revision, revisionBefore);
  assert.equal(fs.existsSync(pricingStorePath()), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST delete

test("POST delete removes one identity and restores fallback pricing", async () => {
  const handler = freshHandler();
  const token = await authToken(handler);

  const globalSet = await postPricing(handler, token, {
    action: "set",
    override: { model: "claude-sonnet-4-6", ...BASE_RATES, input: 9, output: 9 },
  });
  const sourceSet = await postPricing(handler, token, {
    action: "set",
    override: { model: "claude-sonnet-4-6", source: "claude", ...BASE_RATES },
  });
  assert.equal(sourceSet.json().revision, globalSet.json().revision + 1);

  const both = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=claude-sonnet-4-6",
  });
  assert.equal(both.json().override_count, 2);
  const globalItem = findCatalogItem(both.json(), "claude-sonnet-4-6", null);
  const sourceItem = findCatalogItem(both.json(), "claude-sonnet-4-6", "claude");
  assert.equal(globalItem.origin, "custom");
  assert.equal(globalItem.input, 9);
  assert.equal(sourceItem.origin, "custom");
  assert.equal(sourceItem.input, 1);

  const sourceDelete = await postPricing(handler, token, {
    action: "delete",
    override: { model: "claude-sonnet-4-6", source: "claude" },
  });
  assert.equal(sourceDelete.statusCode, 200);
  assert.equal(sourceDelete.json().ok, true);
  assert.equal(sourceDelete.json().deleted, true);
  assert.equal(sourceDelete.json().item.source, "claude");
  assert.equal(sourceDelete.json().revision, sourceSet.json().revision + 1);

  const globalOnly = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=claude-sonnet-4-6",
  });
  assert.equal(globalOnly.json().override_count, 1);
  assert.equal(findCatalogItem(globalOnly.json(), "claude-sonnet-4-6", null).pricing_source, "user:exact");
  assert.deepEqual(
    ratesOfLive("claude-sonnet-4-6", "claude"),
    { input: 9, output: 9, cache_read: 0.1, cache_write: 0.2 },
  );

  const globalDelete = await postPricing(handler, token, {
    action: "delete",
    override: { model: "claude-sonnet-4-6", source: null },
  });
  assert.equal(globalDelete.json().deleted, true);
  assert.equal(globalDelete.json().item.source, null);

  const fallback = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=claude-sonnet-4-6",
  });
  assert.equal(fallback.json().override_count, 0);
  const restored = findCatalogItem(fallback.json(), "claude-sonnet-4-6", null);
  assert.equal(restored.origin, "curated");
  assert.equal(restored.overridden, false);
  assert.equal(restored.pricing_source, "curated:exact");
  assert.equal(restored.input, 3);
  assert.equal(restored.output, 15);
  assert.deepEqual(
    ratesOfLive("claude-sonnet-4-6", "claude"),
    { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  );

  const repeated = await postPricing(handler, token, {
    action: "delete",
    override: { model: "claude-sonnet-4-6" },
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().ok, true);
  assert.equal(repeated.json().deleted, false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(pricingStorePath(), "utf8")).items,
    [],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats re-pricing

test("usage summary and model breakdown re-price after set and delete", async () => {
  writeQueue([{
    source: "claude",
    model: "claude-sonnet-4-6",
    hour_start: "2026-11-20T10:00:00.000Z",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 2_000_000,
    billable_total_tokens: 2_000_000,
    conversation_count: 1,
  }]);
  const handler = freshHandler();
  const token = await authToken(handler);

  const summaryEndpoint = "/functions/tokentracker-usage-summary?from=2026-11-20&to=2026-11-20&tz=UTC";
  const breakdownEndpoint =
    "/functions/tokentracker-usage-model-breakdown?from=2026-11-20&to=2026-11-20&tz=UTC";

  const beforeSummary = await call(handler, { endpoint: summaryEndpoint });
  assert.equal(beforeSummary.json().totals.total_cost_usd, "18.000000");

  const beforeBreakdown = await call(handler, { endpoint: breakdownEndpoint });
  const beforeModel = beforeBreakdown.json().sources
    .find((source) => source.source === "claude")
    .models.find((model) => model.model === "claude-sonnet-4-6");
  assert.equal(beforeModel.totals.total_cost_usd, "18.000000");
  assert.equal(beforeModel.pricing.status, "priced");
  assert.equal(beforeModel.pricing.source, "curated:exact");
  assert.equal(beforeModel.pricing.input, 3);
  assert.equal(beforeModel.pricing.output, 15);

  const set = await postPricing(handler, token, {
    action: "set",
    override: { model: "claude-sonnet-4-6", ...BASE_RATES },
  });
  assert.equal(set.statusCode, 200);

  const afterSummary = await call(handler, { endpoint: summaryEndpoint });
  assert.equal(afterSummary.json().totals.total_cost_usd, "3.000000");

  const afterBreakdown = await call(handler, { endpoint: breakdownEndpoint });
  assert.equal(afterBreakdown.json().sources.length, 1);
  const afterSource = afterBreakdown.json().sources[0];
  assert.equal(afterSource.totals.total_cost_usd, "3.000000");
  const afterModel = afterSource.models.find((model) => model.model === "claude-sonnet-4-6");
  assert.equal(afterModel.totals.total_cost_usd, "3.000000");
  assert.equal(afterModel.pricing.status, "priced");
  assert.equal(afterModel.pricing.source, "user:exact");
  assert.equal(afterModel.pricing.input, 1);
  assert.equal(afterModel.pricing.output, 2);
  assert.equal(afterModel.pricing.cache_read, 0.1);
  assert.equal(afterModel.pricing.cache_write, 0.2);

  const deleted = await postPricing(handler, token, {
    action: "delete",
    override: { model: "claude-sonnet-4-6" },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().deleted, true);

  const restoredSummary = await call(handler, { endpoint: summaryEndpoint });
  assert.equal(restoredSummary.json().totals.total_cost_usd, "18.000000");

  const restoredBreakdown = await call(handler, { endpoint: breakdownEndpoint });
  const restoredModel = restoredBreakdown.json().sources[0].models
    .find((model) => model.model === "claude-sonnet-4-6");
  assert.equal(restoredModel.totals.total_cost_usd, "18.000000");
  assert.equal(restoredModel.pricing.source, "curated:exact");
});

// ─────────────────────────────────────────────────────────────────────────────
// Catalog wiring through the API

test("GET catalog wires search, source, origin and pagination to user overrides", async () => {
  const handler = freshHandler();
  const token = await authToken(handler);

  const saved = [];
  for (const item of [
    { model: "api-fixture-mini", ...BASE_RATES },
    { model: "api-fixture-mini", source: "api-gateway", ...BASE_RATES, input: 2 },
    { model: "api-fixture-pro", ...BASE_RATES, input: 5 },
  ]) {
    const res = await postPricing(handler, token, { action: "set", override: item });
    assert.equal(res.statusCode, 200);
    saved.push(res.json());
  }
  const revision = saved.at(-1).revision;

  const all = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=api-fixture",
  });
  assert.equal(all.json().override_count, 3);
  assert.equal(all.json().total, 3);
  assert.equal(all.json().revision, revision);
  assert.deepEqual(
    all.json().items.map((item) => [item.model, item.source, item.origin, item.input]),
    [
      ["api-fixture-mini", null, "custom", 1],
      ["api-fixture-mini", "api-gateway", "custom", 2],
      ["api-fixture-pro", null, "custom", 5],
    ],
  );

  const pages = [];
  for (const offset of [0, 1, 2]) {
    const page = await call(handler, {
      endpoint: `/functions/tokentracker-model-pricing?q=api-fixture&limit=1&offset=${offset}`,
    });
    assert.equal(page.json().total, 3);
    assert.equal(page.json().items.length, 1);
    pages.push(page.json().items[0].source);
  }
  assert.deepEqual(pages, [null, "api-gateway", null]);

  const bySource = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=api-fixture&source=api-gateway",
  });
  assert.equal(bySource.json().total, 1);
  assert.equal(bySource.json().items[0].pricing_source, "user:source-exact");

  const customOnly = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=api-fixture&origin=custom",
  });
  assert.equal(customOnly.json().total, 3);
  const litellmOnly = await call(handler, {
    endpoint: "/functions/tokentracker-model-pricing?q=api-fixture&origin=litellm",
  });
  assert.equal(litellmOnly.json().total, 0);
});
