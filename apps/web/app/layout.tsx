import type { ReactNode } from 'react';

// <html> and <body> are rendered per locale in app/[locale]/layout.tsx
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
