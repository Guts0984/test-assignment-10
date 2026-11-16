import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { orderCreateSchema, type CartDto } from '@shop/shared';
import {
  CheckoutForm,
  checkoutFormSchema,
  EMPTY_CHECKOUT_FORM,
  toOrderCreate,
} from '@/features/checkout';
import { json, mockFetch, renderWith } from './render';

const cart: CartDto = {
  lines: [],
  promo: null,
  subtotal: 100_000,
  discount: 0,
  afterDiscount: 100_000,
  delivery: { pickup: 0, courier: 10_000 },
  hasPriceChanges: false,
  hasStockProblems: false,
};

const validAddress = {
  fullName: 'Olena Shevchenko',
  phone: '+380501234567',
  city: 'Kyiv',
  street: 'Khreshchatyk',
  building: '1',
  apartment: '',
  postalCode: '01001',
};

const ORDER = { id: 'o1', number: 'ORD-10234', status: 'awaiting_payment' };

describe('address form validation (schema)', () => {
  const run = (v: Partial<typeof validAddress> & { deliveryMethod?: 'pickup' | 'courier' }) =>
    checkoutFormSchema.safeParse({
      ...EMPTY_CHECKOUT_FORM,
      ...validAddress,
      deliveryMethod: 'courier',
      ...v,
    });
  const errorsOf = (r: ReturnType<typeof run>) =>
    r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message]));

  it('accepts a complete address', () => {
    expect(run({}).success).toBe(true);
  });
  it('pickup needs no address at all', () => {
    expect(checkoutFormSchema.safeParse({ ...EMPTY_CHECKOUT_FORM }).success).toBe(true);
  });
  it('reports each broken field separately', () => {
    expect(
      errorsOf(
        run({
          fullName: '',
          phone: 'abc',
          city: ' ',
          street: 'x',
          building: '',
          postalCode: '123',
        }),
      ),
    ).toEqual({
      fullName: 'required',
      phone: 'phone',
      city: 'required',
      street: 'minLength',
      building: 'required',
      postalCode: 'postalCode',
    });
  });
  it.each([
    ['+380501234567', true],
    ['050 123 45 67', true],
    ['(050) 123-45-67', true],
    ['12345', false],
    ['+38abc', false],
    ['', false],
  ])('phone %s -> %s', (phone, ok) => {
    expect(run({ phone }).success).toBe(ok);
  });
  it.each([
    ['01001', true],
    ['1234', false],
    ['123456', false],
    ['ab123', false],
  ])('postal code %s -> %s', (postalCode, ok) => {
    expect(run({ postalCode }).success).toBe(ok);
  });
  it('whitespace-only is empty; very long values are refused', () => {
    expect(errorsOf(run({ fullName: '   ' })).fullName).toBe('required');
    expect(errorsOf(run({ city: 'x'.repeat(81) })).city).toBe('maxLength');
    expect(errorsOf(run({ apartment: '12345678901' })).apartment).toBe('maxLength');
  });
  it('what the form accepts, the server schema accepts too (payload is compatible)', () => {
    const values = checkoutFormSchema.parse({
      ...EMPTY_CHECKOUT_FORM,
      ...validAddress,
      deliveryMethod: 'courier',
      apartment: '12',
    });
    expect(orderCreateSchema.safeParse(toOrderCreate(values, 110_000)).success).toBe(true);
    expect(
      orderCreateSchema.safeParse(toOrderCreate({ ...EMPTY_CHECKOUT_FORM }, 100_000)).success,
    ).toBe(true);
    expect(toOrderCreate({ ...EMPTY_CHECKOUT_FORM }, 5)).toEqual({
      deliveryMethod: 'pickup',
      expectedTotal: 5,
    });
    expect(toOrderCreate(values, 1).address).toMatchObject({
      apartment: '12',
      postalCode: '01001',
    });
    expect(toOrderCreate({ ...values, apartment: '' }, 1).address).not.toHaveProperty('apartment');
  });
});

