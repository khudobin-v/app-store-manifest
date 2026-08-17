import { unzipSync } from 'fflate';
import { parseAndroidManifest, type ApkManifestInfo } from './axml';

export interface ApkInfo extends ApkManifestInfo {
  sizeBytes: number;
  sha256: string;
  /** Подписан ли APK: без подписи Android его не установит. */
  signed: boolean;
}

/** Байты → hex. */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes);
  return toHex(await crypto.subtle.digest('SHA-256', view.buffer as ArrayBuffer));
}

/**
 * Читает APK: метаданные из AndroidManifest.xml, sha256 и размер.
 *
 * Наличие подписи проверяется по META-INF/*.RSA|DSA|EC (v1) и по блоку
 * подписи v2/v3 в конце файла — полноценной проверки цепочки в браузере нет,
 * это защита от «залил не тот файл», а не замена apksigner.
 */
export async function readApk(bytes: Uint8Array): Promise<ApkInfo> {
  let manifestBytes: Uint8Array | undefined;
  let hasV1Signature = false;

  const entries = unzipSync(bytes, {
    filter: (file) => {
      if (file.name === 'AndroidManifest.xml') return true;
      if (/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(file.name)) {
        hasV1Signature = true;
      }
      return false;
    },
  });

  manifestBytes = entries['AndroidManifest.xml'];
  if (!manifestBytes) throw new Error('это не APK: внутри нет AndroidManifest.xml');

  const info = parseAndroidManifest(manifestBytes);

  return {
    ...info,
    sizeBytes: bytes.byteLength,
    sha256: await sha256(bytes),
    signed: hasV1Signature || hasApkSigningBlock(bytes),
  };
}

/** Блок подписи APK v2/v3 помечен магической строкой перед End of Central Directory. */
function hasApkSigningBlock(bytes: Uint8Array): boolean {
  const magic = 'APK Sig Block 42';
  const magicBytes = new TextEncoder().encode(magic);
  // Ищем с конца: блок лежит непосредственно перед central directory.
  const searchFrom = Math.max(0, bytes.byteLength - 4 * 1024 * 1024);
  outer: for (let i = bytes.byteLength - magicBytes.length; i >= searchFrom; i--) {
    for (let j = 0; j < magicBytes.length; j++) {
      if (bytes[i + j] !== magicBytes[j]) continue outer;
    }
    return true;
  }
  return false;
}
