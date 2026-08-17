import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Личный магазин приложений',
  description: 'Витрина и загрузка APK',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
