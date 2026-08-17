import { NextResponse } from 'next/server';
import { hasValidSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ authorized: await hasValidSession() });
}
