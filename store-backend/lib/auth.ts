import { cookies } from 'next/headers';
import { authenticate, type Role, type User } from './users';

/**
 * Сессии магазина.
 *
 * Человек входит логином и паролем (учётки в lib/users.ts), CI — токеном.
 * Владелец дополнительно может войти как `OWNER_LOGIN` с паролем из
 * STORE_PASSWORD: это страховка от потери доступа, когда учёток ещё нет или
 * последняя из них удалена.
 */

const COOKIE_NAME = 'store_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // месяц

export interface Session {
  login: string;
  role: Role;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`не задана переменная окружения ${name}`);
  return value;
}

export function ownerLogin(): string {
  return (process.env.OWNER_LOGIN ?? 'owner').trim().toLowerCase();
}

const encoder = new TextEncoder();

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(requiredEnv('SESSION_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Buffer.from(signature).toString('base64url');
}

/** Сравнение без утечки времени: пароль подбирать по таймингу не выйдет. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/**
 * Вход. Сначала учётные записи, затем аварийный вход владельца по
 * STORE_PASSWORD. Хвостовые пробелы срезаются: значение в переменной окружения
 * легко сохраняется с переводом строки, и вход отвергался бы как неверный.
 */
export async function login(loginName: string, password: string): Promise<Session | null> {
  const name = loginName.trim().toLowerCase();

  const user: User | null = await authenticate(name, password).catch(() => null);
  if (user) return { login: user.login, role: user.role };

  const fallbackPassword = process.env.STORE_PASSWORD?.trim();
  if (name === ownerLogin() && fallbackPassword && constantTimeEquals(password.trim(), fallbackPassword)) {
    return { login: name, role: 'owner' };
  }

  return null;
}

export async function createSession(session: Session): Promise<void> {
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = `${session.login}|${session.role}|${expiresAt}`;
  const value = `${payload}.${await hmac(payload)}`;

  (await cookies()).set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  (await cookies()).delete(COOKIE_NAME);
}

export async function currentSession(): Promise<Session | null> {
  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  if (!cookie) return null;

  const separator = cookie.lastIndexOf('.');
  if (separator < 0) return null;
  const payload = cookie.slice(0, separator);
  const signature = cookie.slice(separator + 1);
  if (!constantTimeEquals(signature, await hmac(payload))) return null;

  const [loginName, role, expiresAt] = payload.split('|');
  if (!loginName || (role !== 'owner' && role !== 'publisher')) return null;
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= Date.now()) return null;

  return { login: loginName, role };
}

export async function hasValidSession(): Promise<boolean> {
  return (await currentSession()) !== null;
}

export async function isOwner(): Promise<boolean> {
  return (await currentSession())?.role === 'owner';
}

/** CI ходит с токеном: логин-форму на раннере не показать. */
export function hasPublishToken(request: Request): boolean {
  const header = request.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  return constantTimeEquals(token, requiredEnv('PUBLISH_TOKEN').trim());
}

export async function isAuthorized(request: Request): Promise<boolean> {
  return hasPublishToken(request) || (await hasValidSession());
}
