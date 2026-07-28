import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Flashmandu App',
  description: 'Flashmandu storefront app (Next.js template).',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem' }}>{children}</body>
    </html>
  );
}
