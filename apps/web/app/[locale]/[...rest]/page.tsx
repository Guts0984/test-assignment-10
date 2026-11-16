import { notFound } from 'next/navigation';

/**
 * Any URL under a language that matches no page ends up here, so it is answered by this app's own
 * localized not-found page (inside the normal header/layout) instead of Next's bare, English-only 404.
 */
export default function CatchAll() {
  notFound();
}
