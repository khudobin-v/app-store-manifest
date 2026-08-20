import { unzipSync } from 'fflate';
import { parseAndroidManifest, type ApkManifestInfo } from './axml';
import { ResourceTable } from './arsc';

export interface ApkIcon {
  bytes: Uint8Array;
  /** Путь внутри APK — показывается в панели, чтобы было видно, что взято. */
  path: string;
  mime: string;
}

export interface ApkInfo extends ApkManifestInfo {
  sizeBytes: number;
  sha256: string;
  /** Подписан ли APK: без подписи Android его не установит. */
  signed: boolean;
  /** Иконка, вытащенная из APK; null — только вектор или не нашлась. */
  icon: ApkIcon | null;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes);
  return toHex(await crypto.subtle.digest('SHA-256', view.buffer as ArrayBuffer));
}

const RASTER = /\.(png|webp|jpg|jpeg)$/i;

function mimeFor(path: string): string {
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  return 'image/png';
}

/** Плотность из имени каталога — запасной ориентир, если её нет в таблице. */
function densityFromPath(path: string): number {
  const match = /-(l|m|h|xh|xxh|xxxh)dpi/i.exec(path);
  const table: Record<string, number> = { l: 120, m: 160, h: 240, xh: 320, xxh: 480, xxxh: 640 };
  return match ? (table[match[1].toLowerCase()] ?? 0) : 0;
}

/**
 * Читает APK: метаданные, sha256, признак подписи и иконку.
 *
 * Название и иконка в манифесте почти всегда ссылки на ресурсы, поэтому
 * дополнительно разбирается resources.arsc. Если иконка оказалась вектором
 * (adaptive icon), берётся самый крупный растровый файл mipmap — рисовать
 * вектор в браузере ради превью не стоит.
 */
export async function readApk(bytes: Uint8Array): Promise<ApkInfo> {
  let hasV1Signature = false;
  const rasterCandidates: string[] = [];

  const wanted = new Set(['AndroidManifest.xml', 'resources.arsc']);
  const entries = unzipSync(bytes, {
    filter: (file) => {
      if (wanted.has(file.name)) return true;
      if (/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(file.name)) hasV1Signature = true;
      if (/^res\/.+/.test(file.name) && RASTER.test(file.name)) rasterCandidates.push(file.name);
      return false;
    },
  });

  const manifestBytes = entries['AndroidManifest.xml'];
  if (!manifestBytes) throw new Error('это не APK: внутри нет AndroidManifest.xml');

  const info = parseAndroidManifest(manifestBytes);
  const table = entries['resources.arsc'] ? ResourceTable.parse(entries['resources.arsc']) : null;

  const label =
    info.label ?? (table && info.labelRef ? table.resolveString(info.labelRef) : null) ?? null;

  const iconPath = pickIconPath(table, info.iconRef, rasterCandidates);
  const icon = iconPath ? extractIcon(bytes, iconPath) : null;

  return {
    ...info,
    label,
    sizeBytes: bytes.byteLength,
    sha256: await sha256(bytes),
    signed: hasV1Signature || hasApkSigningBlock(bytes),
    icon,
  };
}

/** Путь к самой крупной растровой иконке: сначала по ресурсу, потом по mipmap. */
function pickIconPath(
  table: ResourceTable | null,
  iconRef: number | null,
  rasterCandidates: string[],
): string | null {
  if (table && iconRef) {
    const resolved = table
      .resolve(iconRef)
      .filter((entry) => RASTER.test(entry.value))
      .sort((a, b) => (b.density || densityFromPath(b.value)) - (a.density || densityFromPath(a.value)));
    if (resolved.length > 0) return resolved[0].value;
  }

  // Adaptive icon — только XML. Берём самый крупный mipmap, он почти всегда есть.
  const fallback = rasterCandidates
    .filter((path) => /mipmap|ic_launcher|app_icon/i.test(path))
    .sort((a, b) => densityFromPath(b) - densityFromPath(a));

  return fallback[0] ?? null;
}

function extractIcon(bytes: Uint8Array, path: string): ApkIcon | null {
  try {
    const entries = unzipSync(bytes, { filter: (file) => file.name === path });
    const data = entries[path];
    if (!data || data.byteLength === 0) return null;
    return { bytes: data, path, mime: mimeFor(path) };
  } catch {
    return null;
  }
}

/** Блок подписи APK v2/v3 помечен магической строкой перед central directory. */
function hasApkSigningBlock(bytes: Uint8Array): boolean {
  const magicBytes = new TextEncoder().encode('APK Sig Block 42');
  const searchFrom = Math.max(0, bytes.byteLength - 4 * 1024 * 1024);
  outer: for (let i = bytes.byteLength - magicBytes.length; i >= searchFrom; i--) {
    for (let j = 0; j < magicBytes.length; j++) {
      if (bytes[i + j] !== magicBytes[j]) continue outer;
    }
    return true;
  }
  return false;
}
