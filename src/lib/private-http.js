// Private HTTP is an explicit, LAN-only exception. Keep this module free of
// Node builtins so its browser/edge counterpart can apply the same policy.
function normalizeHostname(value) {
  return String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function ipv4Parts(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const parts = hostname.split(".").map(Number);
  return parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function isLoopbackHostname(value) {
  const hostname = normalizeHostname(value);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPrivateNetworkHostname(value) {
  const hostname = normalizeHostname(value);
  if (isLoopbackHostname(hostname)) return true;

  const ipv4 = ipv4Parts(hostname);
  if (ipv4) {
    return ipv4[0] === 10 || ipv4[0] === 127
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168)
      || (ipv4[0] === 169 && ipv4[1] === 254);
  }

  // Do not classify IPv4-mapped/transition addresses or scoped identifiers as
  // private without a complete address parser. URL canonicalization handles
  // ordinary ULA/link-local literals before this check.
  if (!hostname.includes(":") || hostname.includes("%") || hostname.includes(".")) return false;
  const first = hostname.split(":", 1)[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const firstHextet = parseInt(first, 16);
  return (firstHextet & 0xfe00) === 0xfc00 // fc00::/7 (ULA)
    || (firstHextet & 0xffc0) === 0xfe80; // fe80::/10 (link-local)
}

function normalizeInstanceUrl(value, { allowPrivateHttp = false } = {}) {
  try {
    const url = new URL(String(value || ""));
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)
      && !(allowPrivateHttp === true && isPrivateNetworkHostname(url.hostname))) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

module.exports = { normalizeHostname, isLoopbackHostname, isPrivateNetworkHostname, normalizeInstanceUrl };
