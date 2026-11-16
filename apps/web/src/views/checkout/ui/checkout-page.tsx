'use client';
import { useTranslations } from 'next-intl';
import { useCart } from '@/entities/cart';
import { CheckoutForm } from '@/features/checkout';
import { Link, useRouter } from '@/shared/i18n/navigation';
import { Alert, Button, Skeleton } from '@/shared/ui';
import { RequireRole } from '@/widgets/require-role';

function CheckoutContent() {
  const t = useTranslations('checkout');
  const tc = useTranslations('common');
  const router = useRouter();
  const cart = useCart();
  if (cart.isPending) return <Skeleton className="h-40" />;
  if (cart.isError) return <Alert tone="danger">{tc('error')}</Alert>;
  if (cart.data.lines.length === 0) {
    return (
      <div className="grid gap-3">
        <p>{t('emptyCart')}</p>
        <Button asChild className="w-fit">
          <Link href="/">{tc('back')}</Link>
        </Button>
      </div>
    );
  }
  return (
    <CheckoutForm cart={cart.data} onCreated={(order) => router.push(`/orders/${order.id}`)} />
  );
}

export function CheckoutPage() {
  const t = useTranslations('checkout');
  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <RequireRole role="customer">
        <CheckoutContent />
      </RequireRole>
    </div>
  );
}
