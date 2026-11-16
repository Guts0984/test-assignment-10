import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromoForm } from '@/features/apply-promo';
import { LoginForm } from '@/features/login';
import { json, mockFetch, renderWith } from './render';

describe('<LoginForm />', () => {
  it('validates fields before calling the server', async () => {
    const calls = mockFetch(() => json(200, {}));
    const user = userEvent.setup();
    renderWith(<LoginForm onSuccess={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findAllByText('This field is required')).toHaveLength(2);
    await user.type(screen.getByLabelText('E-mail'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid e-mail address')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it('wrong password and throttling get their own messages', async () => {
    let status = 401;
    mockFetch(() =>
      status === 401
        ? json(401, { error: { code: 'unauthorized', message: 'x' } })
        : json(429, {
            error: { code: 'rate_limited', message: 'x', details: { retryAfterSec: 90 } },
          }),
    );
    const user = userEvent.setup();
    renderWith(<LoginForm onSuccess={() => undefined} />);
    await user.type(screen.getByLabelText('E-mail'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Wrong e-mail or password.')).toBeInTheDocument();
    status = 429;
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('Too many attempts. Try again in 90 seconds.'),
    ).toBeInTheDocument();
  });
  it('calls onSuccess after a good login', async () => {
    mockFetch(() => json(200, { id: '1', email: 'a@b.co', name: 'A', role: 'customer' }));
    const done = vi.fn();
    const user = userEvent.setup();
    renderWith(<LoginForm onSuccess={done} />);
    await user.type(screen.getByLabelText('E-mail'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
  });
});

describe('<PromoForm />', () => {
  const rejection = (reason: string, minOrder: number | null = null) =>
    json(422, { error: { code: 'promo_rejected', message: 'x', details: { reason, minOrder } } });

  it.each([
    ['expired', null, 'This promo code has expired.'],
    ['already_used', null, 'You have already used this promo code.'],
    ['min_order', 50_000, 'Minimum order amount for this code is ₴500.00.'],
  ])('shows why a code was refused: %s', async (reason, min, text) => {
    mockFetch(() => rejection(reason, min));
    const user = userEvent.setup();
    renderWith(<PromoForm promo={null} />);
    await user.type(screen.getByLabelText('Promo code'), 'SUMMER');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByLabelText('Promo code')).toHaveAttribute('aria-invalid', 'true');
  });

  it('an applied code shows the discount; a code that stopped applying shows the reason', () => {
    const { unmount } = renderWith(
      <PromoForm
        promo={{ code: 'SAVE10', valid: true, reason: null, minOrder: null, discount: 12_345 }}
      />,
    );
    expect(screen.getByText('Code SAVE10 applied: −₴123.45')).toBeInTheDocument();
    unmount();
    renderWith(
      <PromoForm
        promo={{ code: 'MIN500', valid: false, reason: 'min_order', minOrder: 50_000, discount: 0 }}
      />,
    );
    expect(screen.getByText(/Code MIN500 no longer applies/)).toHaveTextContent(
      'Minimum order amount for this code is ₴500.00.',
    );
  });

  it('does not send an empty code', async () => {
    const calls = mockFetch(() => json(200, {}));
    renderWith(<PromoForm promo={null} />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });
});
