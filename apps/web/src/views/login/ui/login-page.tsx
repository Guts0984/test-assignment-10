'use client';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { LoginForm } from '@/features/login';
import { useRouter } from '@/shared/i18n/navigation';
import { safeNext } from '@/shared/lib/safe-redirect';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui';

export function LoginPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <LoginForm onSuccess={() => router.replace(next)} />
        </CardContent>
      </Card>
    </div>
  );
}
