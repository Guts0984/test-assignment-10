'use client';
import { useTranslations } from 'next-intl';
import { ManagerProductsTable } from '@/widgets/manager-products-table';
import { RequireRole } from '@/widgets/require-role';

export function ManagerProductsPage() {
  const t = useTranslations('manager.products');
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <RequireRole role="manager">
        <ManagerProductsTable />
      </RequireRole>
    </div>
  );
}
