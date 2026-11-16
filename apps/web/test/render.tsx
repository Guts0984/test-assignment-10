import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import en from '../messages/en.json';
import uk from '../messages/uk.json';

export const MESSAGES = { en, uk } as const;

export function renderWith(ui: ReactElement, { locale = 'en' }: { locale?: 'en' | 'uk' } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </NextIntlClientProvider>,
    ),
  };
}

/** Replaces global fetch with a scripted fake; returns the calls it saw. */
export function mockFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const calls: {
    url: string;
    init: RequestInit | undefined;
    body: unknown;
    headers: Record<string, string>;
  }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      init,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return handler(u, init);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
