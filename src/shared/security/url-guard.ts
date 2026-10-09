/**
 * URL safety guard for source fetching (Phase 4 — ADR-0039 §2).
 *
 * Two layers, honestly documented:
 *
 * 1. LITERAL checks (this module): https-only schemes, port 443 only,
 *    userinfo rejection, and rejection of IP literals in loopback /
 *    private / link-local / metadata / CGNAT / benchmark / reserved
 *    ranges — including non-canonical IPv4 encodings (decimal
 *    `2130706433`, octal `0177.0.0.1`, hex `0x7f.1`, mixed radix) and
 *    IPv6 / IPv4-mapped forms.
 *
 * 2. POSITIVE ALLOWLIST (call sites): every connector may only talk to
 *    the exact hostnames of its configured endpoints. Workers cannot
 *    resolve DNS, so NO code may claim "DNS-safe": a hostname that
 *    resolves privately cannot be excluded at fetch time. The allowlist
 *    is the real boundary; this module's literal checks are
 *    defense-in-depth against direct-IP bypass attempts.
 *
 * Pure functions; no network, no logging (callers log stable codes).
 */

export type UrlGuardReason =
  | 'invalid_url'
  | 'scheme_not_https'
  | 'port_not_allowed'
  | 'userinfo_present'
  | 'host_missing'
  | 'host_not_allowed'
  | 'ip_literal_forbidden'
  | 'host_invalid';

export interface UrlGuardResult {
  readonly ok: boolean;
  readonly reason?: UrlGuardReason;
  /** Parsed URL on success (validated form). */
  readonly url?: URL;
  /** Lowercased hostname on success (allowlist match input). */
  readonly hostname?: string;
}

const ALLOWED_PORT = '443';

/**
 * Parse an IPv4-ish string into its numeric value, accepting dotted
 * decimal / octal / hex mixtures and bare 32-bit integers.
 * Returns null when the input is not an IPv4 literal form.
 */
export function parseIpv4Numeric(host: string): number | null {
  if (host.length === 0 || host.length > 64) {
    return null;
  }
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) {
    return null;
  }
  // A bare integer (no dots) is a 32-bit value if fully numeric/hex.
  if (parts.length === 1) {
    const value = parseIpPart(parts[0]!, 0);
    if (value === null || value > 0xffffffff) {
      return null;
    }
    return value;
  }
  let value = 0;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const part = parts[i]!;
    if (part.length === 0) {
      return null;
    }
    // Last part may carry the remaining bits when fewer than 4 parts
    // (e.g. `127.1`), matching classic inet_aton semantics.
    const parsed = parseIpPart(part, isLast && parts.length < 4 ? 0 : 8);
    if (parsed === null) {
      return null;
    }
    if (isLast && parts.length < 4) {
      const consumedBits = 8 * (parts.length - 1);
      const remaining = 32 - consumedBits;
      if (parsed >= 1 << remaining) {
        return null;
      }
      value = value * Math.pow(2, remaining) + parsed;
    } else {
      if (parsed > 255) {
        return null;
      }
      value = value * 256 + parsed;
    }
  }
  return value;
}

/** Parse one IPv4 part: decimal, 0x-hex, or 0-octal. */
function parseIpPart(part: string, maxBits: number): number | null {
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    value = Number.parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/.test(part)) {
    value = Number.parseInt(part.slice(1), 8);
  } else if (/^[0-9]+$/.test(part)) {
    value = Number.parseInt(part, 10);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  if (maxBits > 0 && value >> maxBits > 0) {
    return null;
  }
  return value;
}

/**
 * Classify a numeric IPv4 against blocked ranges (loopback, private,
 * link-local, metadata, CGNAT, benchmark, reserved, multicast).
 */
export function isBlockedIpv4(value: number): boolean {
  const octet1 = (value >>> 24) & 0xff;
  const octet2 = (value >>> 16) & 0xff;
  if (
    octet1 === 0 || // 0.0.0.0/8 "this network"
    octet1 === 10 || // 10/8 private
    octet1 === 127 || // 127/8 loopback
    (octet1 === 100 && octet2 >= 64 && octet2 <= 127) || // 100.64/10 CGNAT
    (octet1 === 169 && octet2 === 254) || // 169.254/16 link-local/metadata
    (octet1 === 172 && octet2 >= 16 && octet2 <= 31) || // 172.16/12 private
    (octet1 === 192 && octet2 === 0) || // 192.0.0/24 + 192.0.2/24
    (octet1 === 192 && octet2 === 168) || // 192.168/16 private
    (octet1 === 198 && (octet2 === 18 || octet2 === 19)) || // 198.18/15 benchmark
    (octet1 === 198 && octet2 === 51) || // 198.51.100/24 doc
    (octet1 === 203 && octet2 === 0) || // 203.0.113/24 doc
    octet1 >= 224 // multicast + reserved + broadcast
  ) {
    return true;
  }
  return false;
}

