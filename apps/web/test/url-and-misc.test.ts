import {
  catalogToApiFilters,
  catalogToQuery,
  DEFAULT_CATALOG_STATE,
  parseCatalogParams,
} from '@/features/catalog-filters';
import { lastDays, periodFromParams } from '@/features/report-period';
import { orderRefetchInterval } from '@/entities/order';
import { apiFetch, isApiError } from '@/shared/api/client';
import { safeNext, safeReturnUrl } from '@/shared/lib/safe-redirect';
import { json, mockFetch } from './render';

const sp = (q: string) => new URLSearchParams(q);

describe('catalogue filters live in the URL', () => {
  it('parse -> serialise round-trips and omits defaults', () => {
    const s = parseCatalogParams(
      sp('q=kettle&category=home&minPrice=10&maxPrice=99.5&sort=price_asc'),
    );
    expect(s).toEqual({
      q: 'kettle',
      category: 'home',
      minPrice: '10',
      maxPrice: '99.5',
      sort: 'price_asc',
    });
    expect(catalogToQuery(s)).toBe(
      '?category=home&maxPrice=99.5&minPrice=10&q=kettle&sort=price_asc',
    );
    expect(catalogToQuery(DEFAULT_CATALOG_STATE)).toBe('');
    expect(parseCatalogParams(sp(catalogToQuery(s).slice(1)))).toEqual(s);
  });
  it('an empty URL is the default view; junk sort falls back to newest; long search is capped', () => {
    expect(parseCatalogParams(sp(''))).toEqual(DEFAULT_CATALOG_STATE);
    expect(parseCatalogParams(sp('sort=hack')).sort).toBe('newest');
    expect(parseCatalogParams(sp(`q=${'a'.repeat(500)}`)).q).toHaveLength(100);
  });
  it('converts ₴ to kopecks for the API and flags bad prices instead of sending them', () => {
    expect(
      catalogToApiFilters({ ...DEFAULT_CATALOG_STATE, minPrice: '10', maxPrice: '99,5' }).filters,
    ).toMatchObject({ minPrice: 1000, maxPrice: 9950 });
    expect(catalogToApiFilters({ ...DEFAULT_CATALOG_STATE, minPrice: 'abc' })).toMatchObject({
      errors: { minPrice: true },
      filters: { minPrice: undefined },
    });
    const inverted = catalogToApiFilters({
      ...DEFAULT_CATALOG_STATE,
      minPrice: '50',
      maxPrice: '10',
    });
    expect(inverted.errors.range).toBe(true);
    expect(inverted.filters.minPrice).toBeUndefined();
  });
});

describe('report period in the URL', () => {
  const today = new Date('2026-06-15T12:00:00Z');
  it('defaults to the last 30 days', () => {
    expect(periodFromParams(sp(''), today)).toEqual({
      period: { from: '2026-05-17', to: '2026-06-15' },
      valid: true,
    });
    expect(lastDays(7, today)).toEqual({ from: '2026-06-09', to: '2026-06-15' });
  });
  it('accepts a valid period, flags invalid ones and falls back', () => {
    expect(periodFromParams(sp('from=2026-01-01&to=2026-03-31'), today)).toEqual({
      period: { from: '2026-01-01', to: '2026-03-31' },
      valid: true,
    });
    for (const bad of [
      'from=2026-03-31&to=2026-01-01',
      'from=2020-01-01&to=2026-01-01',
      'from=x&to=y',
      'from=2026-02-30&to=2026-03-01',
      'from=2026-01-01',
    ]) {
      const r = periodFromParams(sp(bad), today);
      expect(r.valid, bad).toBe(false);
      expect(r.period).toEqual({ from: '2026-05-17', to: '2026-06-15' });
    }
  });
});

describe('order page refreshes itself exactly when something can still change', () => {
  const base = { status: 'paid' as const, pendingPayment: false, refunds: [] };
  it('polls while awaiting payment, while a payment session is open, and while a refund is pending', () => {
    expect(orderRefetchInterval({ ...base, status: 'awaiting_payment' })).toBeGreaterThan(0);
    expect(
      orderRefetchInterval({ ...base, status: 'cancelled', pendingPayment: true }),
    ).toBeGreaterThan(0); // late notification may restore it
    expect(
      orderRefetchInterval({ ...base, refunds: [{ status: 'pending' }] as never }),
    ).toBeGreaterThan(0);
  });
  it('stops when nothing is pending', () => {
    expect(orderRefetchInterval(base)).toBe(false);
    expect(
      orderRefetchInterval({
        ...base,
        status: 'cancelled',
        refunds: [{ status: 'succeeded' }] as never,
      }),
    ).toBe(false);
    expect(orderRefetchInterval(undefined)).toBe(false);
  });
});

describe('redirect targets cannot leave the site', () => {
  it.each([
    ['/uk/orders/1', '/orders/1'], // the language is added by the router, so it must not be in `next`
    ['/en/orders', '/orders'],
    ['/en', '/'],
    ['/uk', '/'],
    ['/en?x=1', '/?x=1'],
    ['/en#top', '/#top'],
    ['/english', '/english'], // only a whole language segment is a prefix
    ['/orders/1?tab=refunds', '/orders/1?tab=refunds'],
    ['/en//evil.example', '/'], // becomes protocol-relative once the language is stripped
    ['/uk/\\evil.example', '/'],
    ['/login', '/'], // the login page is no destination
    ['/en/login', '/'],
    ['/login?next=/cart', '/'],
    ['/loginx', '/loginx'],
    ['/', '/'],
    ['//evil.example', '/'],
    ['https://evil.example', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    [null, '/'],
    ['/a b', '/'],
  ])('login next=%s -> %s', (input, out) => {
    expect(safeNext(input)).toBe(out);
  });
  it('stub returnUrl accepts only same-site paths', () => {
    expect(safeReturnUrl('/en/orders/1')).toBe('/en/orders/1');
    for (const bad of [
      '//evil.example',
      'http://evil.example',
      '/\\x',
      'data:text/html,x',
      '',
      null,
    ])
      expect(safeReturnUrl(bad as string | null)).toBeNull();
  });
});

describe('api client', () => {
  it('turns the server error format into a typed error', async () => {
    mockFetch(() =>
      json(409, { error: { code: 'insufficient_stock', message: 'nope', details: { x: 1 } } }),
    );
    const err = await apiFetch('/orders', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    expect(err).toMatchObject({
      status: 409,
      code: 'insufficient_stock',
      message: 'nope',
      details: { x: 1 },
    });
  });
  it('survives non-JSON error bodies and network failures', async () => {
    mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await apiFetch('/x').catch((e: unknown) => e)).toMatchObject({
      status: 502,
      code: 'http_error',
    });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await apiFetch('/x').catch((e: unknown) => e)).toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });
  it('204 has no body; the session cookie is sent same-origin; JSON content type only with a body', async () => {
    const calls = mockFetch(() => new Response(null, { status: 204 }));
    expect(await apiFetch('/auth/logout', { method: 'POST', body: {} })).toBeUndefined();
    await apiFetch('/me');
    expect(calls[0]!.init?.credentials).toBe('same-origin');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(calls[1]!.headers['Content-Type']).toBeUndefined();
  });
});
