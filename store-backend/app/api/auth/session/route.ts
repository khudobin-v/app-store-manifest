import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await currentSession();
  return NextResponse.json({ authorized: session !== null, ...(session ?? {}) });
}