describe('<CheckoutForm />', () => {
  it('shows errors next to the fields and sends nothing until the address is valid', async () => {
    const calls = mockFetch(() => json(201, ORDER));
    const user = userEvent.setup();
    renderWith(<CheckoutForm cart={cart} onCreated={() => undefined} />);
    await user.click(screen.getByLabelText(/Courier/));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findAllByText('This field is required')).not.toHaveLength(0);
    expect(screen.getByLabelText('Phone')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Phone')).toHaveAccessibleDescription('This field is required');
    expect(calls).toHaveLength(0);

    await user.type(screen.getByLabelText('Full name'), 'Olena Shevchenko');
    await user.type(screen.getByLabelText('Phone'), '12');
    await user.type(screen.getByLabelText('City'), 'Kyiv');
    await user.type(screen.getByLabelText('Street'), 'Khreshchatyk');
    await user.type(screen.getByLabelText('Building'), '1');
    await user.type(screen.getByLabelText('Postal code'), '1234');
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText(/Enter a valid phone number/)).toBeInTheDocument();
    expect(screen.getByText('Postal code must have 5 digits')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('sends the order with the displayed total and ONE idempotency key, even on a double click', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = mockFetch(async () => {
      await gate;
      return json(201, ORDER);
    });
    const created = vi.fn();
    const user = userEvent.setup();
    renderWith(<CheckoutForm cart={cart} onCreated={created} />);
    const submit = screen.getByRole('button', { name: 'Place order' });
    await user.click(submit);
    await user.click(screen.getByRole('button', { name: 'Placing the order…' }));
    fireEvent.submit(submit.closest('form')!);
    release();
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/orders');
    expect(calls[0]!.body).toEqual({ deliveryMethod: 'pickup', expectedTotal: 100_000 });
    expect(calls[0]!.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('courier delivery adds the fee to the shown total and sends the address', async () => {
    const calls = mockFetch(() => json(201, ORDER));
    const user = userEvent.setup();
    renderWith(<CheckoutForm cart={cart} onCreated={() => undefined} />);
    expect(screen.getByTestId('totals-total')).toHaveTextContent('₴1,000.00');
    await user.click(screen.getByLabelText(/Courier/));
    expect(screen.getByTestId('totals-total')).toHaveTextContent('₴1,100.00');
    await user.type(screen.getByLabelText('Full name'), 'Olena Shevchenko');
    await user.type(screen.getByLabelText('Phone'), '+380501234567');
    await user.type(screen.getByLabelText('City'), 'Kyiv');
    await user.type(screen.getByLabelText('Street'), 'Khreshchatyk');
    await user.type(screen.getByLabelText('Building'), '1');
    await user.type(screen.getByLabelText('Postal code'), '01001');
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({
      deliveryMethod: 'courier',
      expectedTotal: 110_000,
      address: {
        fullName: 'Olena Shevchenko',
        phone: '+380501234567',
        city: 'Kyiv',
        postalCode: '01001',
      },
    });
  });

  it('a retry after a dropped connection re-sends the SAME idempotency key', async () => {
    let n = 0;
    const calls = mockFetch(() => {
      n++;
      if (n === 1) throw new TypeError('network down');
      return json(201, ORDER);
    });
    const created = vi.fn();
    const user = userEvent.setup();
    renderWith(<CheckoutForm cart={cart} onCreated={created} />);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText(/Could not place the order/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['Idempotency-Key']).toBe(calls[0]!.headers['Idempotency-Key']);
  });

  it('out-of-stock refusal tells which products and how many are left', async () => {
    mockFetch(() =>
      json(409, {
        error: {
          code: 'insufficient_stock',
          message: 'x',
          details: { shortages: [{ productId: 'p1', name: 'Kettle', requested: 5, available: 2 }] },
        },
      }),
    );
    const user = userEvent.setup();
    renderWith(<CheckoutForm cart={cart} onCreated={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText('Not enough stock for some products:')).toBeInTheDocument();
    expect(screen.getByText('Kettle: you asked for 5, available 2')).toBeInTheDocument();
  });

  it('a price change is explained and can be confirmed in one click', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/cart/accept-prices')
        ? json(200, { ...cart })
        : json(409, {
            error: {
              code: 'price_changed',
              message: 'x',
              details: {
                changes: [{ productId: 'p1', name: 'Kettle', oldPrice: 10_000, newPrice: 12_000 }],
              },
            },
          }),
    );
    const user = userEvent.setup();
    renderWith(<CheckoutForm cart={cart} onCreated={() => undefined} />, { locale: 'uk' });
    await user.click(screen.getByRole('button', { name: 'Оформити' }));
    expect(await screen.findByText('Ціни змінилися, поки ви обирали:')).toBeInTheDocument();
    expect(document.body.textContent?.replace(/\s/g, ' ')).toContain('Kettle: 100,00 ₴ → 120,00 ₴');
    await user.click(
      screen.getByRole('button', { name: 'Підтвердити нові ціни та спробувати ще раз' }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/cart/accept-prices'))).toBe(true),
    );
  });
});
