import { NextResponse } from 'next/server';
import { isAuthorized, hasPublishToken } from '@/lib/auth';
import { listPublished, readCatalog, writeVersion, type StoredVersion } from '@/lib/catalog';
import { ManifestFormatError, validateVersion } from '@/lib/manifest';

export const dynamic = 'force-dynamic';

/**
 * Витрина. Отдаётся без кэша: телефон должен видеть новую версию сразу после
 * публикации, а не через пять минут, как это было с CDN GitHub.
 */
export async function GET() {
  try {
    const catalog = await readCatalog();
    return NextResponse.json(catalog, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

interface PublishRequest {
  id: string;
  name: string;
  iconUrl?: string;
  versionCode: number;
  versionName: string;
  apkUrl: string;
  sha256: string;
  apkSizeBytes: number;
  changelog?: string;
  releasedAt?: string;
  /** Перезалить уже опубликованный versionCode — только из интерфейса, не из CI. */
  force?: boolean;
}

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: 'нужна авторизация' }, { status: 401 });
  }

  let body: PublishRequest;
  try {
    body = (await request.json()) as PublishRequest;
  } catch {
    return NextResponse.json({ error: 'ожидался JSON' }, { status: 400 });
  }

  // Перезаливать может только человек: конвейер сборки обязан падать на дубликате.
  const force = Boolean(body.force) && !hasPublishToken(request);

  const version: StoredVersion = {
    id: String(body.id ?? ''),
    name: String(body.name ?? '').trim() || String(body.id ?? ''),
    ...(body.iconUrl ? { iconUrl: body.iconUrl } : {}),
    versionCode: Number(body.versionCode),
    versionName: String(body.versionName ?? ''),
    apkUrl: String(body.apkUrl ?? ''),
    sha256: String(body.sha256 ?? '').toLowerCase(),
    apkSizeBytes: Number(body.apkSizeBytes),
    changelog: (body.changelog ?? '').trim() || `Версия ${body.versionName}`,
    releasedAt: body.releasedAt ?? `${new Date().toISOString().slice(0, 19)}Z`,
  };

  try {
    validateVersion(version, version.id);
  } catch (error) {
    if (error instanceof ManifestFormatError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  try {
    const published = await listPublished();
    const forApp = published.filter((entry) => entry.id === version.id);
    const duplicate = forApp.some((entry) => entry.versionCode === version.versionCode);
    const highest = forApp.reduce((max, entry) => Math.max(max, entry.versionCode), 0);

    if (duplicate && !force) {
      return NextResponse.json(
        {
          error: `versionCode ${version.versionCode} для ${version.id} уже опубликован — поднимите версию`,
          conflict: 'duplicate',
        },
        { status: 409 },
      );
    }
    if (!duplicate && highest > version.versionCode && !force) {
      return NextResponse.json(
        {
          error: `versionCode ${version.versionCode} меньше опубликованного ${highest} — версия обязана расти`,
          conflict: 'older',
        },
        { status: 409 },
      );
    }

    await writeVersion(version, force || duplicate);
    return NextResponse.json({ ok: true, id: version.id, versionCode: version.versionCode });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
