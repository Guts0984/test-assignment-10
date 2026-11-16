'use client';
import { useTranslations } from 'next-intl';
import {
  cartBlocksCheckout,
  displayTotals,
  TotalsList,
  useAcceptPrices,
  useCart,
} from '@/entities/cart';
import { PromoForm } from '@/features/apply-promo';
import { CartLines } from '@/features/cart-lines';
import { Link } from '@/shared/i18n/navigation';
import { Alert, Button, Card, CardContent, Skeleton } from '@/shared/ui';
import { RequireRole } from '@/widgets/require-role';

function CartContent() {
  const t = useTranslations('cart');
  const tc = useTranslations('common');
  const cart = useCart();
  const accept = useAcceptPrices();

  if (cart.isPending) return <Skeleton className="h-40" />;
  if (cart.isError) {
    return (
      <Alert tone="danger">
        {tc('error')}{' '}
        <Button variant="link" onClick={() => void cart.refetch()}>
          {tc('retry')}
        </Button>
      </Alert>
    );
  }
  const c = cart.data;
  if (c.lines.length === 0) {
    return (
      <div className="grid gap-3">
        <p>{t('empty')}</p>
        <Button asChild className="w-fit">
          <Link href="/">{t('goShopping')}</Link>
        </Button>
      </div>
    );
  }
  const totals = displayTotals(c, 'pickup');
  const blocked = cartBlocksCheckout(c);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="grid gap-4">
        {c.hasPriceChanges ? (
          <Alert tone="warning">
            <p className="font-medium">{t('priceChangedTitle')}</p>
            <p>{t('priceChangedText')}</p>
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              disabled={accept.isPending}
              onClick={() => accept.mutate()}
            >
              {t('acceptPrices')}
            </Button>
          </Alert>
        ) : null}
        {c.hasStockProblems ? (
          <Alert tone="danger">
            <p className="font-medium">{t('stockProblemTitle')}</p>
            <p>{t('fixStock')}</p>
          </Alert>
        ) : null}
        <CartLines lines={c.lines} />
      </div>
      <Card className="h-fit">
        <CardContent className="grid gap-4 pt-4 sm:pt-6">
          <PromoForm promo={c.promo} />
          <TotalsList totals={totals} deliveryPending />
          <p className="text-xs text-muted-foreground">{t('deliveryFrom')}</p>
          {blocked ? (
            <Button disabled>{t('checkout')}</Button>
          ) : (
            <Button asChild>
              <Link href="/checkout">{t('checkout')}</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function CartPage() {
  const t = useTranslations('cart');
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <RequireRole role="customer">
        <CartContent />
      </RequireRole>
    </div>
  );
}
