import { NextResponse } from 'next/server';
import { hasValidSession } from '@/lib/auth';
import { readStats } from '@/lib/catalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'нужна авторизация' }, { status: 401 });
  }
  return NextResponse.json(await readStats());
}
