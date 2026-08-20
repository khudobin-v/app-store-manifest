import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';
import { deleteVersion, readAppOwners } from '@/lib/catalog';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; code: string }> },
) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: 'нужна авторизация' }, { status: 401 });

  const { id, code } = await context.params;
  if (session.role !== 'owner') {
    const owners = await readAppOwners(id);
    if (owners.size !== 1 || !owners.has(session.login)) {
      return NextResponse.json({ error: 'приложение опубликовано не вами' }, { status: 403 });
    }
  }
  const removed = await deleteVersion(id, Number(code));
  if (!removed) return NextResponse.json({ error: 'версия не найдена' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
