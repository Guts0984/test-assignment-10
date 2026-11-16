'use client';
import { useTranslations } from 'next-intl';
import { ManagerOrdersTable } from '@/widgets/manager-orders-table';
import { RequireRole } from '@/widgets/require-role';

export function ManagerOrdersPage() {
  const t = useTranslations('manager.orders');
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <RequireRole role="manager">
        <ManagerOrdersTable />
      </RequireRole>
    </div>
  );
}
