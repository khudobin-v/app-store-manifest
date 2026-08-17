import { list, put } from '@vercel/blob';
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

  const apps: AppEntry[] = [];
  for (const [id, all] of byApp) {
    const history = all.sort((a, b) => b.versionCode - a.versionCode).slice(0, MAX_HISTORY);
    const latest = history[0];
    apps.push({
      id,
      name: latest.name,
      ...(latest.iconUrl ? { iconUrl: latest.iconUrl } : {}),
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
