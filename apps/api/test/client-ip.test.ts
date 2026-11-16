import { describe, expect, it } from 'vitest';
import { getClientIp, normalizeIp } from '../src/http/client-ip';

describe('getClientIp', () => {
  it('ignores X-Forwarded-For completely when no proxy is trusted', () => {
    expect(getClientIp('10.0.0.5', '1.2.3.4', 0)).toBe('10.0.0.5');
    expect(getClientIp('::ffff:10.0.0.5', '1.2.3.4, 5.6.7.8', 0)).toBe('10.0.0.5');
  });
  it('takes the entry appended by the trusted proxy (right-most), never the forgeable left part', () => {
    expect(getClientIp('172.18.0.2', '6.6.6.6, 203.0.113.9', 1)).toBe('203.0.113.9');
    expect(getClientIp('172.18.0.2', '203.0.113.9', 1)).toBe('203.0.113.9');
    expect(getClientIp('172.18.0.2', '6.6.6.6, 203.0.113.9, 172.18.0.9', 2)).toBe('203.0.113.9');
  });
  it('falls back to the socket address on missing, short or garbage headers', () => {
    expect(getClientIp('172.18.0.2', undefined, 1)).toBe('172.18.0.2');
    expect(getClientIp('172.18.0.2', '', 1)).toBe('172.18.0.2');
    expect(getClientIp('172.18.0.2', '1.1.1.1', 2)).toBe('172.18.0.2');
    expect(getClientIp('172.18.0.2', 'not-an-ip', 1)).toBe('172.18.0.2');
    expect(getClientIp('172.18.0.2', "1.1.1.1'; DROP TABLE x;--", 1)).toBe('172.18.0.2');
    expect(getClientIp(undefined, undefined, 0)).toBe('unknown');
  });
  it('handles repeated headers and IPv6', () => {
    expect(getClientIp('172.18.0.2', ['6.6.6.6', '203.0.113.9'], 1)).toBe('203.0.113.9');
    expect(getClientIp('::1', '2001:DB8::1', 1)).toBe('2001:db8::1');
    expect(normalizeIp('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });
});
