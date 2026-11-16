import { redirect } from 'next/navigation';
import { DEFAULT_LOCALE } from '@/shared/config/locales';

// middleware normally redirects "/" to the right locale; this is the safety net
export default function Root() {
  redirect(`/${DEFAULT_LOCALE}`);
}
