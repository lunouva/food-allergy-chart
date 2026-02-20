import type { Metadata } from 'next';
import { Inter, Montserrat } from 'next/font/google';
import './globals.css';

const bodyFont = Inter({
  variable: '--font-body',
  subsets: ['latin'],
});

const displayFont = Montserrat({
  variable: '--font-display',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Food Allergy Chart (Cold Stone reference)',
  description: 'Build a printable food allergies & sensitivities chart from Cold Stone Creamery reference data.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${bodyFont.variable} ${displayFont.variable}`}>{children}</body>
    </html>
  );
}
