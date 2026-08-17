/**
 * Работа с apps.json — тот же контракт и те же правила, что в
 * scripts/update_manifest.py на стороне CI: поля верхнего уровня дублируют
 * последнюю версию, история отсортирована от новой к старой и обрезана до 10,
 * повтор или откат versionCode отклоняется.
 */

export const SCHEMA_VERSION = 1;
export const MAX_HISTORY = 10;

export interface AppVersion {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  sha256: string;
  apkSizeBytes: number;
  changelog: string;
  releasedAt: string;
}

export interface AppEntry extends AppVersion {
  id: string;
  name: string;
  iconUrl?: string;
  versions: AppVersion[];
}

export interface Manifest {
  schemaVersion: number;
  updatedAt: string;
  apps: AppEntry[];
}

export class VersionConflictError extends Error {}
export class ManifestFormatError extends Error {}

const SHA256_RE = /^[0-9a-f]{64}$/i;

export function emptyManifest(now: Date = new Date()): Manifest {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: isoUtc(now), apps: [] };
}

export function isoUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function parseManifest(text: string): Manifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ManifestFormatError(`apps.json повреждён: ${(error as Error).message}`);
  }
  if (!data || typeof data !== 'object') throw new ManifestFormatError('apps.json: ожидался объект');

  const manifest = data as Manifest;
  if ((manifest.schemaVersion ?? SCHEMA_VERSION) !== SCHEMA_VERSION) {
    throw new ManifestFormatError(
      `apps.json схемы ${manifest.schemaVersion}, поддерживается только ${SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(manifest.apps)) throw new ManifestFormatError('apps.json: apps должен быть массивом');
  return { ...manifest, schemaVersion: SCHEMA_VERSION };
}

/** Тот же формат, что пишет python-скрипт: отступ 2 пробела и перевод строки в конце. */
export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function validateVersion(version: AppVersion, id: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(id)) {
    throw new ManifestFormatError(`id «${id}» не похож на имя Android-пакета`);
  }
  if (!Number.isInteger(version.versionCode) || version.versionCode <= 0) {
    throw new ManifestFormatError('versionCode должен быть положительным целым');
  }
  if (!version.versionName) throw new ManifestFormatError('versionName не может быть пустым');
  if (!version.apkUrl.startsWith('https://')) {
    throw new ManifestFormatError('apkUrl должен быть https-ссылкой');
  }
  if (!SHA256_RE.test(version.sha256)) {
    throw new ManifestFormatError('sha256 должен быть 64 hex-символами');
  }
  if (!Number.isInteger(version.apkSizeBytes) || version.apkSizeBytes <= 0) {
    throw new ManifestFormatError('apkSizeBytes должен быть положительным целым');
  }
}

/** Что не так с версией: null — всё в порядке. */
export type VersionIssue = 'duplicate' | 'older' | null;

/** Проверка без исключения — чтобы интерфейс мог предупредить заранее. */
export function checkVersion(
  manifest: Manifest,
  id: string,
  versionCode: number,
): { issue: VersionIssue; publishedVersionCode: number | null } {
  const app = manifest.apps.find((entry) => entry.id === id);
  if (!app) return { issue: null, publishedVersionCode: null };

  const published = [app.versionCode, ...app.versions.map((v) => v.versionCode)].filter((code) =>
    Number.isFinite(code),
  );
  const highest = published.length > 0 ? Math.max(...published) : null;

  if (published.includes(versionCode)) return { issue: 'duplicate', publishedVersionCode: highest };
  if (highest !== null && versionCode < highest) return { issue: 'older', publishedVersionCode: highest };
  return { issue: null, publishedVersionCode: highest };
}

function assertNewVersion(app: AppEntry, versionCode: number): void {
  const published = [app.versionCode, ...app.versions.map((v) => v.versionCode)].filter((code) =>
    Number.isFinite(code),
  );
  if (published.includes(versionCode)) {
    throw new VersionConflictError(
      `versionCode ${versionCode} для ${app.id} уже опубликован — поднимите версию`,
    );
  }
  const highest = Math.max(...published);
  if (published.length > 0 && versionCode < highest) {
    throw new VersionConflictError(
      `versionCode ${versionCode} меньше опубликованного ${highest} для ${app.id} — версия обязана расти`,
    );
  }
}

export interface UpsertInput {
  id: string;
  name: string;
  iconUrl?: string;
  version: AppVersion;
  maxHistory?: number;
  now?: Date;
  /**
   * Разрешить перезалить уже опубликованный versionCode: запись этой версии
   * заменяется целиком. Нужно, когда в витрину попал битый или не тот APK.
   * В CI-конвейере такого послабления нет — там дубликат всегда отказ.
   */
  force?: boolean;
}

/** Возвращает НОВЫЙ манифест: исходный не меняется, чтобы UI мог показать разницу. */
export function upsertApp(manifest: Manifest, input: UpsertInput): Manifest {
  const { id, name, iconUrl, version, maxHistory = MAX_HISTORY, now = new Date(), force = false } = input;
  validateVersion(version, id);

  const existing = manifest.apps.find((app) => app.id === id);
  if (existing && !force) assertNewVersion(existing, version.versionCode);

  // Новая запись стоит первой, поэтому при совпадении versionCode
  // побеждает она — это и есть перезаливка.
  const history = [version, ...(existing?.versions ?? [])]
    .filter((entry, index, all) => all.findIndex((e) => e.versionCode === entry.versionCode) === index)
    .sort((a, b) => b.versionCode - a.versionCode)
    .slice(0, maxHistory);

  const latest = history[0];
  const entry: AppEntry = {
    id,
    name,
    ...(iconUrl || existing?.iconUrl ? { iconUrl: iconUrl ?? existing?.iconUrl } : {}),
    versionCode: latest.versionCode,
    versionName: latest.versionName,
    apkUrl: latest.apkUrl,
    sha256: latest.sha256,
    apkSizeBytes: latest.apkSizeBytes,
    changelog: latest.changelog,
    releasedAt: latest.releasedAt,
    versions: history,
  };

  const apps = existing
    ? manifest.apps.map((app) => (app.id === id ? entry : app))
    : [...manifest.apps, entry];

  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: isoUtc(now),
    apps: apps.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
  };
}
