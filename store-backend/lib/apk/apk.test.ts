import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readApk } from './apk';

/** Проверяем разбор на настоящих APK и сверяем с aapt2 — эталоном из CI. */

const APKS = [
  '/Users/u/apptransfer/sample-app/app/build/outputs/apk/release/app-release.apk',
  '/private/tmp/claude-501/-Users-u-apptransfer/694bd159-4520-469b-b811-fdc7b1e47b61/scratchpad/uploadtest/app/build/outputs/apk/release/app-release.apk',
].filter(existsSync);

function badging(path: string): string {
  const sdk = process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`;
  const buildTools = execFileSync('sh', ['-c', `ls -d ${sdk}/build-tools/* | sort -V | tail -1`])
    .toString()
    .trim();
  return execFileSync(`${buildTools}/aapt2`, ['dump', 'badging', path]).toString();
}

describe('readApk', () => {
  it.runIf(APKS.length > 0)('метаданные совпадают с aapt2', async () => {
    for (const path of APKS) {
      const info = await readApk(new Uint8Array(readFileSync(path)));
      const line = badging(path).split('\n').find((row: string) => row.startsWith('package:')) ?? '';
      const field = (key: string) => new RegExp(` ${key}='([^']*)'`).exec(line)?.[1] ?? '';

      expect(info.packageName, path).toBe(field('name'));
      expect(String(info.versionCode), path).toBe(field('versionCode'));
      expect(info.versionName, path).toBe(field('versionName'));
    }
  });

  it.runIf(APKS.length > 0)('название разворачивается из resources.arsc', async () => {
    for (const path of APKS) {
      const info = await readApk(new Uint8Array(readFileSync(path)));
      const expected = /^application-label:'(.*)'$/m.exec(badging(path))?.[1];
      if (!expected) continue;

      expect(info.label, path).toBe(expected);
    }
  });

  it.runIf(APKS.length > 0)('иконка достаётся из APK', async () => {
    for (const path of APKS) {
      const info = await readApk(new Uint8Array(readFileSync(path)));
      const hasRaster = /^application-icon-\d+:'[^']*\.(png|webp)'$/m.test(badging(path));
      if (!hasRaster) continue;

      expect(info.icon, path).not.toBeNull();
      expect(info.icon!.bytes, path).not.toBeNull();
      expect(info.icon!.bytes!.byteLength).toBeGreaterThan(0);
      // PNG начинается с сигнатуры \x89PNG.
      if (info.icon!.mime === 'image/png') {
        expect(Array.from(info.icon!.bytes!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
      }
    }
  });

  it.runIf(APKS.length > 0)('sha256 совпадает с shasum', async () => {
    const path = APKS[0];
    const bytes = new Uint8Array(readFileSync(path));
    const info = await readApk(bytes);

    expect(info.sizeBytes).toBe(bytes.byteLength);
    expect(info.sha256).toBe(execFileSync('shasum', ['-a', '256', path]).toString().split(' ')[0]);
  });

  it('отвергает файл, который не является APK', async () => {
    await expect(readApk(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});
