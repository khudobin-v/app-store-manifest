import { unzipSync } from 'fflate';
import { collectReferences, parseAndroidManifest, type ApkManifestInfo } from './axml';
import { ResourceTable } from './arsc';
import { iconToSvg, type DrawableSource } from './vector';

export interface ApkIcon {
  /** Растровый файл из APK; для векторной иконки пусто. */
  bytes: Uint8Array | null;
  /**
   * Векторная иконка, переведённая в SVG. У приложений с minSdk 26 картинки в
   * пакете нет вовсе — есть контуры, которые Android рисует сам; растрирует
   * такой SVG уже панель, средствами браузера.
   */
  svg: string | null;
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

  const iconPath = pickIconPath(bytes, table, info.iconRef, rasterCandidates);
  const icon = (iconPath ? extractIcon(bytes, iconPath) : null) ?? vectorIcon(bytes, table, info.iconRef);

  return {
    ...info,
    label,
    sizeBytes: bytes.byteLength,
    sha256: await sha256(bytes),
    signed: hasV1Signature || hasApkSigningBlock(bytes),
    icon,
  };
}

function bestRaster(table: ResourceTable, id: number): string | null {
  const resolved = table
    .resolve(id)
    .filter((entry) => RASTER.test(entry.value))
    .sort((a, b) => (b.density || densityFromPath(b.value)) - (a.density || densityFromPath(a.value)));
  return resolved[0]?.value ?? null;
}

/**
 * Путь к самой крупной растровой иконке.
 *
 * Порядок: сам ресурс иконки → если он оказался adaptive icon (XML), его
 * foreground/background → и лишь в конце эвристика по именам файлов. Последняя
 * не работает, когда имена ресурсов обфусцированы при сборке (`res/AB.png`),
 * поэтому полагаться на неё нельзя.
 */
function pickIconPath(
  apk: Uint8Array,
  table: ResourceTable | null,
  iconRef: number | null,
  rasterCandidates: string[],
): string | null {
  if (table && iconRef) {
    const direct = bestRaster(table, iconRef);
    if (direct) return direct;

    // Adaptive icon: разворачиваем ссылки внутри XML.
    const xml = table.resolve(iconRef).find((entry) => entry.value.endsWith('.xml'))?.value;
    if (xml) {
      const contents = readEntry(apk, xml);
      if (contents) {
        const nested = collectReferences(contents)
          .map((id) => bestRaster(table, id))
          .filter((path): path is string => path !== null);
        if (nested.length > 0) {
          return nested.sort((a, b) => densityFromPath(b) - densityFromPath(a))[0];
        }
      }
    }
  }

  const fallback = rasterCandidates
    .filter((path) => /mipmap|ic_launcher|app_icon/i.test(path))
    .sort((a, b) => densityFromPath(b) - densityFromPath(a));

  return fallback[0] ?? null;
}

function readEntry(apk: Uint8Array, path: string): Uint8Array | null {
  try {
    const entries = unzipSync(apk, { filter: (file) => file.name === path });
    return entries[path] ?? null;
  } catch {
    return null;
  }
}

function extractIcon(bytes: Uint8Array, path: string): ApkIcon | null {
  const data = readEntry(bytes, path);
  if (!data || data.byteLength === 0) return null;
  return { bytes: data, svg: null, path, mime: mimeFor(path) };
}

/**
 * Иконка, собранная из векторных контуров.
 *
 * Растр ищется первым: если в APK лежит готовый PNG, брать его дешевле и
 * точнее. Сюда доходят пакеты, где иконка — только adaptive icon с вектором.
 */
function vectorIcon(apk: Uint8Array, table: ResourceTable | null, iconRef: number | null): ApkIcon | null {
  if (!table || !iconRef) return null;

  const source: DrawableSource = {
    file(id) {
      const path = table.resolve(id)[0]?.value;
      if (!path) return null;
      const data = readEntry(apk, path);
      return data ? { path, bytes: data } : null;
    },
    color(id) {
      return table.resolveColor(id);
    },
  };

  const svg = iconToSvg(iconRef, source);
  if (!svg) return null;

  const path = table.resolve(iconRef)[0]?.value ?? 'иконка';
  return { bytes: null, svg, path, mime: 'image/svg+xml' };
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
