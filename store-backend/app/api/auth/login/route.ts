import { NextResponse } from 'next/server';
import { checkPassword, createSession } from '@/lib/auth';

/** Обычный вход по паролю: пароль лежит в переменных окружения Vercel. */
export async function POST(request: Request) {
  let password = '';
  try {
    const body = (await request.json()) as { password?: string };
    password = body.password ?? '';
  } catch {
    return NextResponse.json({ error: 'ожидался JSON' }, { status: 400 });
  }

  // Небольшая задержка против перебора: вход всё равно однопользовательский.
  await new Promise((resolve) => setTimeout(resolve, 300));

  if (!password || !checkPassword(password)) {
    return NextResponse.json({ error: 'неверный пароль' }, { status: 401 });
  }

  await createSession();
  return NextResponse.json({ ok: true });
}
