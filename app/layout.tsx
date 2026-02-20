import type { Metadata } from 'next';
import { Roboto, Roboto_Condensed } from 'next/font/google';
import './globals.css';

const bodyFont = Roboto({
  variable: '--font-body',
  subsets: ['latin'],
  weight: ['300', '400', '500', '700', '900'],
});

const displayFont = Roboto_Condensed({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['400', '700', '900'],
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
