import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { calcTotals, DEFAULT_MONEY_CONFIG, returnCreateSchema, type OrderDto } from '@shop/shared';
import { buildReturn, estimateRefund, ReturnForm } from '@/features/return-items';
import { json, mockFetch, renderWith } from './render';

// 3 lines, 7% discount (assignment scenario #10): bought 33.33 x1, 19.99 x3, 123.45 x2
const totals = calcTotals({
  lines: [
    { unitPrice: 3333, qty: 1 },
    { unitPrice: 1999, qty: 3 },
    { unitPrice: 12_345, qty: 2 },
  ],
  promo: { type: 'percent', value: 7 },
  deliveryMethod: 'courier',
  config: DEFAULT_MONEY_CONFIG,
});
const items = [
  {
    id: 'a',
    productId: 'pa',
    name: 'Mug',
    qty: 1,
    unitPrice: 3333,
    discountShare: totals.lines[0]!.discountShare,
    net: totals.lines[0]!.net,
    returnedQty: 0,
  },
  {
    id: 'b',
    productId: 'pb',
    name: 'Socks',
    qty: 3,
    unitPrice: 1999,
    discountShare: totals.lines[1]!.discountShare,
    net: totals.lines[1]!.net,
    returnedQty: 0,
  },
  {
    id: 'c',
    productId: 'pc',
    name: 'Lamp',
    qty: 2,
    unitPrice: 12_345,
    discountShare: totals.lines[2]!.discountShare,
    net: totals.lines[2]!.net,
    returnedQty: 0,
  },
];
const order = {
  id: 'o1',
  status: 'delivered',
  total: totals.total,
  refundedTotal: 0,
  returnableUntil: '2030-01-01T00:00:00Z',
  items,
} as unknown as OrderDto;

describe('return estimate', () => {
  it("equals the line price minus that line's discount share (kopeck-exact), delivery excluded", () => {
    expect(items.map((i) => i.net)).toEqual([3100, 5577, 22_962]);
    expect(estimateRefund(items, { b: 3 })).toBe(5577);
    expect(estimateRefund(items, { a: 1, b: 3, c: 2 })).toBe(3100 + 5577 + 22_962);
    expect(estimateRefund(items, { c: 1 })).toBe(11_481);
    expect(estimateRefund(items, {})).toBe(0);
    // never more than the goods were paid for: delivery (100 ₴) stays with the shop
    expect(estimateRefund(items, { a: 1, b: 3, c: 2 })).toBe(totals.afterDiscount);
    expect(totals.total - estimateRefund(items, { a: 1, b: 3, c: 2 })).toBe(totals.delivery);
  });
  it('accounts for what was already returned', () => {
    const partly = items.map((i) => (i.id === 'b' ? { ...i, returnedQty: 2 } : i));
    expect(estimateRefund(partly, { b: 1 })).toBe(5577 - Math.floor((5577 * 2) / 3));
    expect(estimateRefund(partly, { b: 2 })).toBe(0); // over the limit: ignored, the form reports it
  });
});

describe('buildReturn', () => {
  it('parses quantities and builds the API payload', () => {
    const real = items.map((i, k) => ({ ...i, id: `00000000-0000-4000-8000-00000000000${k + 1}` }));
    const [a, b, c] = real.map((i) => i.id) as [string, string, string];
    const r = buildReturn(real, { [a]: '1', [b]: ' 2 ', [c]: '' }, '  too small  ');
    expect(r).toMatchObject({
      ok: true,
      body: {
        items: [
          { orderItemId: a, qty: 1 },
          { orderItemId: b, qty: 2 },
        ],
        reason: 'too small',
      },
    });
    if (r.ok) expect(returnCreateSchema.safeParse(r.body).success).toBe(true);
  });
  it('rejects empty, non-integer, negative and too many', () => {
    expect(buildReturn(items, {}, '')).toMatchObject({ ok: false, none: true });
    expect(buildReturn(items, { a: '0', b: '0' }, '')).toMatchObject({ ok: false, none: true });
    expect(buildReturn(items, { b: '4' }, '')).toMatchObject({
      ok: false,
      errors: { b: 'tooMany' },
    });
    expect(buildReturn(items, { b: '1.5', c: '-1' }, '')).toMatchObject({
      ok: false,
      errors: { b: 'integer', c: 'integer' },
    });
    expect(buildReturn(items, { b: 'abc' }, '')).toMatchObject({
      ok: false,
      errors: { b: 'integer' },
    });
  });
});

describe('<ReturnForm />', () => {
  it('lets the customer pick items and quantities, shows the refund, and submits', async () => {
    const calls = mockFetch(() => json(201, order));
    const user = userEvent.setup();
    renderWith(<ReturnForm order={order} />);
    await user.type(screen.getByLabelText('Quantity to return of Socks'), '3');
    expect(screen.getByTestId('return-estimate')).toHaveTextContent('₴55.77');
    await user.type(screen.getByLabelText('Quantity to return of Lamp'), '1');
    expect(screen.getByTestId('return-estimate')).toHaveTextContent('₴170.58'); // 55.77 + 114.81
    await user.type(screen.getByLabelText('Reason (optional)'), 'Wrong size');
    await user.click(screen.getByRole('button', { name: 'Request return' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe('/api/orders/o1/returns');
    expect(calls[0]!.body).toEqual({
      items: [
        { orderItemId: 'b', qty: 3 },
        { orderItemId: 'c', qty: 1 },
      ],
      reason: 'Wrong size',
    });
    expect(
      await screen.findByText('Return created. The refund is on its way.'),
    ).toBeInTheDocument();
  });

  it('blocks submitting nothing and more than was bought, with messages at the field', async () => {
    const calls = mockFetch(() => json(201, order));
    const user = userEvent.setup();
    renderWith(<ReturnForm order={order} />);
    await user.click(screen.getByRole('button', { name: 'Request return' }));
    expect(await screen.findByText('Choose at least one item to return')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Quantity to return of Socks'), '5');
    await user.click(screen.getByRole('button', { name: 'Request return' }));
    expect(await screen.findByText('More than you bought')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity to return of Socks')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(calls).toHaveLength(0);
  });

  it("shows the server's refusal (e.g. returned more than bought in another tab)", async () => {
    mockFetch(() => json(409, { error: { code: 'return_exceeds_purchased', message: 'x' } }));
    const user = userEvent.setup();
    renderWith(<ReturnForm order={order} />);
    await user.type(screen.getByLabelText('Quantity to return of Mug'), '1');
    await user.click(screen.getByRole('button', { name: 'Request return' }));
    expect(await screen.findByText('You cannot return more than you bought.')).toBeInTheDocument();
  });

  it('only offers what is still returnable; nothing left -> a message instead of a form', () => {
    const partly = {
      ...order,
      items: items.map((i) => (i.id === 'a' ? { ...i, returnedQty: 1 } : i)),
    } as OrderDto;
    const { unmount } = renderWith(<ReturnForm order={partly} />);
    expect(screen.queryByLabelText('Quantity to return of Mug')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Quantity to return of Socks')).toBeInTheDocument();
    unmount();
    const none = { ...order, items: items.map((i) => ({ ...i, returnedQty: i.qty })) } as OrderDto;
    renderWith(<ReturnForm order={none} />);
    expect(
      screen.getByText('Everything from this order has already been returned.'),
    ).toBeInTheDocument();
  });
});
