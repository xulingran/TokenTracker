const assert = require("node:assert/strict");
const { test } = require("node:test");
const nodePolicy = require("../src/lib/private-http");

const cases = [
  ["http://10.0.0.10:7130", true],
  ["http://172.16.0.10:7130", true],
  ["http://172.31.255.255:7130", true],
  ["http://192.168.1.20:7130", true],
  ["http://169.254.10.10:7130", true],
  ["http://[fd00::10]:7130", true],
  ["http://[fe80::10]:7130", true],
  ["http://172.15.0.1:7130", false],
  ["http://172.32.0.1:7130", false],
  ["http://100.64.0.1:7130", false],
  ["http://8.8.8.8:7130", false],
  ["http://nas.local:7130", false],
  ["http://192.168.1.20.evil.example:7130", false],
  ["http://[::ffff:192.168.1.20]:7130", false],
  ["http://[2001:4860::1]:7130", false],
];

test("CLI and Dashboard private-HTTP policies accept the same explicit private IP literals", async () => {
  const browserPolicy = await import("../dashboard/src/lib/private-http.mjs");
  for (const [value, expected] of cases) {
    for (const policy of [nodePolicy, browserPolicy]) {
      assert.equal(Boolean(policy.normalizeInstanceUrl(value, { allowPrivateHttp: true })), expected, value);
      assert.equal(policy.normalizeInstanceUrl(value), null, `${value} must require an explicit opt-in`);
    }
  }
  for (const policy of [nodePolicy, browserPolicy]) {
    assert.equal(policy.normalizeInstanceUrl("http://127.0.0.1:7130"), "http://127.0.0.1:7130");
    assert.equal(policy.normalizeInstanceUrl("http://[::1]:7130"), "http://[::1]:7130");
    assert.equal(policy.normalizeInstanceUrl("https://example.com"), "https://example.com");
    assert.equal(policy.normalizeInstanceUrl("https://user:pass@example.com", { allowPrivateHttp: true }), null);
    assert.equal(policy.normalizeInstanceUrl("http://192.168.1.20/?x=1", { allowPrivateHttp: true }), null);
  }
});

test("numeric IPv4 URL forms cannot bypass the public-address rejection", async () => {
  const browserPolicy = await import("../dashboard/src/lib/private-http.mjs");
  for (const policy of [nodePolicy, browserPolicy]) {
    assert.equal(policy.normalizeInstanceUrl("http://0x08080808", { allowPrivateHttp: true }), null);
    assert.equal(policy.normalizeInstanceUrl("http://3232235777", { allowPrivateHttp: true }) !== null, true);
  }
});
