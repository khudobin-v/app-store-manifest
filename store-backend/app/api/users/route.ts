import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';
import { createUser, listUsers, type Role } from '@/lib/users';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await currentSession();
  if (session?.role !== 'owner') {
    return NextResponse.json({ error: 'только для владельца' }, { status: 403 });
  }
  return NextResponse.json({ users: await listUsers() });
}

export async function POST(request: Request) {
  const session = await currentSession();
  if (session?.role !== 'owner') {
    return NextResponse.json({ error: 'только для владельца' }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    login?: string;
    password?: string;
    role?: Role;
  };

  try {
    const user = await createUser({
      login: body.login ?? '',
      password: body.password ?? '',
      role: body.role === 'owner' ? 'owner' : 'publisher',
      createdBy: session.login,
    });
    return NextResponse.json({ ok: true, user });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
