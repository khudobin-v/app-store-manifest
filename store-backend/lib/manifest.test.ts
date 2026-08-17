import { describe, expect, it } from 'vitest';
import {
  checkVersion,
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

describe('перезаливка версии (force)', () => {
  const published = () =>
    upsertApp(emptyManifest(), { id: 'com.example.app', name: 'App', version: version(5) });

  it('checkVersion сообщает о дубликате, не бросая исключение', () => {
    const result = checkVersion(published(), 'com.example.app', 5);

    expect(result.issue).toBe('duplicate');
    expect(result.publishedVersionCode).toBe(5);
  });

  it('checkVersion сообщает о версии старее опубликованной', () => {
    expect(checkVersion(published(), 'com.example.app', 4).issue).toBe('older');
  });

  it('новое приложение вопросов не вызывает', () => {
    expect(checkVersion(published(), 'com.example.other', 1).issue).toBeNull();
  });

  it('force заменяет запись с тем же versionCode', () => {
    const updated = upsertApp(published(), {
      id: 'com.example.app',
      name: 'App',
      version: version(5, { sha256: 'f'.repeat(64), changelog: 'перезалито' }),
      force: true,
    });
    const app = updated.apps[0];

    expect(app.versions).toHaveLength(1);
    expect(app.sha256).toBe('f'.repeat(64));
    expect(app.changelog).toBe('перезалито');
  });

  it('force для старой версии не меняет верхнюю запись', () => {
    let manifest = published();
    manifest = upsertApp(manifest, { id: 'com.example.app', name: 'App', version: version(6) });

    const updated = upsertApp(manifest, {
      id: 'com.example.app',
      name: 'App',
      version: version(5, { changelog: 'исправленная старая' }),
      force: true,
    });

    expect(updated.apps[0].versionCode).toBe(6);
    expect(updated.apps[0].versions.map((v) => v.versionCode)).toEqual([6, 5]);
    expect(updated.apps[0].versions[1].changelog).toBe('исправленная старая');
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
