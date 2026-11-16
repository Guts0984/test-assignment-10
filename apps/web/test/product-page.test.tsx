import { screen } from '@testing-library/react';
import type { ProductDto } from '@shop/shared';
import { ProductGrid } from '@/widgets/product-grid';
import { ProductPage } from '@/views/product';
import { json, mockFetch, renderWith } from './render';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/shared/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => '/',
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

const product: ProductDto = {
  id: '6f1c2a54-6a45-4d1c-9a62-0d3f4c1b2a10',
  name: 'Compact Backpack 224',
  categoryId: '11111111-1111-4111-8111-111111111111',
  categoryName: 'Sports',
  categorySlug: 'sports',
  price: 123_450,
  stock: 7,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const me = (url: string) =>
  url.includes('/auth/me') ? json(401, { error: { code: 'unauthorized', message: 'x' } }) : null;

describe('<ProductPage />', () => {
  it('shows name, category, price and stock; fetches exactly that product', async () => {
    const calls = mockFetch((url) => me(url) ?? json(200, product));
    renderWith(<ProductPage id={product.id} />);
    expect(
      await screen.findByRole('heading', { name: 'Compact Backpack 224' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Sports/)).toBeInTheDocument();
    expect(screen.getByText(/1,234\.50/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith(`/products/${product.id}`))).toBe(true);
  });
  it('a missing product (404) and a malformed id (400) show "not found", not a crash', async () => {
    for (const status of [404, 400]) {
      mockFetch((url) => me(url) ?? json(status, { error: { code: 'not_found', message: 'x' } }));
      const { unmount } = renderWith(<ProductPage id="nope" />);
      expect(await screen.findByText('Product not found')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Back to catalog/ })).toBeInTheDocument();
      unmount();
    }
  });
  it('a server failure is an error, not "not found"', async () => {
    mockFetch((url) => me(url) ?? json(500, { error: { code: 'internal', message: 'x' } }));
    renderWith(<ProductPage id={product.id} />);
    expect(
      await screen.findByText(/Something went wrong/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });
  it('the id is URL-encoded, so a hostile id cannot change the request path', async () => {
    const calls = mockFetch(
      (url) => me(url) ?? json(404, { error: { code: 'not_found', message: 'x' } }),
    );
    renderWith(<ProductPage id="../auth/logout?x=1" />);
    await screen.findByText('Product not found');
    expect(
      calls.some((c) => c.url.includes('%2F..') || c.url.endsWith('..%2Fauth%2Flogout%3Fx%3D1')),
    ).toBe(true);
    expect(calls.some((c) => c.url.includes('/auth/logout'))).toBe(false);
  });
});

describe('catalog card', () => {
  it('the product name links to its page', async () => {
    mockFetch((url) => me(url) ?? json(200, { items: [product], nextCursor: null }));
    renderWith(<ProductGrid />);
    const link = await screen.findByRole('link', { name: 'Compact Backpack 224' });
    expect(link).toHaveAttribute('href', expect.stringContaining(`/products/${product.id}`));
  });
});
