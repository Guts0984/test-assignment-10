import { screen, waitFor } from '@testing-library/react';
import { OrderPage } from '@/views/order';
import { parseCatalogParams } from '@/features/catalog-filters';
import { json, mockFetch, renderWith } from './render';

const replace = vi.fn();
vi.mock('@/shared/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  usePathname: () => '/orders/6f1c2a54-6a45-4d1c-9a62-0d3f4c1b2a10',
  useRouter: () => ({ push: () => undefined, replace }),
}));

describe('<OrderPage /> for a visitor', () => {
  it('sends them to the login and brings them back to this order, instead of showing a load error', async () => {
    mockFetch(() => json(401, { error: { code: 'unauthorized', message: 'x' } }));
    renderWith(<OrderPage id="6f1c2a54-6a45-4d1c-9a62-0d3f4c1b2a10" />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        '/login?next=%2Forders%2F6f1c2a54-6a45-4d1c-9a62-0d3f4c1b2a10',
      ),
    );
    expect(screen.queryByText('Could not load the order.')).not.toBeInTheDocument();
  });
});

describe('catalogue search text from the URL', () => {
  it('control characters (a crafted link) are removed, normal text including unicode is kept', () => {
    const sp = (q: string) => new URLSearchParams({ q });
    expect(parseCatalogParams(sp('a\u0000b')).q).toBe('ab');
    expect(parseCatalogParams(sp('line1\nline2\ttab')).q).toBe('line1line2tab');
    expect(parseCatalogParams(sp('Кава «Арабіка» 🙂 100%')).q).toBe('Кава «Арабіка» 🙂 100%');
    expect(parseCatalogParams(sp('x'.repeat(300))).q).toHaveLength(100);
  });
});
