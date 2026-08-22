import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readApk } from './apk';

/**
 * Иконка должна находиться у любого APK, в том числе у собранных с minSdk 26:
 * там растра нет вовсе, только adaptive icon с вектором.
 */
const APKS = [
  '/Users/u/apptransfer/sample-app/app/build/outputs/apk/release/app-release.apk',
  '/Users/u/apptransfer/store-client/app/build/outputs/apk/release/app-release-unsigned.apk',
].filter(existsSync);

describe('иконка из APK', () => {
  it.runIf(APKS.length > 0)('находится и отдаётся картинкой или вектором', async () => {
    for (const path of APKS) {
      const info = await readApk(new Uint8Array(readFileSync(path)));
      expect(info.icon, path).not.toBeNull();

      const icon = info.icon!;
      expect(Boolean(icon.bytes) || Boolean(icon.svg), path).toBe(true);
      if (icon.svg) {
        expect(icon.svg, path).toContain('<svg');
        expect(icon.svg, path).toMatch(/<path|<image|<rect/);
      }
    }
  });
});
