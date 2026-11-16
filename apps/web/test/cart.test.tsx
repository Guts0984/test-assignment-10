import { screen } from '@testing-library/react';
import type { CartDto } from '@shop/shared';
import { calcTotals, DEFAULT_MONEY_CONFIG } from '@shop/shared';
import { cartBlocksCheckout, displayTotals, PromoReasonText } from '@/entities/cart';
import { renderWith } from './render';

const cart = (over: Partial<CartDto> = {}): CartDto => ({
  lines: [],
  promo: null,
  subtotal: 100_000,
  discount: 7_000,
  afterDiscount: 93_000,
  delivery: { pickup: 0, courier: 10_000 },
  hasPriceChanges: false,
  reservationMinutes: 15,
  hasStockProblems: false,
  ...over,
});

describe('displayTotals', () => {
  it('adds delivery for the chosen method to the discounted amount', () => {
    expect(displayTotals(cart(), 'pickup')).toEqual({
      subtotal: 100_000,
      discount: 7_000,
      afterDiscount: 93_000,
      delivery: 0,
      total: 93_000,
    });
    expect(displayTotals(cart(), 'courier')).toMatchObject({ delivery: 10_000, total: 103_000 });
  });
  it('free courier delivery (server decides) is honoured', () => {
    expect(displayTotals(cart({ delivery: { pickup: 0, courier: 0 } }), 'courier').total).toBe(
      93_000,
    );
  });
  it('matches the shared money rules for the same cart (what you see is what the server charges)', () => {
    const lines = [
      { unitPrice: 3333, qty: 1 },
      { unitPrice: 1999, qty: 3 },
      { unitPrice: 12_345, qty: 2 },
    ];
    for (const method of ['pickup', 'courier'] as const) {
      const server = calcTotals({
        lines,
        promo: { type: 'percent', value: 7 },
        deliveryMethod: method,
        config: DEFAULT_MONEY_CONFIG,
      });
      const dto = cart({
        subtotal: server.subtotal,
        discount: server.discount,
        afterDiscount: server.afterDiscount,
        delivery: {
          pickup: 0,
          courier: calcTotals({
            lines,
            promo: { type: 'percent', value: 7 },
            deliveryMethod: 'courier',
            config: DEFAULT_MONEY_CONFIG,
          }).delivery,
        },
      });
      expect(displayTotals(dto, method).total).toBe(server.total);
    }
  });
});

describe('checkout is blocked until the cart is fixed', () => {
  const line = {} as CartDto['lines'][number];
  it('empty cart, price changes and stock problems block it', () => {
    expect(cartBlocksCheckout({ lines: [], hasPriceChanges: false, hasStockProblems: false })).toBe(
      true,
    );
    expect(
      cartBlocksCheckout({ lines: [line], hasPriceChanges: true, hasStockProblems: false }),
    ).toBe(true);
    expect(
      cartBlocksCheckout({ lines: [line], hasPriceChanges: false, hasStockProblems: true }),
    ).toBe(true);
    expect(
      cartBlocksCheckout({ lines: [line], hasPriceChanges: false, hasStockProblems: false }),
    ).toBe(false);
  });
});

describe('promo rejection reasons are shown in plain words', () => {
  it.each([
    ['expired', 'en', 'This promo code has expired.'],
    ['not_found', 'en', 'This promo code does not exist.'],
    ['already_used', 'en', 'You have already used this promo code.'],
    ['limit_reached', 'en', 'This promo code has reached its usage limit.'],
    ['not_started', 'en', 'This promo code is not valid yet.'],
    ['inactive', 'en', 'This promo code is disabled.'],
    ['expired', 'uk', 'Термін дії промокоду минув.'],
    ['already_used', 'uk', 'Ви вже використали цей промокод.'],
  ] as const)('%s (%s)', (reason, locale, text) => {
    renderWith(<PromoReasonText reason={reason} />, { locale });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('minimum order shows the amount in the locale format', () => {
    const { unmount } = renderWith(<PromoReasonText reason="min_order" minOrder={50_000} />, {
      locale: 'uk',
    });
    expect(document.body.textContent?.replace(/\s/g, ' ')).toBe(
      'Мінімальна сума замовлення для цього коду — 500,00 ₴.',
    );
    unmount();
    renderWith(<PromoReasonText reason="min_order" minOrder={50_000} />, { locale: 'en' });
    expect(document.body.textContent).toBe('Minimum order amount for this code is ₴500.00.');
  });

  it('an unknown reason from a newer server falls back to a safe message instead of crashing', () => {
    renderWith(<PromoReasonText reason="something_new" />);
    expect(screen.getByText('This promo code does not exist.')).toBeInTheDocument();
  });
});
