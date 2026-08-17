/**
 * Тонкий клиент GitHub API. Бэкенда у магазина нет, поэтому запись в Releases и
 * в apps.json идёт прямо из браузера под токеном пользователя.
 */

const API = 'https://api.github.com';

export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let message = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(detail) as {
        message?: string;
        errors?: { message?: string; field?: string; code?: string }[];
      };
      if (parsed.message) message = parsed.message;
      // «Validation Failed» без подробностей ни о чём не говорит.
      const details = parsed.errors
        ?.map((e) => e.message ?? [e.field, e.code].filter(Boolean).join(' '))
        .filter(Boolean);
      if (details?.length) message += `: ${details.join('; ')}`;
    } catch {
      /* тело не JSON — оставляем статус */
    }
    throw new GitHubError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function viewerLogin(token: string): Promise<string> {
  const user = await request<{ login: string }>(token, '/user');
  return user.login;
}

/** Проверяет наличие репозитория, при отсутствии создаёт публичный. */
export async function ensureRepo(token: string, repo: string): Promise<void> {
  try {
    await request(token, `/repos/${repo}`);
    return;
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }

  const [owner, name] = repo.split('/');
  const login = await viewerLogin(token);
  const path = owner === login ? '/user/repos' : `/orgs/${owner}/repos`;

  await request(token, path, {
    method: 'POST',
    body: JSON.stringify({
      name,
      private: false,
      description: 'APK приложений личного магазина',
      has_issues: false,
      has_wiki: false,
      // Без начального коммита GitHub откажется создавать Release: тегу
      // не к чему привязаться, ответ — 422 Validation Failed.
      auto_init: true,
    }),
  });
}

/**
 * Гарантирует, что в репозитории есть хотя бы один коммит.
 *
 * Пустой репозиторий (создан вручную «без README») ломает создание Release
 * с невнятным «Validation Failed», поэтому кладём в него README.
 */
export async function ensureNotEmpty(token: string, repo: string): Promise<void> {
  try {
    await request(token, `/repos/${repo}/commits?per_page=1`);
    return;
  } catch (error) {
    // 409 Conflict — «Git Repository is empty».
    if (!(error instanceof GitHubError) || error.status !== 409) throw error;
  }

  await putFile(
    token,
    repo,
    'README.md',
    `# ${repo.split('/')[1]}\n\nAPK приложений личного магазина. Файлы лежат в Releases.\n`,
    'Инициализация хранилища APK',
    null,
  );
}

export interface Release {
  id: number;
  upload_url: string;
  html_url: string;
  assets: { id: number; name: string }[];
}

export async function getOrCreateRelease(
  token: string,
  repo: string,
  tag: string,
  title: string,
  body: string,
): Promise<Release> {
  try {
    return await request<Release>(token, `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }

  return request<Release>(token, `/repos/${repo}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: title, body, draft: false, prerelease: false }),
  });
}

/** Заливает ассет, заменяя одноимённый: перезапуск загрузки должен быть безопасным. */
export async function uploadAsset(
  token: string,
  repo: string,
  release: Release,
  name: string,
  data: Blob,
): Promise<string> {
  const existing = release.assets.find((asset) => asset.name === name);
  if (existing) {
    await request(token, `/repos/${repo}/releases/assets/${existing.id}`, { method: 'DELETE' });
  }

  const uploadUrl = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`;
  const asset = await request<{ browser_download_url: string }>(token, uploadUrl, {
    method: 'POST',
    body: data,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  return asset.browser_download_url;
}

export interface RemoteFile {
  text: string;
  sha: string;
}

export async function getFile(token: string, repo: string, path: string): Promise<RemoteFile | null> {
  try {
    const file = await request<{ content: string; sha: string; encoding: string }>(
      token,
      `/repos/${repo}/contents/${path}`,
    );
    return { text: decodeBase64(file.content), sha: file.sha };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

export async function putFile(
  token: string,
  repo: string,
  path: string,
  text: string,
  message: string,
  sha: string | null,
): Promise<void> {
  await request(token, `/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: encodeBase64(text),
      ...(sha ? { sha } : {}),
    }),
  });
}

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function decodeBase64(base64: string): string {
  const binary = atob(base64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function rawManifestUrl(repo: string, branch = 'main'): string {
  return `https://raw.githubusercontent.com/${repo}/${branch}/apps.json`;
}
