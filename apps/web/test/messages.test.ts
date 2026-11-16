import en from '../messages/en.json';
import uk from '../messages/uk.json';

const keys = (o: unknown, prefix = ''): string[] =>
  typeof o === 'object' && o !== null
    ? Object.entries(o).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
    : [prefix];

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
const flat = (o: unknown, prefix = ''): Record<string, string> =>
  typeof o === 'object' && o !== null
    ? Object.assign(
        {},
        ...Object.entries(o).map(([k, v]) => flat(v, prefix ? `${prefix}.${k}` : k)),
      )
    : { [prefix]: String(o) };

describe('translations', () => {
  it('uk and en have exactly the same keys', () => {
    const a = keys(uk).sort();
    const b = keys(en).sort();
    expect(a.filter((k) => !b.includes(k))).toEqual([]);
    expect(b.filter((k) => !a.includes(k))).toEqual([]);
  });
  it('every message uses the same placeholders in both languages', () => {
    const fu = flat(uk);
    const fe = flat(en);
    for (const k of Object.keys(fu)) expect(placeholders(fu[k]!), k).toEqual(placeholders(fe[k]!));
  });
  it('no message is empty', () => {
    for (const [k, v] of Object.entries(flat(uk))) expect(v.trim().length, k).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(flat(en))) expect(v.trim().length, k).toBeGreaterThan(0);
  });
  it('every promo rejection reason of the shared package has a translation', async () => {
    const { PROMO_REJECT_REASONS, ORDER_EVENT_TYPES } = await import('@shop/shared');
    for (const r of PROMO_REJECT_REASONS) {
      expect(uk.cart.promoReasons).toHaveProperty(r);
      expect(en.cart.promoReasons).toHaveProperty(r);
    }
    for (const e of ORDER_EVENT_TYPES) {
      expect(uk.orders.events, e).toHaveProperty(e);
      expect(en.orders.events, e).toHaveProperty(e);
    }
  });
});
