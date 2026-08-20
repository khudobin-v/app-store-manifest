import { cookies } from 'next/headers';

/**
 * Авторизация магазина: обычный вход по паролю для человека и токен для CI.
 *
 * Пароль и секрет подписи живут в переменных окружения Vercel и никогда не
 * попадают в браузер: наружу уходит только подписанная кука сессии.
 */

const COOKIE_NAME = 'store_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // месяц

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`не задана переменная окружения ${name}`);
  return value;
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
 * Пароль сравнивается без хвостовых пробелов с обеих сторон: значение в
 * переменной окружения легко сохраняется с переводом строки (так делает и
 * ввод в CLI, и вставка из буфера), а пользователь его не набирает — и вход
 * молча отвергался как «неверный пароль».
 */
export function checkPassword(password: string): boolean {
  return constantTimeEquals(password.trim(), requiredEnv('STORE_PASSWORD').trim());
}

export async function createSession(): Promise<void> {
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = String(expiresAt);
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

export async function hasValidSession(): Promise<boolean> {
  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  if (!cookie) return false;

  const [payload, signature] = cookie.split('.');
  if (!payload || !signature) return false;
  if (!constantTimeEquals(signature, await hmac(payload))) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
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
