import { NextIntlClientProvider, useTranslations } from 'next-intl';
import { render, screen } from '@testing-library/react';
import { formatDate, formatMoney, parseMoneyInput, toMoneyInput } from '@/shared/lib/format';
import { formatCountdown, secondsLeft } from '@/shared/lib/countdown';
import { MESSAGES } from './render';

const nbsp = (s: string) => s.replace(/\s/g, ' ');

describe('money formatting follows the locale', () => {
  it('uk: 1 234,50 ₴', () => {
    expect(nbsp(formatMoney(123_450, 'uk'))).toBe('1 234,50 ₴');
    expect(nbsp(formatMoney(5, 'uk'))).toBe('0,05 ₴');
    expect(nbsp(formatMoney(0, 'uk'))).toBe('0,00 ₴');
    expect(nbsp(formatMoney(100_000_000, 'uk'))).toBe('1 000 000,00 ₴');
  });
  it('en: ₴1,234.50', () => {
    expect(formatMoney(123_450, 'en')).toBe('₴1,234.50');
    expect(formatMoney(99, 'en')).toBe('₴0.99');
  });
  it('exact for every kopeck amount (no float drift)', () => {
    for (const k of [1, 7, 10, 29, 33, 99, 101, 12_345, 99_999_999]) {
      const s = formatMoney(k, 'en').replace(/[₴,]/g, '');
      expect(Math.round(Number(s) * 100)).toBe(k);
    }
  });
  it('dates are formatted per locale', () => {
    expect(formatDate('2026-03-05T10:00:00Z', 'en')).toMatch(/Mar/);
    expect(formatDate('2026-03-05T10:00:00Z', 'uk')).toMatch(/бер/);
  });
});

describe('money input parsing (no floating point)', () => {
  it('accepts comma and dot, spaces; rejects garbage', () => {
    expect(parseMoneyInput('12,50')).toBe(1250);
    expect(parseMoneyInput('12.5')).toBe(1250);
    expect(parseMoneyInput(' 1 234,05 ')).toBe(123_405);
    expect(parseMoneyInput('0.29')).toBe(29);
    expect(parseMoneyInput('19.99')).toBe(1999);
    expect(parseMoneyInput('100')).toBe(10_000);
    for (const bad of ['', 'abc', '-5', '1.234', '1,2,3', '1e5', '12.', '.5', '10000000000'])
      expect(parseMoneyInput(bad), bad).toBeNull();
  });
  it('round-trips with toMoneyInput', () => {
    for (const k of [1, 50, 100, 1999, 123_450, 99_999_999])
      expect(parseMoneyInput(toMoneyInput(k))).toBe(k);
  });
});

describe('countdown', () => {
  it('counts whole seconds, never below zero', () => {
    const now = Date.parse('2026-01-01T10:00:00Z');
    expect(secondsLeft('2026-01-01T10:15:00Z', now)).toBe(900);
    expect(secondsLeft('2026-01-01T10:00:00.400Z', now)).toBe(1);
    expect(secondsLeft('2026-01-01T09:59:00Z', now)).toBe(0);
    expect(secondsLeft(null, now)).toBe(0);
    expect(formatCountdown(900)).toBe('15:00');
    expect(formatCountdown(65)).toBe('01:05');
    expect(formatCountdown(0)).toBe('00:00');
  });
});

describe('plural forms (ICU, per locale)', () => {
  const Probe = ({ count }: { count: number }) => (
    <p>{useTranslations('cart')('itemsCount', { count })}</p>
  );
  const render1 = (locale: 'uk' | 'en', count: number) =>
    render(
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        <Probe count={count} />
      </NextIntlClientProvider>,
    );

  it.each([
    [1, '1 товар'],
    [2, '2 товари'],
    [3, '3 товари'],
    [4, '4 товари'],
    [5, '5 товарів'],
    [11, '11 товарів'],
    [12, '12 товарів'],
    [21, '21 товар'],
    [22, '22 товари'],
    [25, '25 товарів'],
    [101, '101 товар'],
    [111, '111 товарів'],
    [0, '0 товарів'],
  ])('uk: %i -> %s', (n, expected) => {
    render1('uk', n);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it.each([
    [1, '1 item'],
    [2, '2 items'],
    [0, '0 items'],
  ])('en: %i -> %s', (n, expected) => {
    render1('en', n);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
