import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';
import { deleteUser, setPassword } from '@/lib/users';

export const dynamic = 'force-dynamic';

/** Пароль может сменить владелец кому угодно, остальные — только себе. */
export async function PATCH(request: Request, context: { params: Promise<{ login: string }> }) {
  const session = await currentSession();
  const { login } = await context.params;
  if (!session || (session.role !== 'owner' && session.login !== login)) {
    return NextResponse.json({ error: 'нет прав' }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { password?: string };
  try {
    await setPassword(login, body.password ?? '');
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ login: string }> }) {
  const session = await currentSession();
  if (session?.role !== 'owner') {
    return NextResponse.json({ error: 'только для владельца' }, { status: 403 });
  }

  const { login } = await context.params;
  if (login === session.login) {
    return NextResponse.json({ error: 'нельзя удалить самого себя' }, { status: 400 });
  }

  const removed = await deleteUser(login);
  if (!removed) return NextResponse.json({ error: 'пользователь не найден' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
