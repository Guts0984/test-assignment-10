import { useTranslations } from 'next-intl';

export default function NotFound() {
  const t = useTranslations('common');
  return <h1 className="text-xl font-semibold">{t('notFound')}</h1>;
}
