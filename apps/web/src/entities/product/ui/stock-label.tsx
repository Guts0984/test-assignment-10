import { useTranslations } from 'next-intl';
import { Badge } from '@/shared/ui';

export function StockLabel({ stock }: { stock: number }) {
  const t = useTranslations('catalog');
  if (stock <= 0) return <Badge tone="danger">{t('outOfStock')}</Badge>;
  if (stock <= 5) return <Badge tone="warning">{t('lowStock', { count: stock })}</Badge>;
  return <span className="text-xs text-muted-foreground">{t('inStock', { count: stock })}</span>;
}
