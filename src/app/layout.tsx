import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CarbonBoard',
  description: 'Windows Soundboard App',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans">
        {children}
      </body>
    </html>
  );
}
