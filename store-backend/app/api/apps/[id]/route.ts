import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';
import { deleteApp, readAppOwners, writeMeta } from '@/lib/catalog';

export const dynamic = 'force-dynamic';

/**
 * Правки и удаление — только человеку из панели, не CI-токену.
 * Владелец распоряжается всем, издатель — только приложениями, которые
 * публиковал сам.
 */
async function guard(id: string): Promise<NextResponse | null> {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: 'нужна авторизация' }, { status: 401 });
  if (session.role === 'owner') return null;

  const owners = await readAppOwners(id);
  if (owners.size === 1 && owners.has(session.login)) return null;

  return NextResponse.json({ error: 'приложение опубликовано не вами' }, { status: 403 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const denied = await guard(id);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    iconUrl?: string | null;
    hidden?: boolean;
  };

  await writeMeta(id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}),
    ...(body.hidden !== undefined ? { hidden: body.hidden } : {}),
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const denied = await guard(id);
  if (denied) return denied;
  const removed = await deleteApp(id);
  return NextResponse.json({ ok: true, removedVersions: removed });
}
