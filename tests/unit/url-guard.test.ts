import { describe, expect, it } from 'vitest';
import {
  guardFetchUrl,
  guardFetchTarget,
  hostnameAllowed,
  isBlockedIpv4,
  parseIpv4Numeric,
} from '../../src/shared/security/url-guard';

/**
 * SSRF literal-layer guard (Phase 4 — ADR-0039 §2): scheme/port/userinfo/
 * IP-literal rejection including encoded IPv4 forms, plus the positive
 * allowlist boundary. Workers DNS limitations are documented in the ADR —
 * the allowlist is the real control; these checks are defense in depth.
 */

describe('guardFetchUrl — literal layer', () => {
  it('accepts a plain https URL', () => {
    const result = guardFetchUrl('https://blog.playstation.com/feed/');
    expect(result.ok).toBe(true);
    expect(result.hostname).toBe('blog.playstation.com');
  });

  it('rejects http (allowHttp=false policy)', () => {
    expect(guardFetchUrl('http://blog.playstation.com/feed/').ok).toBe(false);
    expect(guardFetchUrl('http://blog.playstation.com/feed/').reason).toBe('scheme_not_https');
  });

  it('rejects ftp and other schemes', () => {
    expect(guardFetchUrl('ftp://example.com/file').reason).toBe('scheme_not_https');
    expect(guardFetchUrl('file:///etc/passwd').reason).toBe('scheme_not_https');
  });

  it('rejects non-443 ports', () => {
    expect(guardFetchUrl('https://example.com:8443/feed').reason).toBe('port_not_allowed');
    expect(guardFetchUrl('https://127.0.0.1:8443/').reason).toBe('port_not_allowed');
  });

  it('accepts an explicit 443 port', () => {
    expect(guardFetchUrl('https://example.com:443/feed').ok).toBe(true);
  });

  it('rejects userinfo (credential smuggling)', () => {
    expect(guardFetchUrl('https://user:pass@example.com/feed').reason).toBe('userinfo_present');
    expect(guardFetchUrl('https://token@example.com/feed').reason).toBe('userinfo_present');
  });

  it('rejects loopback IPv4 literals', () => {
    expect(guardFetchUrl('https://127.0.0.1/feed').reason).toBe('ip_literal_forbidden');
    expect(guardFetchUrl('https://127.0.0.1.nip.io/').ok).toBe(true); // hostname, DNS layer (allowlist controls)
  });

  it('rejects decimal-encoded IPv4 (2130706433 = 127.0.0.1)', () => {
    expect(guardFetchUrl('https://2130706433/feed').reason).toBe('ip_literal_forbidden');
  });

  it('rejects octal-encoded IPv4 (0177.0.0.1)', () => {
    expect(guardFetchUrl('https://0177.0.0.1/feed').reason).toBe('ip_literal_forbidden');
  });

  it('rejects hex-encoded IPv4 (0x7f000001)', () => {
    expect(guardFetchUrl('https://0x7f000001/feed').reason).toBe('ip_literal_forbidden');
    expect(guardFetchUrl('https://0x7f.0.0.1/feed').reason).toBe('ip_literal_forbidden');
  });

  it('rejects private, link-local, metadata and reserved ranges', () => {
    for (const host of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '198.18.0.1', // benchmark
      '224.0.0.1', // multicast
      '0.0.0.0',
    ]) {
      expect(guardFetchUrl(`https://${host}/`)).toMatchObject({ ok: false, reason: 'ip_literal_forbidden' });
    }
  });

  it('rejects IPv6 literals (loopback, mapped, public)', () => {
    expect(guardFetchUrl('https://[::1]/feed').reason).toBe('ip_literal_forbidden');
    expect(guardFetchUrl('https://[::ffff:127.0.0.1]/feed').reason).toBe('ip_literal_forbidden');
    expect(guardFetchUrl('https://[2001:db8::1]/feed').reason).toBe('ip_literal_forbidden');
  });

  it('rejects malformed hostnames', () => {
    expect(guardFetchUrl('https://bad_host.example.com/').reason).toBe('host_invalid');
    expect(guardFetchUrl('https://').reason).toBe('invalid_url');
  });
});

describe('parseIpv4Numeric / isBlockedIpv4 classification', () => {
  it('decodes classic inet_aton forms', () => {
    expect(parseIpv4Numeric('127.0.0.1')).toBe(0x7f000001);
    expect(parseIpv4Numeric('2130706433')).toBe(0x7f000001);
    expect(parseIpv4Numeric('0177.0.0.1')).toBe(0x7f000001);
    expect(parseIpv4Numeric('0x7f000001')).toBe(0x7f000001);
    expect(parseIpv4Numeric('127.1')).toBe(0x7f000001);
    expect(parseIpv4Numeric('example.com')).toBeNull();
    expect(parseIpv4Numeric('999.999.999.999')).toBeNull();
  });

  it('classifies blocked ranges', () => {
    expect(isBlockedIpv4(0x7f000001)).toBe(true);
    expect(isBlockedIpv4(0x0a000001)).toBe(true);
    expect(isBlockedIpv4(0xa9fea9fe)).toBe(true); // 169.254.169.254
    expect(isBlockedIpv4(0x08080808)).toBe(false); // 8.8.8.8 public DNS
  });
});

describe('positive host allowlist (the real boundary)', () => {
  const allowed = ['api.steampowered.com', 'blog.playstation.com'];

  it('matches exact hosts only', () => {
    expect(hostnameAllowed('api.steampowered.com', allowed)).toBe(true);
    expect(hostnameAllowed('evil.steampowered.com', allowed)).toBe(false);
    expect(hostnameAllowed('api.steampowered.com.evil.tld', allowed)).toBe(false);
    expect(hostnameAllowed('', allowed)).toBe(false);
  });

  it('guardFetchTarget combines the literal layer with the allowlist', () => {
    expect(guardFetchTarget('https://api.steampowered.com/x', allowed).ok).toBe(true);
    expect(guardFetchTarget('https://evil.tld/feed', allowed)).toMatchObject({
      ok: false,
      reason: 'host_not_allowed',
    });
    expect(guardFetchTarget('http://api.steampowered.com/x', allowed).ok).toBe(false);
  });

  it('an IP literal can never pass even with a hostname allowlist', () => {
    expect(guardFetchTarget('https://127.0.0.1/x', allowed).ok).toBe(false);
  });
});
