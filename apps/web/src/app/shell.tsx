import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { THEME_INIT_SCRIPT } from '@/shared/lib/theme';
import { Header } from '@/widgets/header';
import { Providers } from './providers';

/** Everything around every page: intl + query providers, skip link, header, main landmark. */
export async function Shell({ locale, children }: { locale: string; children: ReactNode }) {
  const messages = await getMessages();
  const t = await getTranslations('common');
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <Providers>
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring"
            >
              {t('skipToContent')}
            </a>
            <Header />
            <main
              id="main"
              tabIndex={-1}
              className="mx-auto max-w-6xl px-4 py-6 focus:outline-none"
            >
              {children}
            </main>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
