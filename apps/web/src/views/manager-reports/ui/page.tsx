'use client';
import { useTranslations } from 'next-intl';
import { RequireRole } from '@/widgets/require-role';
import { SalesReport } from '@/widgets/sales-report';

export function ManagerReportsPage() {
  const t = useTranslations('manager.reports');
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <RequireRole role="manager">
        <SalesReport />
      </RequireRole>
    </div>
  );
}
