import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

/**
 * Собственные шрифты Linear не распространяются публично; в самой спецификации
 * рекомендованы открытые замены — Inter для текста и JetBrains Mono для кода.
 */
const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Личный магазин приложений',
  description: 'Витрина и загрузка APK',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${inter.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