/** Bracketed IPv6 host → true when it must be blocked. */
export function isBlockedIpv6Literal(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const lower = bare.toLowerCase();
  // Zone indices rejected earlier by URL parsing; guard anyway.
  const withoutZone = lower.split('%')[0] ?? lower;

  // IPv4-mapped / IPv4-compatible IPv6 (::ffff:a.b.c.d).
  const lastColon = withoutZone.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = withoutZone.slice(lastColon + 1);
    const v4 = parseIpv4Numeric(tail);
    if (v4 !== null) {
      return true; // any embedded IPv4 in a literal is hostile here
    }
  }
  // Unspecified / loopback.
  if (withoutZone === '::' || withoutZone === '::1' || withoutZone === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast,
  // ::/96 IPv4-compatible, 64:ff9b::/96 NAT64, 100::/64 discard-only,
  // 2001:db8::/32 documentation.
  const firstSegment = Number.parseInt(withoutZone.split(':')[0] ?? '', 16);
  if (Number.isInteger(firstSegment)) {
    if (
      (firstSegment & 0xfe00) === 0xfc00 || // fc00::/7
      (firstSegment & 0xffc0) === 0xfe80 || // fe80::/10
      (firstSegment & 0xff00) === 0xff00 || // ff00::/8
      firstSegment === 0x64 || // 64:ff9b::/96 starts 0064; 100:: starts 0100
      firstSegment === 0x2001 // 2001: db8/32 + Teredian/IETF ranges
    ) {
      return true;
    }
  }
  return false;
}

/** Hostname syntax guard (DNS-safe subset; no IP literal forms). */
function isValidDnsHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) {
    return false;
  }
  // Reject anything that smells like an IPv4 literal (any all-numeric
  // dotted form) — those must go through the IP-literal rejection path.
  if (parseIpv4Numeric(hostname) !== null) {
    return false;
  }
  const labels = hostname.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      return false;
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label)) {
      return false;
    }
  }
  return true;
}

/** Guard a fetched/redirect URL against the literal layer (ADR-0039 §2). */
export function guardFetchUrl(rawUrl: string): UrlGuardResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'scheme_not_https' };
  }
  if (parsed.port !== '' && parsed.port !== ALLOWED_PORT) {
    return { ok: false, reason: 'port_not_allowed' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'userinfo_present' };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) {
    return { ok: false, reason: 'host_missing' };
  }
  // ALL IP literals are forbidden: the allowlist boundary is DNS
  // hostnames only. Bracketed IPv6 (URL keeps brackets) and every IPv4
  // literal form (canonical or encoded) are rejected outright; the
  // classification helpers below document WHY each family is hostile.
  if (hostname.startsWith('[')) {
    return { ok: false, reason: 'ip_literal_forbidden' };
  }
  const v4 = parseIpv4Numeric(hostname);
  if (v4 !== null) {
    return { ok: false, reason: 'ip_literal_forbidden' };
  }
  if (!isValidDnsHostname(hostname)) {
    return { ok: false, reason: 'host_invalid' };
  }
  return { ok: true, url: parsed, hostname };
}

/** Exact-match host allowlist check (the real SSRF boundary). */
export function hostnameAllowed(hostname: string, allowedHosts: ReadonlyArray<string>): boolean {
  const normalized = hostname.toLowerCase();
  return allowedHosts.some((allowed) => allowed.toLowerCase() === normalized);
}

/** Guard + allowlist in one step for fetch targets. */
export function guardFetchTarget(
  rawUrl: string,
  allowedHosts: ReadonlyArray<string>,
): UrlGuardResult {
  const guarded = guardFetchUrl(rawUrl);
  if (!guarded.ok || guarded.hostname === undefined) {
    return guarded;
  }
  if (!hostnameAllowed(guarded.hostname, allowedHosts)) {
    return { ok: false, reason: 'host_not_allowed' };
  }
  return guarded;
}
