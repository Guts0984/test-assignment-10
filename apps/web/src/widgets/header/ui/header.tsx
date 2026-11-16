'use client';
import { ShoppingCart, Store } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cartItemCount, useCart } from '@/entities/cart';
import { useLogout, useMe } from '@/entities/session';
import { LocaleSwitcher } from '@/features/locale-switcher';
import { ThemeSwitcher } from '@/features/theme-switcher';
import { Link, useRouter } from '@/shared/i18n/navigation';
import { Button } from '@/shared/ui';

export function Header() {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const me = useMe();
  const isCustomer = me.data?.role === 'customer';
  const cart = useCart(isCustomer);
  const logout = useLogout();
  const router = useRouter();
  const count = cartItemCount(cart.data);

  const link =
    'rounded px-2 py-1 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold">
          <Store aria-hidden className="h-5 w-5" />
          {tc('appName')}
        </Link>
        <nav aria-label={t('main')} className="flex flex-1 flex-wrap items-center gap-1">
          <Link href="/" className={link}>
            {t('catalog')}
          </Link>
          {isCustomer ? (
            <>
              <Link href="/orders" className={link}>
                {t('orders')}
              </Link>
              <Link href="/cart" className={`${link} inline-flex items-center gap-1`}>
                <ShoppingCart aria-hidden className="h-4 w-4" />
                {t('cart')}
                {count > 0 ? (
                  <span
                    data-testid="cart-count"
                    className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground"
                  >
                    {count}
                  </span>
                ) : null}
              </Link>
            </>
          ) : null}
          {me.data?.role === 'manager' ? (
            <>
              <Link href="/manager/products" className={link}>
                {t('products')}
              </Link>
              <Link href="/manager/orders" className={link}>
                {t('ordersManage')}
              </Link>
              <Link href="/manager/promos" className={link}>
                {t('promos')}
              </Link>
              <Link href="/manager/reports" className={link}>
                {t('reports')}
              </Link>
            </>
          ) : null}
        </nav>
        <LocaleSwitcher />
        <ThemeSwitcher />
        {me.data ? (
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">{me.data.email}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => logout.mutate(undefined, { onSettled: () => router.push('/') })}
            >
              {t('logout')}
            </Button>
          </div>
        ) : me.isSuccess ? (
          <Button asChild size="sm">
            <Link href="/login">{t('login')}</Link>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
