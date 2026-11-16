/** Same-site path only ("/uk/orders/1"): protocol-relative, absolute and backslash tricks are refused. */
export const isSameSitePath = (v: string | null | undefined): v is string =>
  !!v && /^\/(?![/\\])[^\s]*$/.test(v);

/** Post-login target taken from ?next=. Anything suspicious becomes "/". */
export const safeNext = (next: string | null): string => (isSameSitePath(next) ? next : '/');

/** Where the payment stub sends the customer back to. */
export const safeReturnUrl = (v: string | null): string | null => (isSameSitePath(v) ? v : null);
