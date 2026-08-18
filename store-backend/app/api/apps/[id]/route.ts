import { NextResponse } from 'next/server';
import { hasValidSession } from '@/lib/auth';
import { deleteApp, writeMeta } from '@/lib/catalog';

export const dynamic = 'force-dynamic';

/** Правки и удаление доступны только человеку из панели, не CI-токену. */
async function guard(): Promise<NextResponse | null> {
  if (await hasValidSession()) return null;
  return NextResponse.json({ error: 'нужна авторизация' }, { status: 401 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await guard();
  if (denied) return denied;

  const { id } = await context.params;
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
  const denied = await guard();
  if (denied) return denied;

  const { id } = await context.params;
  const removed = await deleteApp(id);
  return NextResponse.json({ ok: true, removedVersions: removed });
}
