const fs = require("node:fs/promises");
const path = require("node:path");

const { readJsonStrict, writeFileAtomic, chmod600IfPossible, openLock } = require("../fs");

const STORE_FILE = "pricing-overrides.json";
const STORE_VERSION = 1;
const RATE_FIELDS = ["input", "output", "cache_read", "cache_write"];
const MAX_RATE = 1_000_000_000;

function resolvePricingOverridesPath(trackerDir) {
  return path.join(trackerDir, STORE_FILE);
}

function normalizeIdentity(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("pricing override must be an object");
  }
  if (typeof fields.model !== "string") throw new Error("model must be a string");
  const model = fields.model.trim();
  if (!model) throw new Error("model is required");
  if (model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) {
    throw new Error("model must be at most 256 characters and contain no control characters");
  }
  let source = null;
  if (fields.source !== null && fields.source !== undefined && fields.source !== "") {
    if (typeof fields.source !== "string") throw new Error("source must be a string");
    source = fields.source.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(source)) {
      throw new Error("source must be a valid provider id");
    }
  }
  return { model, source };
}

function normalizePricingOverride(fields) {
  const identity = normalizeIdentity(fields);
  const rates = {};
  for (const field of RATE_FIELDS) {
    const value = fields[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_RATE) {
      throw new Error(`${field} must be a finite number between 0 and ${MAX_RATE}`);
    }
    rates[field] = value;
  }
  return { ...identity, ...rates };
}

function isValidStoredRecord(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  try {
    normalizePricingOverride(item);
    return true;
  } catch {
    return false;
  }
}

async function readStore(filePath, { forWrite = false } = {}) {
  const { status, value, error } = await readJsonStrict(filePath);
  if (status === "missing") {
    return { store: { version: STORE_VERSION, items: [] }, needsBackup: false };
  }
  if (status === "error") {
    throw new Error(`Cannot read pricing overrides: ${error?.message || String(error)}`);
  }
  if (status === "invalid" || !value || typeof value !== "object" || Array.isArray(value)) {
    if (!forWrite) throw new Error("Pricing overrides are corrupted (invalid JSON)");
    return { store: { version: STORE_VERSION, items: [] }, needsBackup: true };
  }
  if (!Array.isArray(value.items)) {
    return {
      store: { version: STORE_VERSION, items: [] },
      needsBackup: value.items !== undefined,
    };
  }
  const items = [];
  let dropped = false;
  for (const item of value.items) {
    if (isValidStoredRecord(item)) items.push(item);
    else dropped = true;
  }
  return {
    store: {
      version: Number.isFinite(value.version) ? value.version : STORE_VERSION,
      items,
    },
    needsBackup: dropped,
  };
}

async function backupDamagedStore(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    await fs.copyFile(filePath, `${filePath}.corrupt-${stamp}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Cannot back up damaged pricing overrides: ${error?.message || String(error)}`);
    }
  }
}

async function writeStore(filePath, store) {
  await writeFileAtomic(filePath, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  await chmod600IfPossible(filePath);
}

const storeLocks = new Map();
async function acquireFileLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 30_000;
  while (true) {
    const lock = await openLock(lockPath, { quietIfLocked: true });
    if (lock) return lock;
    if (Date.now() >= deadline) throw new Error("Timed out waiting to update pricing overrides");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function withStoreLock(filePath, operation) {
  const previous = storeLocks.get(filePath) || Promise.resolve();
  const runExclusive = async () => {
    const lock = await acquireFileLock(filePath);
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  };
  const run = previous.then(runExclusive, runExclusive);
  storeLocks.set(filePath, run.then(() => undefined, () => undefined));
  return run;
}

function overrideKey(item) {
  return `${item.source || ""}\0${item.model.toLowerCase()}`;
}

async function listPricingOverrides({ trackerDir }) {
  const { store } = await readStore(resolvePricingOverridesPath(trackerDir));
  return [...store.items].sort((a, b) =>
    a.model.localeCompare(b.model) || String(a.source || "").localeCompare(String(b.source || "")),
  );
}

async function setPricingOverride({ trackerDir, fields, onCommitted }) {
  const normalized = normalizePricingOverride(fields);
  const filePath = resolvePricingOverridesPath(trackerDir);
  return withStoreLock(filePath, async () => {
    const { store, needsBackup } = await readStore(filePath, { forWrite: true });
    if (needsBackup) await backupDamagedStore(filePath);
    const now = new Date().toISOString();
    const index = store.items.findIndex((item) => overrideKey(item) === overrideKey(normalized));
    const record = {
      ...normalized,
      createdAt: index >= 0 ? store.items[index].createdAt || now : now,
      updatedAt: now,
    };
    if (index >= 0) store.items[index] = record;
    else store.items.push(record);
    await writeStore(filePath, store);
    if (onCommitted) await onCommitted(store.items);
    return record;
  });
}

async function deletePricingOverride({ trackerDir, fields, onCommitted }) {
  const identity = normalizeIdentity(fields);
  const filePath = resolvePricingOverridesPath(trackerDir);
  return withStoreLock(filePath, async () => {
    const { store, needsBackup } = await readStore(filePath, { forWrite: true });
    if (needsBackup) await backupDamagedStore(filePath);
    const index = store.items.findIndex((item) => overrideKey(item) === overrideKey(identity));
    if (index < 0) return { deleted: false };
    const [item] = store.items.splice(index, 1);
    await writeStore(filePath, store);
    if (onCommitted) await onCommitted(store.items);
    return { deleted: true, item };
  });
}

module.exports = {
  RATE_FIELDS,
  resolvePricingOverridesPath,
  normalizePricingOverride,
  listPricingOverrides,
  setPricingOverride,
  deletePricingOverride,
};
