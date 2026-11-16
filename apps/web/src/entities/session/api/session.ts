import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { LoginInput, Me } from '@shop/shared';
import { apiFetch, isApiError } from '@/shared/api/client';

export const meKey = ['me'] as const;

const dropAllExceptMe = (qc: QueryClient) =>
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== meKey[0] });

/** The signed-in user, or null for visitors. A 401 is a normal state here, not an error. */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await apiFetch<Me>('/me');
      } catch (e) {
        if (isApiError(e) && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => apiFetch<Me>('/auth/login', { method: 'POST', body: input }),
    onSuccess: (me) => {
      // nothing cached for the previous visitor may leak into the new session. Not qc.clear(): that would
      // detach the header's live "me" observer and it would never show the signed-in state.
      dropAllExceptMe(qc);
      qc.setQueryData(meKey, me);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/auth/logout', { method: 'POST', body: {} }),
    onSettled: () => {
      dropAllExceptMe(qc);
      qc.setQueryData(meKey, null);
    },
  });
}
