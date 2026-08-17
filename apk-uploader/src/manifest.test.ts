import { describe, expect, it } from 'vitest';
import {
  emptyManifest,
  ManifestFormatError,
  parseManifest,
  serializeManifest,
  upsertApp,
  VersionConflictError,
  type AppVersion,
} from './manifest';

const version = (code: number, overrides: Partial<AppVersion> = {}): AppVersion => ({
  versionCode: code,
  versionName: `1.${code}.0`,
  apkUrl: `https://github.com/o/r/releases/download/v1.${code}.0/app.apk`,
  sha256: code.toString(16).padStart(64, '0'),
  apkSizeBytes: 1024 * code,
  changelog: `changelog ${code}`,
  releasedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('upsertApp', () => {
  it('создаёт запись с полями верхнего уровня', () => {
    const result = upsertApp(emptyManifest(), { id: 'com.example.app', name: 'App', version: version(1) });
    const app = result.apps[0];

    expect(app.id).toBe('com.example.app');
    expect(app.versionCode).toBe(1);
    expect(app.versions).toHaveLength(1);
    expect(result.schemaVersion).toBe(1);
  });

  it('поля верхнего уровня дублируют последнюю версию', () => {
    let manifest = upsertApp(emptyManifest(), { id: 'com.example.app', name: 'App', version: version(1) });
    manifest = upsertApp(manifest, { id: 'com.example.app', name: 'App', version: version(2) });
    const app = manifest.apps[0];

    expect(app.versionCode).toBe(app.versions[0].versionCode);
    expect(app.changelog).toBe(app.versions[0].changelog);
    expect(app.versionCode).toBe(2);
  });

  it('история отсортирована от новой к старой и обрезана до 10', () => {
    let manifest = emptyManifest();
    for (let code = 1; code <= 14; code++) {
      manifest = upsertApp(manifest, { id: 'com.example.app', name: 'App', version: version(code) });
    }
    const codes = manifest.apps[0].versions.map((v) => v.versionCode);

    expect(codes).toHaveLength(10);
    expect(codes).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  });

  it('отклоняет повтор versionCode', () => {
    const manifest = upsertApp(emptyManifest(), {
      id: 'com.example.app',
      name: 'App',
      version: version(7),
    });

    expect(() => upsertApp(manifest, { id: 'com.example.app', name: 'App', version: version(7) })).toThrow(
      VersionConflictError,
    );
  });

  it('отклоняет откат версии назад', () => {
    const manifest = upsertApp(emptyManifest(), {
      id: 'com.example.app',
      name: 'App',
      version: version(5),
    });

    expect(() => upsertApp(manifest, { id: 'com.example.app', name: 'App', version: version(4) })).toThrow(
      VersionConflictError,
    );
  });

  it('не меняет исходный манифест', () => {
    const original = upsertApp(emptyManifest(), {
      id: 'com.example.app',
      name: 'App',
      version: version(1),
    });
    const snapshot = serializeManifest(original);

    upsertApp(original, { id: 'com.example.app', name: 'App', version: version(2) });

    expect(serializeManifest(original)).toBe(snapshot);
  });

  it('сохраняет иконку, если её не передали', () => {
    let manifest = upsertApp(emptyManifest(), {
      id: 'com.example.app',
      name: 'App',
      version: version(1),
      iconUrl: 'https://x/i.png',
    });
    manifest = upsertApp(manifest, { id: 'com.example.app', name: 'App', version: version(2) });

    expect(manifest.apps[0].iconUrl).toBe('https://x/i.png');
  });

  it('не трогает другие приложения', () => {
    let manifest = upsertApp(emptyManifest(), { id: 'com.example.a', name: 'A', version: version(1) });
    manifest = upsertApp(manifest, { id: 'com.example.b', name: 'B', version: version(1) });

    expect(manifest.apps).toHaveLength(2);
    expect(manifest.apps.find((a) => a.id === 'com.example.a')?.versions).toHaveLength(1);
  });

  it('сортирует приложения по имени', () => {
    let manifest = upsertApp(emptyManifest(), { id: 'com.example.b', name: 'Яблоко', version: version(1) });
    manifest = upsertApp(manifest, { id: 'com.example.a', name: 'Арбуз', version: version(1) });

    expect(manifest.apps.map((a) => a.name)).toEqual(['Арбуз', 'Яблоко']);
  });

  it.each([
    ['sha256', { sha256: 'deadbeef' }],
    ['http-ссылка', { apkUrl: 'http://x/a.apk' }],
    ['нулевой размер', { apkSizeBytes: 0 }],
    ['пустой versionName', { versionName: '' }],
  ])('отклоняет некорректный %s', (_label, overrides) => {
    expect(() =>
      upsertApp(emptyManifest(), {
        id: 'com.example.app',
        name: 'App',
        version: version(1, overrides as Partial<AppVersion>),
      }),
    ).toThrow(ManifestFormatError);
  });
});

describe('parseManifest', () => {
  it('читает витрину и отдаёт приложения', () => {
    const manifest = parseManifest(
      serializeManifest(
        upsertApp(emptyManifest(), { id: 'com.example.app', name: 'App', version: version(3) }),
      ),
    );

    expect(manifest.apps[0].versionCode).toBe(3);
  });

  it('отклоняет неподдерживаемую схему', () => {
    expect(() => parseManifest('{"schemaVersion":2,"apps":[]}')).toThrow(ManifestFormatError);
  });

  it('отклоняет битый JSON', () => {
    expect(() => parseManifest('{ не json')).toThrow(ManifestFormatError);
  });
});

describe('serializeManifest', () => {
  it('совпадает по формату с python-скриптом: отступ 2 и перевод строки в конце', () => {
    const text = serializeManifest(emptyManifest(new Date('2026-08-17T10:00:00Z')));

    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "schemaVersion": 1,');
    expect(text).toContain('"updatedAt": "2026-08-17T10:00:00Z"');
  });
});
