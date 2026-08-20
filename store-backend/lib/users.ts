import { del, list, put } from '@vercel/blob';

/**
 * Учётные записи магазина.
 *
 * Хранятся по файлу на пользователя (`users/<login>.json`) в том же Blob:
 * отдельного хранилища заводить не нужно, а запись одного пользователя не
 * трогает остальных — той гонки с потерянными обновлениями, что была у общего
 * каталога, здесь не возникает.
 *
 * Пароли лежат хешами PBKDF2-SHA256 со случайной солью. В открытом виде пароль
 * существует только в момент проверки.
 */

const PREFIX = 'users/';
const ITERATIONS = 210_000;
const KEY_BITS = 256;

export type Role = 'owner' | 'publisher';

export interface User {
  login: string;
  role: Role;
  createdAt: string;
  /** Кто завёл учётку: владелец или сам себя (при первом запуске). */
  createdBy?: string;
}

interface StoredUser extends User {
  salt: string;
  hash: string;
  iterations: number;
}

const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;

export function isValidLogin(login: string): boolean {
  return LOGIN_RE.test(login);
}

function toBase64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64');
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return toBase64(bits);
}

export async function hashPassword(password: string): Promise<Pick<StoredUser, 'salt' | 'hash' | 'iterations'>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    salt: toBase64(salt.buffer as ArrayBuffer),
    hash: await derive(password, salt, ITERATIONS),
    iterations: ITERATIONS,
  };
}

export async function verifyPassword(password: string, stored: StoredUser): Promise<boolean> {
  const salt = new Uint8Array(Buffer.from(stored.salt, 'base64'));
  const hash = await derive(password, salt, stored.iterations);
  // Сравнение постоянного времени: длина хешей одинакова.
  const a = new TextEncoder().encode(hash);
  const b = new TextEncoder().encode(stored.hash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function pathFor(login: string): string {
  return `${PREFIX}${login}.json`;
}

async function readStored(login: string): Promise<StoredUser | null> {
  const found = await list({ prefix: pathFor(login), limit: 1 });
  const blob = found.blobs.find((entry) => entry.pathname === pathFor(login));
  if (!blob) return null;

  // ?v= — файл перезаписывается при смене пароля, из CDN может прийти старое.
  const response = await fetch(`${blob.url}?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) return null;
  return (await response.json()) as StoredUser;
}

export async function findUser(login: string): Promise<User | null> {
  const stored = await readStored(login.trim().toLowerCase());
  if (!stored) return null;
  const { salt: _salt, hash: _hash, iterations: _iterations, ...user } = stored;
  return user;
}

export async function authenticate(login: string, password: string): Promise<User | null> {
  const stored = await readStored(login.trim().toLowerCase());
  if (!stored) return null;
  return (await verifyPassword(password, stored)) ? await findUser(stored.login) : null;
}

export async function listUsers(): Promise<User[]> {
  const page = await list({ prefix: PREFIX, limit: 1000 });
  const users = await Promise.all(
    page.blobs.map(async (blob) => {
      const login = /^users\/(.+)\.json$/.exec(blob.pathname)?.[1];
      return login ? await findUser(login) : null;
    }),
  );
  return users
    .filter((user): user is User => user !== null)
    .sort((a, b) => a.login.localeCompare(b.login));
}

export async function createUser(input: {
  login: string;
  password: string;
  role: Role;
  createdBy: string;
}): Promise<User> {
  const login = input.login.trim().toLowerCase();
  if (!isValidLogin(login)) {
    throw new Error('логин: 2–31 символа, латиница, цифры, точка, дефис, подчёркивание');
  }
  if (input.password.length < 8) throw new Error('пароль короче 8 символов');
  if (await readStored(login)) throw new Error(`пользователь ${login} уже есть`);

  const user: StoredUser = {
    login,
    role: input.role,
    createdAt: `${new Date().toISOString().slice(0, 19)}Z`,
    createdBy: input.createdBy,
    ...(await hashPassword(input.password)),
  };

  await put(pathFor(login), JSON.stringify(user, null, 2), {
    access: 'public',
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 0,
  });

  const { salt: _s, hash: _h, iterations: _i, ...safe } = user;
  return safe;
}

export async function setPassword(login: string, password: string): Promise<void> {
  const stored = await readStored(login.trim().toLowerCase());
  if (!stored) throw new Error('пользователь не найден');
  if (password.length < 8) throw new Error('пароль короче 8 символов');

  const updated: StoredUser = { ...stored, ...(await hashPassword(password)) };
  await put(pathFor(stored.login), JSON.stringify(updated, null, 2), {
    access: 'public',
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

export async function deleteUser(login: string): Promise<boolean> {
  const target = login.trim().toLowerCase();
  const found = await list({ prefix: pathFor(target), limit: 1 });
  const blob = found.blobs.find((entry) => entry.pathname === pathFor(target));
  if (!blob) return false;
  await del(blob.url);
  return true;
}

/** Есть ли вообще учётки: пока нет — вход только по STORE_PASSWORD. */
export async function hasUsers(): Promise<boolean> {
  const page = await list({ prefix: PREFIX, limit: 1 });
  return page.blobs.length > 0;
}
