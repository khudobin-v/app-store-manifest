import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readApk, type ApkInfo } from './apk/apk';
import { publishApk } from './publish';
import { VersionConflictError, type Manifest } from './manifest';
import { rawManifestUrl } from './github';
import './App.css';

const SETTINGS_KEY = 'apk-uploader.settings';
const TOKEN_KEY = 'apk-uploader.token';

interface Settings {
  manifestRepo: string;
  uploadsRepo: string;
}

function loadSettings(): Settings {
  const stored = localStorage.getItem(SETTINGS_KEY);
  if (stored) {
    try {
      return JSON.parse(stored) as Settings;
    } catch {
      /* мусор в localStorage — начинаем с пустых значений */
    }
  }
  return { manifestRepo: '', uploadsRepo: '' };
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  return `${(value / 1024 / 1024).toFixed(1)} МБ`;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<ApkInfo | null>(null);
  const [name, setName] = useState('');
  const [changelog, setChangelog] = useState('');
  const [icon, setIcon] = useState<File | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ apkUrl: string; releaseUrl: string } | null>(null);
  const [storefront, setStorefront] = useState<Manifest | null>(null);
  const [dragging, setDragging] = useState(false);
  const apkInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)), [settings]);
  useEffect(() => {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  }, [token]);

  const uploadsRepo = useMemo(() => {
    if (settings.uploadsRepo) return settings.uploadsRepo;
    const owner = settings.manifestRepo.split('/')[0];
    return owner ? `${owner}/app-store-uploads` : '';
  }, [settings]);

  const refreshStorefront = useCallback(async () => {
    if (!settings.manifestRepo) return;
    try {
      const response = await fetch(rawManifestUrl(settings.manifestRepo), { cache: 'no-store' });
      setStorefront(response.ok ? ((await response.json()) as Manifest) : null);
    } catch {
      setStorefront(null);
    }
  }, [settings.manifestRepo]);

  useEffect(() => {
    void refreshStorefront();
  }, [refreshStorefront]);

  const onApkSelected = useCallback(async (selected: File) => {
    setError(null);
    setDone(null);
    setSteps([]);
    setFile(selected);
    setInfo(null);
    try {
      const parsed = await readApk(new Uint8Array(await selected.arrayBuffer()));
      setInfo(parsed);
      setName(parsed.label ?? parsed.packageName);
    } catch (e) {
      setError((e as Error).message);
      setFile(null);
    }
  }, []);

  const publish = async () => {
    if (!file || !info) return;
    setBusy(true);
    setError(null);
    setSteps([]);
    try {
      const result = await publishApk({
        token,
        manifestRepo: settings.manifestRepo,
        uploadsRepo,
        file,
        info,
        name,
        changelog,
        icon,
        onStep: (message) => setSteps((prev) => [...prev, message]),
      });
      setDone({ apkUrl: result.apkUrl, releaseUrl: result.releaseUrl });
      await refreshStorefront();
    } catch (e) {
      setError(
        e instanceof VersionConflictError
          ? `${e.message}. Витрина не изменена.`
          : `${(e as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const installedVersion = storefront?.apps.find((app) => app.id === info?.packageName);
  const ready = Boolean(file && info && token && settings.manifestRepo && name.trim() && !busy);

  return (
    <div className="page">
      <header>
        <h1>Загрузка APK в личный магазин</h1>
        <p className="muted">
          Метаданные читаются прямо из APK в браузере, файл уходит в GitHub Release, запись — в
          <code> apps.json</code>. Бэкенда нет: всё делается вашим токеном.
        </p>
      </header>

      <section>
        <h2>1. Куда публикуем</h2>
        <label>
          Репозиторий витрины
          <input
            value={settings.manifestRepo}
            onChange={(e) => setSettings({ ...settings, manifestRepo: e.target.value.trim() })}
            placeholder="владелец/app-store-manifest"
            spellCheck={false}
          />
        </label>
        <label>
          Репозиторий-хранилище APK
          <input
            value={settings.uploadsRepo}
            onChange={(e) => setSettings({ ...settings, uploadsRepo: e.target.value.trim() })}
            placeholder={uploadsRepo || 'владелец/app-store-uploads'}
            spellCheck={false}
          />
        </label>
        <label>
          GitHub-токен <span className="muted">(права Contents: read and write на оба репозитория)</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value.trim())}
            placeholder="github_pat_…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="hint">
          Токен хранится только в sessionStorage этой вкладки и уходит исключительно на api.github.com.
          Закройте вкладку — он забудется.
        </p>
      </section>

      <section>
        <h2>2. APK</h2>
        <div
          className={`dropzone${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files[0];
            if (dropped) void onApkSelected(dropped);
          }}
          onClick={() => apkInputRef.current?.click()}
        >
          {file ? <strong>{file.name}</strong> : 'Перетащите APK сюда или нажмите, чтобы выбрать'}
          <input
            ref={apkInputRef}
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            hidden
            onChange={(e) => {
              const selected = e.target.files?.[0];
              if (selected) void onApkSelected(selected);
            }}
          />
        </div>

        {info && (
          <div className="card">
            <dl>
              <dt>Пакет</dt>
              <dd>
                <code>{info.packageName}</code>
              </dd>
              <dt>Версия</dt>
              <dd>
                {info.versionName} ({info.versionCode})
                {installedVersion && (
                  <span className="muted">
                    {' '}
                    · в витрине {installedVersion.versionName} ({installedVersion.versionCode})
                  </span>
                )}
              </dd>
              <dt>Размер</dt>
              <dd>{formatBytes(info.sizeBytes)}</dd>
              <dt>sha256</dt>
              <dd>
                <code className="hash">{info.sha256}</code>
              </dd>
              <dt>Подпись</dt>
              <dd>{info.signed ? '✅ есть' : '❌ APK не подписан — система его не установит'}</dd>
            </dl>

            <label>
              Название в магазине
              {info.label === null && (
                <span className="muted"> (в APK это ссылка на ресурс — впишите вручную)</span>
              )}
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <label>
              Что нового
              <textarea
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                rows={3}
                placeholder={`Версия ${info.versionName}`}
              />
            </label>

            <label>
              Иконка <span className="muted">(PNG, необязательно)</span>
              <input
                type="file"
                accept="image/png"
                onChange={(e) => setIcon(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
        )}
      </section>

      <section>
        <h2>3. Публикация</h2>
        <button type="button" onClick={publish} disabled={!ready}>
          {busy ? 'Публикую…' : 'Опубликовать в магазин'}
        </button>

        {steps.length > 0 && (
          <ol className="steps">
            {steps.map((step, index) => (
              <li key={`${step}-${index}`}>{step}</li>
            ))}
          </ol>
        )}

        {error && <p className="error">{error}</p>}

        {done && (
          <div className="done">
            <p>Готово. Откройте магазин на телефоне и потяните список вниз.</p>
            <p>
              <a href={done.releaseUrl} target="_blank" rel="noreferrer">
                Release
              </a>{' '}
              ·{' '}
              <a href={done.apkUrl} target="_blank" rel="noreferrer">
                APK
              </a>
            </p>
          </div>
        )}
      </section>

      {storefront && (
        <section>
          <h2>Витрина сейчас</h2>
          <ul className="storefront">
            {storefront.apps.map((app) => (
              <li key={app.id}>
                <strong>{app.name}</strong> <span className="muted">{app.id}</span>
                <span className="version">
                  {app.versionName} ({app.versionCode})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
