'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * QR со ссылкой на APK: телефон наводит камеру и скачивает файл напрямую.
 *
 * Рисуется в SVG на клиенте, поэтому подхватывает цвета темы и остаётся
 * чётким на любом экране. Внешние сервисы не используются: ссылка на витрину
 * не должна утекать третьей стороне.
 */
export function QrCode({ value, size = 148 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toString(value, {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#00000000' },
    }).then((result) => {
      if (!cancelled) setSvg(result);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!svg) return <div className="qr-frame" style={{ width: size, height: size }} />;

  return (
    <div
      className="qr-frame"
      style={{ width: size, height: size }}
      // Разметка приходит из библиотеки QR, не из пользовательского ввода.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
