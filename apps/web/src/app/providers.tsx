'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { isApiError } from '@/shared/api/client';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // client mistakes (4xx) will not fix themselves; network / server hiccups are worth a retry
            retry: (count, error) =>
              isApiError(error) && error.status >= 400 && error.status < 500 ? false : count < 2,
            refetchOnWindowFocus: true,
            staleTime: 15_000,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
