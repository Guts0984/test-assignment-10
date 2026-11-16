/** Same-site path only ("/uk/orders/1"): protocol-relative, absolute and backslash tricks are refused. */
export const isSameSitePath = (v: string | null | undefined): v is string =>
  !!v && /^\/(?![/\\])[^\s]*$/.test(v);

const LOCALE_PREFIX = /^\/(?:uk|en)(?=[/?#]|$)/;
const LOGIN_PATH = /^\/login(?:[/?#]|$)/;

/**
 * Post-login target taken from ?next=, as a path WITHOUT the language ("/orders"): the router adds
 * the language itself, so "/en/orders" would otherwise become "/en/en/orders" (a 404). A leading
 * language is stripped, the login page itself is no destination (the form would just reappear),
 * and anything suspicious - checked again AFTER stripping, "/en//evil.example" - becomes "/".
 */
export const safeNext = (next: string | null): string => {
  if (!isSameSitePath(next)) return '/';
  const stripped = next.replace(LOCALE_PREFIX, '');
  const path = stripped.startsWith('/') ? stripped : `/${stripped}`;
  if (!isSameSitePath(path) || LOGIN_PATH.test(path)) return '/';
  return path;
};

/** Where the payment stub sends the customer back to. */
export const safeReturnUrl = (v: string | null): string | null => (isSameSitePath(v) ? v : null);
