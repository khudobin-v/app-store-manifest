import { NextResponse } from 'next/server';
import { hasValidSession } from '@/lib/auth';
import { deleteVersion } from '@/lib/catalog';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; code: string }> },
) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'нужна авторизация' }, { status: 401 });
  }

  const { id, code } = await context.params;
  const removed = await deleteVersion(id, Number(code));
  if (!removed) return NextResponse.json({ error: 'версия не найдена' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
