import type { ApkInfo } from './apk/apk';
import {
  ensureRepo,
  getFile,
  getOrCreateRelease,
  putFile,
  uploadAsset,
} from './github';
import {
  emptyManifest,
  isoUtc,
  parseManifest,
  serializeManifest,
  upsertApp,
  type Manifest,
} from './manifest';

export interface PublishParams {
  token: string;
  manifestRepo: string;
  uploadsRepo: string;
  file: File;
  info: ApkInfo;
  name: string;
  changelog: string;
  icon?: File | null;
  onStep: (message: string) => void;
}

export interface PublishResult {
  apkUrl: string;
  releaseUrl: string;
  manifest: Manifest;
}

/**
 * Порядок шагов важен: сначала читаем витрину и проверяем versionCode, и только
 * потом заливаем APK. Иначе при повторной версии в хранилище оставался бы файл,
 * которого нет в витрине.
 */
export async function publishApk(params: PublishParams): Promise<PublishResult> {
  const { token, manifestRepo, uploadsRepo, file, info, name, changelog, icon, onStep } = params;

  onStep('Читаю витрину…');
  const remote = await getFile(token, manifestRepo, 'apps.json');
  const current = remote ? parseManifest(remote.text) : emptyManifest();

  const tag = `${info.packageName}-${info.versionName}`;
  const apkName = `${info.packageName}-${info.versionName}.apk`;
  const apkUrl = `https://github.com/${uploadsRepo}/releases/download/${tag}/${apkName}`;
  const iconUrl = icon ? `https://github.com/${uploadsRepo}/releases/download/${tag}/${info.packageName}-icon.png` : undefined;

  // Проверка версии до загрузки: бросит VersionConflictError, если versionCode повторяется.
  onStep('Проверяю версию…');
  const next = upsertApp(current, {
    id: info.packageName,
    name,
    iconUrl,
    version: {
      versionCode: info.versionCode,
      versionName: info.versionName,
      apkUrl,
      sha256: info.sha256,
      apkSizeBytes: info.sizeBytes,
      changelog: changelog.trim() || `Версия ${info.versionName}`,
      releasedAt: isoUtc(new Date()),
    },
  });

  onStep(`Проверяю репозиторий ${uploadsRepo}…`);
  await ensureRepo(token, uploadsRepo);

  onStep(`Создаю Release ${tag}…`);
  const release = await getOrCreateRelease(
    token,
    uploadsRepo,
    tag,
    `${name} ${info.versionName}`,
    changelog.trim() || `Версия ${info.versionName}`,
  );

  onStep(`Загружаю ${apkName} (${(info.sizeBytes / 1024 / 1024).toFixed(1)} МБ)…`);
  await uploadAsset(token, uploadsRepo, release, apkName, file);

  if (icon) {
    onStep('Загружаю иконку…');
    await uploadAsset(token, uploadsRepo, release, `${info.packageName}-icon.png`, icon);
  }

  onStep('Обновляю apps.json…');
  await putFile(
    token,
    manifestRepo,
    'apps.json',
    serializeManifest(next),
    `${info.packageName} ${info.versionName} (${info.versionCode}) — загружен готовый APK`,
    remote?.sha ?? null,
  );

  onStep('Готово');
  return { apkUrl, releaseUrl: release.html_url, manifest: next };
}
