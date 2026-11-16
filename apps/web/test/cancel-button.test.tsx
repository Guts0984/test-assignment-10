import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CancelButton } from '@/features/cancel-order';
import { json, mockFetch, renderWith } from './render';

const ID = '6f1c2a54-6a45-4d1c-9a62-0d3f4c1b2a10';

async function openConfirm() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Cancel order' }));
  return user;
}

describe('<CancelButton />', () => {
  it('a REFUSED cancel (409, the order shipped meanwhile) stays on screen with the reason', async () => {
    mockFetch((url) =>
      url.endsWith('/cancel')
        ? json(409, { error: { code: 'conflict', message: 'x' } })
        : json(200, {}),
    );
    renderWith(<CancelButton orderId={ID} />);
    const user = await openConfirm();
    await user.click(screen.getByRole('button', { name: 'Yes, cancel' }));
    expect(await screen.findByText(/cannot be cancelled any more/)).toBeInTheDocument();
    // the confirmation panel is still there (it used to vanish, leaving no trace of the failure)
    expect(screen.getByRole('button', { name: 'Yes, cancel' })).toBeInTheDocument();
  });

  it('any other failure shows the generic error and also stays', async () => {
    mockFetch(() => json(500, { error: { code: 'internal', message: 'x' } }));
    renderWith(<CancelButton orderId={ID} />);
    const user = await openConfirm();
    await user.click(screen.getByRole('button', { name: 'Yes, cancel' }));
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, cancel' })).toBeInTheDocument();
  });

  it('a successful cancel closes the panel; "No" closes it without calling the server', async () => {
    const calls = mockFetch(() => json(200, { id: ID, status: 'cancelled' }));
    renderWith(<CancelButton orderId={ID} />);
    let user = await openConfirm();
    await user.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    user = await openConfirm();
    await user.click(screen.getByRole('button', { name: 'Yes, cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Yes, cancel' })).not.toBeInTheDocument(),
    );
    expect(calls).toHaveLength(1);
  });
});
