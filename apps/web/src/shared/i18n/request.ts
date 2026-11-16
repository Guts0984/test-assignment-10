import { getRequestConfig } from 'next-intl/server';
import { isLocale, DEFAULT_LOCALE } from '../config/locales';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = requested && isLocale(requested) ? requested : DEFAULT_LOCALE;
  return {
    locale,
    messages: (await import(`../../../messages/${locale}.json`)).default as Record<string, unknown>,
  };
});
