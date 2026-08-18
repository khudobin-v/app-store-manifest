import { del, list, put } from '@vercel/blob';
import { MAX_HISTORY, type AppEntry, type AppVersion, type Manifest, SCHEMA_VERSION, isoUtc } from './manifest';

/**
 * Каталог собирается из неизменяемых записей: одна версия приложения — один
 * блоб `catalog/<packageName>/<versionCode>.json`.
 *
 * Почему не один общий JSON: Blob не даёт read-after-write, и при публикации
 * подряд нескольких версий чтение возвращало устаревший каталог, а запись
 * затирала уже добавленное. С записями по версиям затирать нечего: каждый
 * файл пишется один раз, а состав каталога берётся из list() — он идёт через
 * API хранилища, а не через CDN.
 */

const PREFIX = 'catalog/';
const META_PREFIX = 'meta/';

/** Правки из панели: имя и иконка приложения, не переписывая записи версий. */
interface AppMeta {
  name?: string;
  iconUrl?: string | null;
  hidden?: boolean;
}

interface StoredVersion extends AppVersion {
  id: string;
  name: string;
  iconUrl?: string;
}

export function versionPath(packageName: string, versionCode: number): string {
  return `${PREFIX}${packageName}/${versionCode}.json`;
}

/** Пути всех опубликованных версий: versionCode виден прямо в имени. */
export async function listPublished(): Promise<{ id: string; versionCode: number; url: string }[]> {
  const entries: { id: string; versionCode: number; url: string }[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const blob of page.blobs) {
      const match = /^catalog\/([^/]+)\/(\d+)\.json$/.exec(blob.pathname);
      if (match) {
        entries.push({ id: match[1], versionCode: Number(match[2]), url: blob.url });
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return entries;
}

async function readMeta(): Promise<Map<string, AppMeta>> {
  const meta = new Map<string, AppMeta>();
  const page = await list({ prefix: META_PREFIX, limit: 1000 });

  await Promise.all(
    page.blobs.map(async (blob) => {
      const id = /^meta\/(.+)\.json$/.exec(blob.pathname)?.[1];
      if (!id) return;
      // ?v= — метаданные перезаписываются, из CDN может прийти старое.
      const response = await fetch(`${blob.url}?v=${Date.now()}`, { cache: 'no-store' });
      if (response.ok) meta.set(id, (await response.json()) as AppMeta);
    }),
  );

  return meta;
}

export async function writeMeta(id: string, meta: AppMeta): Promise<void> {
  await put(`${META_PREFIX}${id}.json`, JSON.stringify(meta, null, 2), {
    access: 'public',
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

/** Удаляет одну версию. Возвращает false, если такой версии не было. */
export async function deleteVersion(id: string, versionCode: number): Promise<boolean> {
  const published = await listPublished();
  const target = published.find((entry) => entry.id === id && entry.versionCode === versionCode);
  if (!target) return false;
  await del(target.url);
  return true;
}

/** Удаляет приложение целиком: все версии и правки. */
export async function deleteApp(id: string): Promise<number> {
  const published = (await listPublished()).filter((entry) => entry.id === id);
  if (published.length > 0) await del(published.map((entry) => entry.url));

  const meta = await list({ prefix: `${META_PREFIX}${id}.json`, limit: 1 });
  if (meta.blobs.length > 0) await del(meta.blobs[0].url);

  return published.length;
}

export interface StorageStats {
  apps: number;
  versions: number;
  bytes: number;
}

/** Что лежит в хранилище: для сводки в панели. */
export async function readStats(): Promise<StorageStats> {
  let bytes = 0;
  let cursor: string | undefined;
  const apps = new Set<string>();
  let versions = 0;

  do {
    const page = await list({ cursor, limit: 1000 });
    for (const blob of page.blobs) {
      bytes += blob.size;
      const match = /^catalog\/([^/]+)\/(\d+)\.json$/.exec(blob.pathname);
      if (match) {
        apps.add(match[1]);
        versions += 1;
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return { apps: apps.size, versions, bytes };
}

export async function readCatalog(): Promise<Manifest> {
  const published = await listPublished();

  // Тела версий неизменяемы, поэтому их можно спокойно брать из CDN.
  const versions = await Promise.all(
    published.map(async (entry) => {
      const response = await fetch(entry.url);
      if (!response.ok) return null;
      return (await response.json()) as StoredVersion;
    }),
  );

  const byApp = new Map<string, StoredVersion[]>();
  for (const version of versions) {
    if (!version) continue;
    const list = byApp.get(version.id) ?? [];
    list.push(version);
    byApp.set(version.id, list);
  }

  const meta = await readMeta();
  const apps: AppEntry[] = [];
  for (const [id, all] of byApp) {
    const history = all.sort((a, b) => b.versionCode - a.versionCode).slice(0, MAX_HISTORY);
    const latest = history[0];
    const overrides = meta.get(id) ?? {};
    if (overrides.hidden) continue;

    const iconUrl = overrides.iconUrl === null ? undefined : overrides.iconUrl ?? latest.iconUrl;
    apps.push({
      id,
      name: overrides.name?.trim() || latest.name,
      ...(iconUrl ? { iconUrl } : {}),
      versionCode: latest.versionCode,
      versionName: latest.versionName,
      apkUrl: latest.apkUrl,
      sha256: latest.sha256,
      apkSizeBytes: latest.apkSizeBytes,
      changelog: latest.changelog,
      releasedAt: latest.releasedAt,
      versions: history.map(({ id: _id, name: _name, iconUrl: _icon, ...version }) => version),
    });
  }

  apps.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { schemaVersion: SCHEMA_VERSION, updatedAt: isoUtc(new Date()), apps };
}

/**
 * Пишет версию. Повтор versionCode отклоняется самим хранилищем
 * (`allowOverwrite: false`) — гонок при параллельной публикации не будет.
 */
export async function writeVersion(version: StoredVersion, force: boolean): Promise<void> {
  await put(versionPath(version.id, version.versionCode), JSON.stringify(version, null, 2), {
    access: 'public',
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: force,
  });
}

export type { StoredVersion };
