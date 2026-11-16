'use client';
import { useTranslations } from 'next-intl';
import { useEffect, type ReactNode } from 'react';
import type { Role } from '@shop/shared';
import { useMe } from '@/entities/session';
import { usePathname, useRouter } from '@/shared/i18n/navigation';
import { Alert, Skeleton } from '@/shared/ui';

/**
 * UX gate only: visitors are sent to the login page, wrong roles see a notice.
 * The real protection is on the server - every endpoint checks the session and the role.
 */
export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('common');
  const tAuth = useTranslations('auth');

  useEffect(() => {
    if (me.isSuccess && me.data === null)
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [me.isSuccess, me.data, router, pathname]);

  if (me.isPending) return <Skeleton className="h-40 w-full" />;
  if (me.isError) return <Alert tone="danger">{t('error')}</Alert>;
  if (me.data === null) return <p>{tAuth('needLogin')}</p>;
  if (me.data?.role !== role) return <Alert tone="warning">{t('forbidden')}</Alert>;
  return <>{children}</>;
}
