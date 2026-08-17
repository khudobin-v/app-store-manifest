import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readApk } from './apk';

/**
 * Проверяем разбор APK на настоящих файлах и сверяем результат с aapt2 —
 * эталоном, которым пользуется CI. Если SDK нет, тест сверяет хотя бы
 * внутреннюю согласованность.
 */

const APKS = [
  '/Users/u/apptransfer/sample-app/app/build/outputs/apk/release/app-release.apk',
  '/Users/u/apptransfer/store-client/app/build/outputs/apk/release/app-release-unsigned.apk',
].filter(existsSync);

function aapt2Badging(path: string): Record<string, string> | null {
  const sdk = process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`;
  try {
    const buildTools = execFileSync('sh', ['-c', `ls -d ${sdk}/build-tools/* | sort -V | tail -1`])
      .toString()
      .trim();
    const badging = execFileSync(`${buildTools}/aapt2`, ['dump', 'badging', path]).toString();
    const line = badging.split('\n').find((row: string) => row.startsWith('package:')) ?? '';
    const field = (key: string) => new RegExp(` ${key}='([^']*)'`).exec(line)?.[1] ?? '';
    return {
      packageName: field('name'),
      versionCode: field('versionCode'),
      versionName: field('versionName'),
    };
  } catch {
    return null;
  }
}

describe('readApk', () => {
  it.runIf(APKS.length > 0)('совпадает с aapt2 dump badging', async () => {
    for (const path of APKS) {
      const info = await readApk(new Uint8Array(readFileSync(path)));
      const expected = aapt2Badging(path);
      if (!expected) continue;

      expect(info.packageName, path).toBe(expected.packageName);
      expect(String(info.versionCode), path).toBe(expected.versionCode);
      expect(info.versionName, path).toBe(expected.versionName);
    }
  });

  it.runIf(APKS.length > 0)('считает sha256 и размер', async () => {
    const path = APKS[0];
    const bytes = new Uint8Array(readFileSync(path));
    const info = await readApk(bytes);

    expect(info.sizeBytes).toBe(bytes.byteLength);
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);

    const viaShell = execFileSync('shasum', ['-a', '256', path]).toString().split(' ')[0];
    expect(info.sha256).toBe(viaShell);
  });

  it.runIf(APKS.length > 1)('отличает подписанный APK от неподписанного', async () => {
    const signed = await readApk(new Uint8Array(readFileSync(APKS[0])));
    const unsigned = await readApk(new Uint8Array(readFileSync(APKS[1])));

    expect(signed.signed).toBe(true);
    expect(unsigned.signed).toBe(false);
  });

  it('отвергает файл, который не является APK', async () => {
    await expect(readApk(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});
