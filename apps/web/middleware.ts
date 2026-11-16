import createMiddleware from 'next-intl/middleware';
import { routing } from './src/shared/i18n/routing';

export default createMiddleware(routing);

export const config = {
  // everything except api, next internals and files with an extension
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
