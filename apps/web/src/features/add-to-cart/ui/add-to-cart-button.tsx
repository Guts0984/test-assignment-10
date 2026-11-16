'use client';
import { ShoppingCart } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ProductDto } from '@shop/shared';
import { useCart, usePutCartItem } from '@/entities/cart';
import { useMe } from '@/entities/session';
import { usePathname, useRouter } from '@/shared/i18n/navigation';
import { Button } from '@/shared/ui';

export function AddToCartButton({
  product,
}: {
  product: Pick<ProductDto, 'id' | 'name' | 'stock'>;
}) {
  const t = useTranslations('catalog');
  const me = useMe();
  const cart = useCart(me.data?.role === 'customer');
  const put = usePutCartItem();
  const router = useRouter();
  const pathname = usePathname();

  if (me.data?.role === 'manager') return null;
  const inCart = cart.data?.lines.find((l) => l.productId === product.id)?.qty ?? 0;
  const disabled = product.stock <= 0 || put.isPending;

  return (
    <Button
      size="sm"
      disabled={disabled}
      aria-label={`${t('addToCart')}: ${product.name}`}
      onClick={() => {
        if (!me.data) {
          router.push(`/login?next=${encodeURIComponent(pathname)}`);
          return;
        }
        put.mutate({ productId: product.id, qty: Math.min(inCart + 1, 999) });
      }}
    >
      <ShoppingCart aria-hidden className="h-4 w-4" />
      {put.isSuccess && !put.isPending ? t('added') : t('addToCart')}
      {inCart > 0 ? ` (${inCart})` : ''}
    </Button>
  );
}
