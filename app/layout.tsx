import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Rap 2.0 - Freestyle 1v1',
  description: 'Batallas de freestyle en tiempo real',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎤</text></svg>" />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
