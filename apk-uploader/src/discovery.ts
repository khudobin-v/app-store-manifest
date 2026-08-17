/**
 * Автопоиск репозиториев магазина: витрины (в корне лежит apps.json) и
 * хранилища APK. Чтобы не заставлять вводить «владелец/репозиторий» руками.
 */

import { GitHubError } from './github';

export interface Discovered {
  manifestRepo: string | null;
  uploadsRepo: string | null;
  /** Все найденные витрины — если их несколько, выбор за пользователем. */
  manifestCandidates: string[];
}

interface Repo {
  full_name: string;
  name: string;
  owner: { login: string };
  pushed_at: string;
}

const MANIFEST_REPO_NAME = 'app-store-manifest';
const UPLOADS_REPO_NAME = 'app-store-uploads';
/** Сколько «чужих» по имени репозиториев проверять на наличие apps.json. */
const PROBE_LIMIT = 12;

async function api<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new GitHubError(`${response.status} ${response.statusText}`, response.status);
  return (await response.json()) as T;
}

async function hasAppsJson(token: string, repo: string): Promise<boolean> {
  try {
    await api(token, `/repos/${repo}/contents/apps.json`);
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return false;
    throw error;
  }
}

export async function discoverRepos(token: string): Promise<Discovered> {
  const repos = await api<Repo[]>(
    token,
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,organization_member',
  );

  // 1. Репозитории с ожидаемым именем — самый частый случай.
  const byName = repos.filter((repo) => repo.name === MANIFEST_REPO_NAME).map((r) => r.full_name);

  // 2. Иначе ищем витрину по содержимому: apps.json в корне.
  const probed: string[] = [];
  if (byName.length === 0) {
    for (const repo of repos.slice(0, PROBE_LIMIT)) {
      if (await hasAppsJson(token, repo.full_name)) probed.push(repo.full_name);
    }
  }

  const manifestCandidates = byName.length > 0 ? byName : probed;
  const manifestRepo = manifestCandidates[0] ?? null;
  const owner = manifestRepo?.split('/')[0] ?? repos[0]?.owner.login ?? null;

  const existingUploads = repos.find((repo) => repo.name === UPLOADS_REPO_NAME)?.full_name ?? null;
  const uploadsRepo = existingUploads ?? (owner ? `${owner}/${UPLOADS_REPO_NAME}` : null);

  return { manifestRepo, uploadsRepo, manifestCandidates };
}

export interface GhCliSession {
  token: string;
  login: string;
}

/** Токен уже авторизованного gh CLI. Доступно только при локальном запуске. */
export async function signInWithGhCli(): Promise<GhCliSession> {
  const response = await fetch('/api/gh-token');
  const data = (await response.json().catch(() => ({}))) as Partial<GhCliSession> & { error?: string };
  if (!response.ok || !data.token) {
    throw new Error(data.error ?? 'вход через gh CLI недоступен: запустите npm run dev');
  }
  return { token: data.token, login: data.login ?? '' };
}
