"use strict";

// User model-price overrides: validation, persistence, corruption handling,
// concurrency, lookup precedence, revision/cache invalidation, custom gateway
// pricing and catalog search/pagination.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const overrides = require("../src/lib/pricing/overrides");
const pricing = require("../src/lib/pricing");

const BASE_RATES = { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 };
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Child script for the cross-process lock regression. It signals readiness,
// waits for the parent's start file, then writes one override. `node -e`
// exposes the first post-script argument as process.argv[1].
const WRITER_SCRIPT = `
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const overrides = require(process.argv[1]);
const trackerDir = process.argv[2];
const model = process.argv[3];
const startPath = process.argv[4];
const readyPath = process.argv[5];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Simulate a slow store read. With only an in-process lock both children read
// the same snapshot before either writes; the file lock must serialize them.
const realReadFile = fsp.readFile;
fsp.readFile = async (...args) => {
  const value = await realReadFile(...args);
  if (String(args[0]).endsWith("pricing-overrides.json")) await delay(40);
  return value;
};
(async () => {
  fs.writeFileSync(readyPath, "1");
  while (!fs.existsSync(startPath)) await delay(5);
  await overrides.setPricingOverride({
    trackerDir,
    fields: { model, input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
  });
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;

async function withTrackerDir(fn) {
  const trackerDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-pricing-overrides-"));
  try {
    return await fn(trackerDir);
  } finally {
    await fsp.rm(trackerDir, { recursive: true, force: true });
  }
}

function storePath(trackerDir) {
  return overrides.resolvePricingOverridesPath(trackerDir);
}

async function readStoreFile(trackerDir) {
  return JSON.parse(await fsp.readFile(storePath(trackerDir), "utf8"));
}

async function corruptBackups(trackerDir) {
  const files = await fsp.readdir(trackerDir);
  return files.filter((name) => name.startsWith("pricing-overrides.json.corrupt-"));
}

async function assertNoTempFiles(trackerDir) {
  const files = await fsp.readdir(trackerDir);
  assert.deepEqual(files.filter((name) => name.includes(".tmp")), []);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const found = await fsp.access(filePath).then(() => true, () => false);
    if (found) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await sleep(10);
  }
}

function spawnPricingWriter({ overridesPath, trackerDir, model, startPath, readyPath }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "-e",
      WRITER_SCRIPT,
      overridesPath,
      trackerDir,
      model,
      startPath,
      readyPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, error, stdout, stderr }));
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function ratesOf(model, opts) {
  const value = pricing.getModelPricing(model, opts);
  return {
    input: value.input,
    output: value.output,
    cache_read: value.cache_read,
    cache_write: value.cache_write,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence and validation

test("setPricingOverride persists a versioned store and lists the normalized record", async () => {
  await withTrackerDir(async (trackerDir) => {
    const record = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "  claude-sonnet-4-6  ", source: "  CLAUDE ", ...BASE_RATES },
    });

    assert.equal(record.model, "claude-sonnet-4-6");
    assert.equal(record.source, "claude");
    assert.equal(record.input, 1);
    assert.equal(record.output, 2);
    assert.equal(record.cache_read, 0.1);
    assert.equal(record.cache_write, 0.2);
    assert.match(record.createdAt, ISO_TIMESTAMP);
    assert.equal(record.updatedAt, record.createdAt);

    const store = await readStoreFile(trackerDir);
    assert.equal(store.version, 1);
    assert.equal(store.items.length, 1);
    assert.deepEqual(store.items[0], record);
    assert.deepEqual(await overrides.listPricingOverrides({ trackerDir }), [record]);
    await assertNoTempFiles(trackerDir);

    if (process.platform !== "win32") {
      assert.equal((await fsp.stat(storePath(trackerDir))).mode & 0o777, 0o600);
    }
  });
});

test("setPricingOverride updates in place and preserves createdAt", async () => {
  await withTrackerDir(async (trackerDir) => {
    const first = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "claude-sonnet-4-6", ...BASE_RATES },
    });
    // Ensure the second write can land on a later millisecond.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "claude-sonnet-4-6", ...BASE_RATES, output: 9 },
    });

    assert.equal(second.createdAt, first.createdAt);
    assert.ok(Date.parse(second.updatedAt) >= Date.parse(first.updatedAt));
    const listed = await overrides.listPricingOverrides({ trackerDir });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].output, 9);
    assert.equal((await readStoreFile(trackerDir)).items.length, 1);
  });
});

test("a missing store lists empty and delete reports a miss without creating the file", async () => {
  await withTrackerDir(async (trackerDir) => {
    assert.deepEqual(await overrides.listPricingOverrides({ trackerDir }), []);
    assert.deepEqual(
      await overrides.deletePricingOverride({ trackerDir, fields: { model: "no-such-model" } }),
      { deleted: false },
    );
    await assert.rejects(fsp.access(storePath(trackerDir)), /ENOENT/);
  });
});

test("setPricingOverride rejects invalid identities before touching disk", async () => {
  await withTrackerDir(async (trackerDir) => {
    const cases = [
      [null, /must be an object/],
      [[], /must be an object/],
      ["not-an-object", /must be an object/],
      [{}, /model must be a string/],
      [{ model: 7 }, /model must be a string/],
      [{ model: "   " }, /model is required/],
      [{ model: "a".repeat(257) }, /at most 256/],
      [{ model: "bad\u0000name" }, /control characters/],
      [{ model: "ok", source: 5 }, /source must be a string/],
      [{ model: "ok", source: "-nope" }, /valid provider id/],
      [{ model: "ok", source: "bad source" }, /valid provider id/],
      [{ model: "ok", source: "a".repeat(65) }, /valid provider id/],
      // Only an empty string/null/undefined means "global"; whitespace is
      // rejected rather than silently trimmed into the global namespace.
      [{ model: "ok", source: "   " }, /valid provider id/],
    ];

    for (const [fields, pattern] of cases) {
      await assert.rejects(
        overrides.setPricingOverride({ trackerDir, fields }),
        pattern,
      );
    }

    assert.deepEqual(await overrides.listPricingOverrides({ trackerDir }), []);
    await assert.rejects(fsp.access(storePath(trackerDir)), /ENOENT/);

    // An empty source is normalized to a global override, not rejected.
    const global = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "ok", source: "", ...BASE_RATES },
    });
    assert.equal(global.source, null);
  });
});

test("setPricingOverride rejects every non-finite or out-of-range rate", async () => {
  await withTrackerDir(async (trackerDir) => {
    const invalidValues = [undefined, "1", NaN, Infinity, -Infinity, -0.01, 1_000_000_001];
    for (const field of overrides.RATE_FIELDS) {
      for (const value of invalidValues) {
        const fields = { model: "rate-test", ...BASE_RATES, [field]: value };
        await assert.rejects(
          overrides.setPricingOverride({ trackerDir, fields }),
          new RegExp(`${field} must be a finite number`),
          `${field}=${String(value)}`,
        );
      }
    }
    assert.deepEqual(await overrides.listPricingOverrides({ trackerDir }), []);

    const max = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "max-rate", ...BASE_RATES, input: 1_000_000_000 },
    });
    assert.equal(max.input, 1_000_000_000);
  });
});

test("identity matching is case-insensitive and source-scoped records stay separate", async () => {
  await withTrackerDir(async (trackerDir) => {
    await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "Model-X", source: "GW-1", ...BASE_RATES },
    });
    await overrides.setPricingOverride({
      trackerDir,
      fields: { model: " model-x ", source: "gw-1", ...BASE_RATES, output: 7 },
    });
    await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "model-x", ...BASE_RATES, output: 3 },
    });

    const listed = await overrides.listPricingOverrides({ trackerDir });
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((item) => [item.model, item.source, item.output]),
      [["model-x", null, 3], ["model-x", "gw-1", 7]],
    );
  });
});

test("deletePricingOverride removes only the matching identity", async () => {
  await withTrackerDir(async (trackerDir) => {
    await overrides.setPricingOverride({ trackerDir, fields: { model: "M", ...BASE_RATES } });
    await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "M", source: "claude", ...BASE_RATES },
    });
    await overrides.setPricingOverride({ trackerDir, fields: { model: "N", ...BASE_RATES } });

    const sourceDelete = await overrides.deletePricingOverride({
      trackerDir,
      fields: { model: "m", source: "CLAUDE" },
    });
    assert.equal(sourceDelete.deleted, true);
    assert.equal(sourceDelete.item.source, "claude");
    assert.equal((await overrides.listPricingOverrides({ trackerDir })).length, 2);

    assert.deepEqual(
      await overrides.deletePricingOverride({ trackerDir, fields: { model: "m", source: "claude" } }),
      { deleted: false },
    );

    const globalDelete = await overrides.deletePricingOverride({
      trackerDir,
      fields: { model: "M" },
    });
    assert.equal(globalDelete.deleted, true);
    assert.equal(globalDelete.item.source, null);

    const remaining = await overrides.listPricingOverrides({ trackerDir });
    assert.deepEqual(remaining.map((item) => item.model), ["N"]);

    await assert.rejects(
      overrides.deletePricingOverride({ trackerDir, fields: {} }),
      /model must be a string/,
    );
    await assert.rejects(
      overrides.deletePricingOverride({ trackerDir, fields: { model: "M", source: "bad source" } }),
      /valid provider id/,
    );
  });
});

test("onCommitted receives the persisted snapshot while the store lock is held", async () => {
  await withTrackerDir(async (trackerDir) => {
    const lockPath = `${storePath(trackerDir)}.lock`;
    const snapshots = [];
    const onCommitted = async (items) => {
      // The callback runs inside the store transaction, so the exclusive lock
      // must still exist and the file must already hold this exact snapshot.
      await fsp.access(lockPath);
      assert.deepEqual(items, (await readStoreFile(trackerDir)).items);
      snapshots.push(items.map((item) => item.model));
    };

    const first = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "callback-a", ...BASE_RATES },
      onCommitted,
    });
    assert.equal(first.model, "callback-a");
    assert.deepEqual(snapshots, [["callback-a"]]);

    const second = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "callback-b", ...BASE_RATES },
      onCommitted,
    });
    assert.equal(second.model, "callback-b");
    assert.deepEqual(snapshots[1], ["callback-a", "callback-b"]);

    const deletion = await overrides.deletePricingOverride({
      trackerDir,
      fields: { model: "callback-a" },
      onCommitted,
    });
    assert.equal(deletion.deleted, true);
    assert.deepEqual(snapshots[2], ["callback-b"]);

    // A delete miss is a no-op and must not invoke the commit callback.
    const miss = await overrides.deletePricingOverride({
      trackerDir,
      fields: { model: "callback-missing" },
      onCommitted: () => {
        throw new Error("onCommitted must not run for a delete miss");
      },
    });
    assert.deepEqual(miss, { deleted: false });
    assert.equal(snapshots.length, 3);
    assert.deepEqual(
      (await readStoreFile(trackerDir)).items.map((item) => item.model),
      ["callback-b"],
    );

    // The file lock is released after every committed transaction.
    await assert.rejects(fsp.access(lockPath), /ENOENT/);
  });
});

test("listPricingOverrides sorts by model and then source", async () => {
  await withTrackerDir(async (trackerDir) => {
    for (const [model, source] of [["b", null], ["a", "z"], ["a", null], ["a", "c"]]) {
      await overrides.setPricingOverride({
        trackerDir,
        fields: { model, ...(source ? { source } : {}), ...BASE_RATES },
      });
    }
    const listed = await overrides.listPricingOverrides({ trackerDir });
    assert.deepEqual(
      listed.map((item) => [item.model, item.source]),
      [["a", null], ["a", "c"], ["a", "z"], ["b", null]],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent writes

test("concurrent setPricingOverride calls persist every distinct model", async () => {
  await withTrackerDir(async (trackerDir) => {
    const inputs = Array.from({ length: 30 }, (_, index) => index);
    await Promise.all(inputs.map((index) => overrides.setPricingOverride({
      trackerDir,
      fields: {
        model: `concurrent-${String(index).padStart(2, "0")}`,
        ...BASE_RATES,
        input: index,
      },
    })));

    const listed = await overrides.listPricingOverrides({ trackerDir });
    assert.equal(listed.length, inputs.length);
    for (const index of inputs) {
      const found = listed.find((item) => item.model === `concurrent-${String(index).padStart(2, "0")}`);
      assert.ok(found, `missing concurrent-${index}`);
      assert.equal(found.input, index);
    }
    assert.equal((await readStoreFile(trackerDir)).version, 1);
    await assertNoTempFiles(trackerDir);
  });
});

test("concurrent updates to one identity leave exactly one record", async () => {
  await withTrackerDir(async (trackerDir) => {
    const inputs = Array.from({ length: 25 }, (_, index) => index);
    await Promise.all(inputs.map((input) => overrides.setPricingOverride({
      trackerDir,
      fields: { model: "same-model", ...BASE_RATES, input },
    })));

    const listed = await overrides.listPricingOverrides({ trackerDir });
    assert.equal(listed.length, 1);
    // withStoreLock chains operations in call order, so the last call wins.
    assert.equal(listed[0].input, inputs.at(-1));
    assert.equal((await readStoreFile(trackerDir)).items.length, 1);
    await assertNoTempFiles(trackerDir);
  });
});

test("concurrent writes over a damaged store create exactly one backup", async () => {
  await withTrackerDir(async (trackerDir) => {
    await fsp.writeFile(storePath(trackerDir), "{not json", "utf8");
    await Promise.all([
      overrides.setPricingOverride({ trackerDir, fields: { model: "a", ...BASE_RATES } }),
      overrides.setPricingOverride({ trackerDir, fields: { model: "b", ...BASE_RATES } }),
    ]);

    const listed = await overrides.listPricingOverrides({ trackerDir });
    assert.deepEqual(listed.map((item) => item.model), ["a", "b"]);
    const backups = await corruptBackups(trackerDir);
    assert.equal(backups.length, 1);
    assert.equal(await fsp.readFile(path.join(trackerDir, backups[0]), "utf8"), "{not json");
  });
});

test("withStoreLock serializes writers in separate processes", { timeout: 30_000 }, async () => {
  await withTrackerDir(async (trackerDir) => {
    // A large initial store widens the old read-modify-write window: without a
    // cross-process lock both children read the same 800 rows and the later
    // writer erased the earlier one's new model.
    const initialItems = Array.from({ length: 800 }, (_, index) => ({
      model: `base-${index}`,
      ...BASE_RATES,
    }));
    await fsp.writeFile(
      storePath(trackerDir),
      JSON.stringify({ version: 1, items: initialItems }) + "\n",
      "utf8",
    );

    const startPath = path.join(trackerDir, "cross-process.start");
    const readyA = `${startPath}.a`;
    const readyB = `${startPath}.b`;
    const overridesPath = require.resolve("../src/lib/pricing/overrides");
    const childA = spawnPricingWriter({
      overridesPath,
      trackerDir,
      model: "cross-process-a",
      startPath,
      readyPath: readyA,
    });
    const childB = spawnPricingWriter({
      overridesPath,
      trackerDir,
      model: "cross-process-b",
      startPath,
      readyPath: readyB,
    });

    // Both children are running and waiting at the barrier before either is
    // allowed to enter setPricingOverride.
    await Promise.all([waitForFile(readyA), waitForFile(readyB)]);
    await fsp.writeFile(startPath, "1", "utf8");

    const [resultA, resultB] = await Promise.all([childA, childB]);
    assert.equal(
      resultA.code,
      0,
      `cross-process-a failed (${resultA.code}): ${resultA.stderr || resultA.stdout}`,
    );
    assert.equal(
      resultB.code,
      0,
      `cross-process-b failed (${resultB.code}): ${resultB.stderr || resultB.stdout}`,
    );

    const store = await readStoreFile(trackerDir);
    assert.equal(store.items.length, initialItems.length + 2);
    assert.deepEqual(
      store.items
        .map((item) => item.model)
        .filter((model) => model.startsWith("cross-process-"))
        .sort(),
      ["cross-process-a", "cross-process-b"],
    );

    // Every acquired lease and heartbeat must be gone once both writers exit.
    const lockLeftovers = (await fsp.readdir(trackerDir)).filter((name) =>
      name.includes(".lock") || name.includes(".reclaim") || name.includes(".stale.")
    );
    assert.deepEqual(lockLeftovers, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Corrupted stores

test("listPricingOverrides reports a corrupted store instead of an empty list", async () => {
  await withTrackerDir(async (trackerDir) => {
    for (const contents of ["{not json", "[]", "null", "\"text\"", "42"]) {
      await fsp.writeFile(storePath(trackerDir), contents, "utf8");
      await assert.rejects(
        overrides.listPricingOverrides({ trackerDir }),
        /corrupted/,
        contents,
      );
    }
  });
});

test("a write over an invalid-JSON store backs up the original before replacing it", async () => {
  await withTrackerDir(async (trackerDir) => {
    await fsp.writeFile(storePath(trackerDir), "{not json", "utf8");
    const created = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "claude-sonnet-4-6", ...BASE_RATES },
    });

    const backups = await corruptBackups(trackerDir);
    assert.equal(backups.length, 1);
    assert.equal(await fsp.readFile(path.join(trackerDir, backups[0]), "utf8"), "{not json");

    assert.deepEqual(await overrides.listPricingOverrides({ trackerDir }), [created]);
  });
});

test("invalid stored records are dropped and the damaged store is backed up", async () => {
  await withTrackerDir(async (trackerDir) => {
    const valid = { model: "valid-model", ...BASE_RATES };
    await fsp.writeFile(storePath(trackerDir), JSON.stringify({
      version: 1,
      items: [
        valid,
        { model: "missing-output", input: 1, output: 2, cache_read: 0 },
        { model: "negative", ...BASE_RATES, input: -1 },
        null,
        [],
        "text",
      ],
    }), "utf8");

    // Read-only listing keeps the healthy record and never throws.
    assert.deepEqual(await overrides.listPricingOverrides({ trackerDir }), [valid]);

    const created = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "new-model", ...BASE_RATES },
    });
    assert.equal((await corruptBackups(trackerDir)).length, 1);

    const store = await readStoreFile(trackerDir);
    assert.equal(store.version, 1);
    assert.deepEqual(store.items.map((item) => item.model), ["valid-model", "new-model"]);
    assert.deepEqual(store.items[1], created);
  });
});

test("a non-array items field is rebuilt after a backup", async () => {
  await withTrackerDir(async (trackerDir) => {
    await fsp.writeFile(
      storePath(trackerDir),
      JSON.stringify({ version: 9, items: { model: "not-an-array" } }),
      "utf8",
    );
    assert.deepEqual(await overrides.listPricingOverrides({ trackerDir }), []);

    const created = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "rebuilt", ...BASE_RATES },
    });
    assert.equal((await corruptBackups(trackerDir)).length, 1);
    const store = await readStoreFile(trackerDir);
    assert.equal(store.version, 1);
    assert.deepEqual(store.items, [created]);
  });
});

test("a failed replacement keeps the damaged store at its canonical path", async () => {
  await withTrackerDir(async (trackerDir) => {
    const realWriteFile = fsp.writeFile;
    try {
      await fsp.writeFile(storePath(trackerDir), "{not json", "utf8");
      fsp.writeFile = async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      };
      await assert.rejects(
        overrides.setPricingOverride({
          trackerDir,
          fields: { model: "claude-sonnet-4-6", ...BASE_RATES },
        }),
        /disk full/,
      );
    } finally {
      fsp.writeFile = realWriteFile;
    }

    // The damaged original survives so a retry never starts from "missing".
    assert.equal(await fsp.readFile(storePath(trackerDir), "utf8"), "{not json");
    assert.equal((await corruptBackups(trackerDir)).length, 1);
    await assertNoTempFiles(trackerDir);

    const created = await overrides.setPricingOverride({
      trackerDir,
      fields: { model: "claude-sonnet-4-6", ...BASE_RATES },
    });
    assert.deepEqual(await overrides.listPricingOverrides({ trackerDir }), [created]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lookup precedence and live pricing state

test("a user global override wins over curated pricing for every source", () => {
  pricing.resetPricingForTests();
  assert.deepEqual(
    ratesOf("claude-sonnet-4-6"),
    { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  );
  // A curated source-exact entry (AStudio/iFlytek MaaS) normally prices only
  // its own source; an explicit user price still outranks it.
  assert.deepEqual(
    ratesOf("xopglm52", { source: "acode" }),
    { input: 1.11, output: 3.89, cache_read: 0.28, cache_write: 1.11 },
  );

  const applied = pricing.applyUserPricingOverrides([
    { model: "claude-sonnet-4-6", ...BASE_RATES },
    { model: "xopglm52", ...BASE_RATES },
  ]);
  assert.equal(applied.length, 2);

  for (const source of [undefined, "claude", "cursor", "CLAUDE"]) {
    const opts = source === undefined ? undefined : { source };
    assert.deepEqual(
      ratesOf("claude-sonnet-4-6", opts),
      { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
      source || "no-source",
    );
    const info = pricing.getModelPricingInfo("claude-sonnet-4-6", opts || {});
    assert.equal(info.status, "priced", source || "no-source");
    assert.equal(info.source, "user:exact", source || "no-source");
  }
  assert.deepEqual(
    ratesOf("xopglm52", { source: "acode" }),
    { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
  );
});

test("a source override outranks a global override and only applies to its source", () => {
  pricing.resetPricingForTests();
  pricing.applyUserPricingOverrides([
    { model: "claude-sonnet-4-6", ...BASE_RATES, input: 9, output: 9 },
    { model: "claude-sonnet-4-6", source: "claude", ...BASE_RATES },
  ]);

  assert.deepEqual(
    ratesOf("claude-sonnet-4-6", { source: "claude" }),
    { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
  );
  assert.deepEqual(
    ratesOf("claude-sonnet-4-6", { source: "cursor" }),
    { input: 9, output: 9, cache_read: 0.1, cache_write: 0.2 },
  );
  assert.equal(pricing.getModelPricingInfo("claude-sonnet-4-6", { source: "claude" }).source, "user:source-exact");
  assert.equal(pricing.getModelPricingInfo("claude-sonnet-4-6", { source: "cursor" }).source, "user:exact");
});

test("a source-only override leaves other sources on their curated rate", () => {
  pricing.resetPricingForTests();
  pricing.applyUserPricingOverrides([
    { model: "claude-sonnet-4-6", source: "claude", ...BASE_RATES },
  ]);

  assert.deepEqual(
    ratesOf("claude-sonnet-4-6", { source: "claude" }),
    { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
  );
  assert.deepEqual(
    ratesOf("claude-sonnet-4-6", { source: "cursor" }),
    { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  );
  assert.equal(pricing.getModelPricingInfo("claude-sonnet-4-6", { source: "cursor" }).source, "curated:exact");
});

test("user overrides beat free and unpriced guards", () => {
  pricing.resetPricingForTests();
  assert.equal(pricing.getModelPricingInfo("minimax-m2.5-free").status, "free");
  assert.equal(pricing.getModelPricingInfo("auto", { source: "acode" }).status, "unpriced");

  pricing.applyUserPricingOverrides([
    { model: "minimax-m2.5-free", ...BASE_RATES },
    { model: "auto", source: "acode", ...BASE_RATES },
  ]);

  const freeInfo = pricing.getModelPricingInfo("minimax-m2.5-free");
  assert.equal(freeInfo.status, "priced");
  assert.equal(freeInfo.source, "user:exact");
  assert.equal(pricing.computeRowCost({
    source: "muse",
    model: "minimax-m2.5-free",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  }), 3);

  const routerInfo = pricing.getModelPricingInfo("auto", { source: "acode" });
  assert.equal(routerInfo.status, "priced");
  assert.equal(routerInfo.source, "user:source-exact");
  assert.equal(pricing.computeRowCost({
    source: "acode",
    model: "auto",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  }), 3);
});

test("applying overrides clears the negative cache", () => {
  pricing.resetPricingForTests();
  const state = pricing.__getStateForTests();
  assert.equal(pricing.getModelPricing("user-defined-model-xyz").input, 0);
  assert.ok(state.negativeCache.has("user-defined-model-xyz"));

  pricing.applyUserPricingOverrides([{ model: "user-defined-model-xyz", ...BASE_RATES }]);
  assert.equal(state.negativeCache.size, 0);
  assert.deepEqual(
    ratesOf("user-defined-model-xyz"),
    { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
  );
});

test("zero-rate overrides are explicit free prices, not missing values", () => {
  pricing.resetPricingForTests();
  pricing.applyUserPricingOverrides([
    { model: "claude-sonnet-4-6", input: 0, output: 0, cache_read: 0, cache_write: 0 },
  ]);

  assert.deepEqual(
    ratesOf("claude-sonnet-4-6"),
    { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  );
  const info = pricing.getModelPricingInfo("claude-sonnet-4-6");
  assert.equal(info.status, "free");
  assert.equal(info.source, "user:exact");
  assert.equal(pricing.computeRowCost({
    source: "claude",
    model: "claude-sonnet-4-6",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  }), 0);
});

test("user overrides survive a pricing data reload and its revision bump", async () => {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-pricing-reload-"));
  try {
    pricing.resetPricingForTests();
    pricing.applyUserPricingOverrides([{ model: "claude-sonnet-4-6", ...BASE_RATES }]);
    const revisionBefore = pricing.getPricingRevision();

    const state = await pricing.ensurePricingLoaded({
      cachePath: path.join(cacheDir, "pricing.json"),
      fetchImpl: async () => ({}),
    });

    assert.equal(state.loaded, true);
    assert.equal(state.source, "upstream");
    assert.equal(pricing.getPricingRevision(), revisionBefore + 1);
    assert.deepEqual(
      ratesOf("claude-sonnet-4-6"),
      { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
    );
    // The reload clears the info cache, so the fresh revision must still
    // report the user override rather than curated pricing.
    const info = pricing.getModelPricingInfo("claude-sonnet-4-6");
    assert.equal(info.status, "priced");
    assert.equal(info.source, "user:exact");
  } finally {
    await fsp.rm(cacheDir, { recursive: true, force: true });
  }
});

test("revision bumps invalidate the pricing-info cache in both directions", () => {
  pricing.resetPricingForTests();
  const state = pricing.__getStateForTests();
  const revisionBefore = pricing.getPricingRevision();

  const initial = pricing.getModelPricingInfo("claude-sonnet-4-6");
  assert.equal(initial.input, 3);
  assert.equal(initial.output, 15);
  assert.equal(initial.source, "curated:exact");

  pricing.applyUserPricingOverrides([{ model: "claude-sonnet-4-6", ...BASE_RATES }]);
  assert.equal(pricing.getPricingRevision(), revisionBefore + 1);
  assert.equal(state.userOverrideItems.length, 1);

  const overridden = pricing.getModelPricingInfo("claude-sonnet-4-6");
  assert.equal(overridden.input, 1);
  assert.equal(overridden.output, 2);
  assert.equal(overridden.source, "user:exact");

  pricing.applyUserPricingOverrides([]);
  assert.equal(pricing.getPricingRevision(), revisionBefore + 2);
  assert.equal(state.userOverrideItems.length, 0);
  const restored = pricing.getModelPricingInfo("claude-sonnet-4-6");
  assert.equal(restored.input, 3);
  assert.equal(restored.output, 15);
  assert.equal(restored.source, "curated:exact");

  const revision = pricing.getPricingRevision();
  assert.throws(() => pricing.applyUserPricingOverrides("not-an-array"), /must be an array/);
  assert.throws(
    () => pricing.applyUserPricingOverrides([{ model: "incomplete", input: 1 }]),
    /output must be a finite number/,
  );
  assert.equal(pricing.getPricingRevision(), revision);
  assert.equal(state.userOverrideItems.length, 0);
});

test("overrides preserve curated speed-tier multipliers and tier allocation", () => {
  pricing.resetPricingForTests();
  assert.equal(pricing.getModelPricing("gpt-6.2-sol").priority_multiplier, 2);

  pricing.applyUserPricingOverrides([
    { model: "gpt-6.2-sol", input: 4, output: 20, cache_read: 0.2, cache_write: 0.4 },
  ]);

  const value = pricing.getModelPricing("gpt-6.2-sol");
  assert.equal(value.input, 4);
  assert.equal(value.output, 20);
  assert.equal(value.cache_read, 0.2);
  assert.equal(value.cache_write, 0.4);
  assert.equal(value.priority_multiplier, 2);
  assert.ok(Number(value.ultrafast_multiplier) >= 3);
  assert.equal(pricing.getModelPricingInfo("gpt-6.2-sol").priority_multiplier, 2);

  const row = {
    source: "codex",
    model: "gpt-6.2-sol",
    input_tokens: 1_000_000,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    priority_input_tokens: 1_000_000,
  };
  // 1M input at $4 = $4 standard plus a 2x Fast premium on the same subset.
  assert.equal(pricing.computeRowCost(row), 8);
  assert.deepEqual(pricing.computeRowTierCosts(row), {
    standard: 0,
    priority: 8,
    ultrafast: 0,
  });
});

test("custom gateway rows stay unpriced until an override prices them", () => {
  pricing.resetPricingForTests();
  const row = {
    source: "claude",
    model: "private-gateway-model",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    total_tokens: 2_000_000,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    backend_usage: [{
      backend: "custom",
      backend_origin: "https://gateway.example",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      total_tokens: 2_000_000,
    }],
  };

  assert.equal(pricing.getModelPricingInfo("private-gateway-model", row).status, "unpriced");
  assert.equal(pricing.computeRowCost(row), 0);

  pricing.applyUserPricingOverrides([
    { model: "private-gateway-model", source: "claude", ...BASE_RATES, output: 4 },
  ]);

  const info = pricing.getModelPricingInfo("private-gateway-model", row);
  assert.equal(info.status, "priced");
  assert.equal(info.source, "user:source-exact");
  assert.deepEqual(
    { input: info.input, output: info.output, cache_read: info.cache_read, cache_write: info.cache_write },
    { input: 1, output: 4, cache_read: 0.1, cache_write: 0.2 },
  );
  assert.equal(pricing.computeRowCost(row), 5);
});

// ─────────────────────────────────────────────────────────────────────────────
// Catalog search and pagination

test("listPricingCatalog paginates, filters, and reports custom origins", () => {
  pricing.resetPricingForTests();
  pricing.applyUserPricingOverrides([
    { model: "acme-private-mini", ...BASE_RATES },
    { model: "acme-private-mini", source: "my-gateway", ...BASE_RATES, input: 2 },
    { model: "acme-private-pro", ...BASE_RATES, input: 5 },
  ]);

  const all = pricing.listPricingCatalog({ q: "acme-private" });
  assert.equal(all.override_count, 3);
  assert.equal(all.total, 3);
  assert.equal(all.limit, 100);
  assert.equal(all.offset, 0);
  assert.equal(all.loaded, false);
  assert.equal(all.pricing_source, "seed-snapshot:sync");
  assert.equal(typeof all.revision, "number");
  assert.deepEqual(
    all.items.map((item) => [item.model, item.source, item.origin, item.pricing_source, item.input]),
    [
      ["acme-private-mini", null, "custom", "user:exact", 1],
      ["acme-private-mini", "my-gateway", "custom", "user:source-exact", 2],
      ["acme-private-pro", null, "custom", "user:exact", 5],
    ],
  );
  for (const item of all.items) {
    assert.equal(item.overridden, true);
    assert.equal(item.status, "priced");
  }

  const firstPage = pricing.listPricingCatalog({ q: "acme-private", limit: 1 });
  const secondPage = pricing.listPricingCatalog({ q: "acme-private", limit: 1, offset: 1 });
  const thirdPage = pricing.listPricingCatalog({ q: "acme-private", limit: 1, offset: 2 });
  assert.equal(firstPage.items.length, 1);
  assert.equal(secondPage.items.length, 1);
  assert.equal(thirdPage.items.length, 1);
  assert.deepEqual(
    [firstPage.items[0], secondPage.items[0], thirdPage.items[0]].map((item) => item.source),
    [null, "my-gateway", null],
  );
  assert.equal(firstPage.total, 3);
  assert.equal(pricing.listPricingCatalog({ q: "acme-private", offset: 99 }).items.length, 0);

  const sourceFiltered = pricing.listPricingCatalog({ q: "acme-private", source: "my-gateway" });
  assert.equal(sourceFiltered.total, 1);
  assert.equal(sourceFiltered.items[0].source, "my-gateway");
  assert.equal(sourceFiltered.items[0].pricing_source, "user:source-exact");

  const searchByProvider = pricing.listPricingCatalog({ q: "my-gateway" });
  assert.equal(searchByProvider.total, 1);
  assert.equal(searchByProvider.items[0].model, "acme-private-mini");

  assert.equal(pricing.listPricingCatalog({ q: "acme-private", origin: "custom" }).total, 3);
  assert.equal(pricing.listPricingCatalog({ q: "acme-private", origin: "litellm" }).total, 0);

  // Limits clamp to 1..200 and offsets/limits are truncated and defaulted.
  assert.equal(pricing.listPricingCatalog({ q: "acme-private", limit: 0 }).limit, 1);
  assert.equal(pricing.listPricingCatalog({ q: "acme-private", limit: 1_000 }).limit, 200);
  assert.equal(pricing.listPricingCatalog({ q: "acme-private", limit: 2.9 }).limit, 2);
  assert.equal(pricing.listPricingCatalog({ q: "acme-private", limit: "abc" }).limit, 100);
  assert.equal(pricing.listPricingCatalog({ q: "acme-private", offset: -3 }).offset, 0);
});

test("listPricingCatalog resolves curated and LiteLLM origins without an override", () => {
  pricing.resetPricingForTests();
  const curated = pricing.listPricingCatalog({ q: "kiro-cli-agent" });
  assert.equal(curated.total, 1);
  assert.equal(curated.items[0].origin, "curated");
  assert.equal(curated.items[0].overridden, false);
  assert.equal(curated.items[0].pricing_source, "curated:exact");
  assert.equal(curated.items[0].input, 3);
  assert.equal(curated.items[0].output, 15);

  const litellm = pricing.listPricingCatalog({ q: "gpt-4o", origin: "litellm" });
  assert.ok(litellm.total > 0);
  assert.ok(litellm.items.every((item) => item.origin === "litellm"));
  assert.equal(pricing.listPricingCatalog({ q: "gpt-4o", origin: "curated" }).total, 0);
});
