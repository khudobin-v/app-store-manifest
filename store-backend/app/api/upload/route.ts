import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { hasValidSession } from '@/lib/auth';

/**
 * Выдаёт браузеру короткоживущий токен на прямую загрузку APK в Blob.
 *
 * Через функцию файл не пропускаем: у serverless-запроса лимит 4.5 МБ, а APK
 * бывают в десятки мегабайт. Клиент льёт файл прямо в хранилище.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        if (!(await hasValidSession())) throw new Error('нужна авторизация');
        return {
          allowedContentTypes: ['application/vnd.android.package-archive', 'application/octet-stream', 'image/png'],
          addRandomSuffix: false,
          allowOverwrite: true,
          maximumSizeInBytes: 512 * 1024 * 1024,
        };
      },
      onUploadCompleted: async () => {
        // Каталог обновляет отдельный запрос POST /api/apps: там проверяется
        // версия, и только после этого запись попадает в витрину.
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
