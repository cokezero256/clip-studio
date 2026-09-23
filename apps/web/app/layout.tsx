import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Clip Studio',
  description: 'Link in, client-ready short-form clips out.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg-1 text-fg-1 antialiased">{children}</body>
    </html>
  );
}
