import type { Locale } from '../config/locales';

const INTL_LOCALE: Record<Locale, string> = { uk: 'uk-UA', en: 'en-US' };

/** Amounts are integer kopecks. uk: "1 234,50 ₴", en: "₴1,234.50". */
export function formatMoney(kopecks: number, locale: Locale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'currency',
    currency: 'UAH',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(kopecks / 100);
}

export function formatDateTime(iso: string | Date, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function formatDate(iso: string | Date, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { dateStyle: 'medium' }).format(
    typeof iso === 'string' ? new Date(iso) : iso,
  );
}

/**
 * "12,50" / "12.50" / "1 234,5" -> 1250 / 1250 / 123450 kopecks. Returns null for anything that is
 * not a plain non-negative amount with at most 2 decimals (no floating point arithmetic involved).
 */
export function parseMoneyInput(input: string): number | null {
  const s = input.trim().replace(/\s/g, '').replace(',', '.');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** kopecks -> "12.5" style editable value (no currency symbol). */
export function toMoneyInput(kopecks: number): string {
  const whole = Math.floor(kopecks / 100);
  const frac = kopecks % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}
