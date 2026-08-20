import { NextResponse } from 'next/server';
import { createSession, login as authenticate } from '@/lib/auth';

/** Вход по логину и паролю; учётки лежат в Blob, пароли — хешами PBKDF2. */
export async function POST(request: Request) {
  let login = '';
  let password = '';
  try {
    const body = (await request.json()) as { login?: string; password?: string };
    login = body.login ?? '';
    password = body.password ?? '';
  } catch {
    return NextResponse.json({ error: 'ожидался JSON' }, { status: 400 });
  }

  // Небольшая задержка против перебора.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const session = await authenticate(login, password);
  if (!session) {
    return NextResponse.json({ error: 'неверный логин или пароль' }, { status: 401 });
  }

  await createSession(session);
  return NextResponse.json({ ok: true, ...session });
}
