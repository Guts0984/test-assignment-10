import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import '@/app/styles.css';
import { Shell } from '@/app/shell';
import { isLocale, LOCALES } from '@/shared/config/locales';

// pages read the URL (filters, ?next=, ?returnUrl=) and the session: render per request
export const dynamic = 'force-dynamic';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  return <Shell locale={locale}>{children}</Shell>;
}
