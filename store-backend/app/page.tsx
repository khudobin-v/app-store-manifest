'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { readApk, type ApkInfo } from '@/lib/apk/apk';
import { checkVersion, type Manifest } from '@/lib/manifest';

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  return `${(value / 1024 / 1024).toFixed(1)} МБ`;
}

export default function Home() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [catalog, setCatalog] = useState<Manifest | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<ApkInfo | null>(null);
  const [name, setName] = useState('');
  const [changelog, setChangelog] = useState('');
  const [force, setForce] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const apkInput = useRef<HTMLInputElement>(null);

  const loadCatalog = useCallback(async () => {
    const response = await fetch('/api/apps', { cache: 'no-store' });
    if (response.ok) setCatalog((await response.json()) as Manifest);
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await fetch('/api/auth/session', { cache: 'no-store' });
      const data = (await response.json()) as { authorized: boolean };
      setAuthorized(data.authorized);
      await loadCatalog();
    })();
  }, [loadCatalog]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (response.ok) {
      setAuthorized(true);
      setPassword('');
    } else {
      const data = (await response.json()) as { error?: string };
      setError(data.error ?? 'не удалось войти');
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuthorized(false);
  };

  const onApkSelected = async (selected: File) => {
    setError(null);
    setDone(null);
    setSteps([]);
    setForce(false);
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
  };

  const publish = async () => {
    if (!file || !info) return;
    setBusy(true);
    setError(null);
    setSteps([]);
    const step = (message: string) => setSteps((prev) => [...prev, message]);

    try {
      step(`Загружаю ${formatBytes(info.sizeBytes)} в хранилище…`);
      const blob = await upload(`apk/${info.packageName}-${info.versionName}.apk`, file, {
        access: 'public',
        handleUploadUrl: '/api/upload',
        contentType: 'application/vnd.android.package-archive',
      });

      step('Обновляю витрину…');
      const response = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: info.packageName,
          name,
          versionCode: info.versionCode,
          versionName: info.versionName,
          apkUrl: blob.url,
          sha256: info.sha256,
          apkSizeBytes: info.sizeBytes,
          changelog,
          force,
        }),
      });

      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);

      step('Готово');
      setDone(blob.url);
      await loadCatalog();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (authorized === null) return <main className="page">Загрузка…</main>;

  if (!authorized) {
    return (
      <main className="page">
        <h1>Личный магазин</h1>
        <form className="card" onSubmit={login}>
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </label>
          <button type="submit">Войти</button>
          {error && <p className="error">{error}</p>}
        </form>
        {catalog && <Catalog manifest={catalog} />}
      </main>
    );
  }

  const published = catalog && info ? checkVersion(catalog, info.packageName, info.versionCode) : null;
  const conflict = published?.issue ?? null;
  const ready = Boolean(file && info && name.trim() && !busy && (!conflict || force));

  return (
    <main className="page">
      <header className="row">
        <h1>Загрузка APK</h1>
        <button type="button" className="secondary" onClick={logout}>
          Выйти
        </button>
      </header>

      <section className="card">
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
          onClick={() => apkInput.current?.click()}
        >
          {file ? <strong>{file.name}</strong> : 'Перетащите APK сюда или нажмите, чтобы выбрать'}
          <input
            ref={apkInput}
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
          <>
            <dl>
              <dt>Пакет</dt>
              <dd>
                <code>{info.packageName}</code>
              </dd>
              <dt>Версия</dt>
              <dd>
                {info.versionName} ({info.versionCode})
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
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Что нового
              <textarea
                rows={3}
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                placeholder={`Версия ${info.versionName}`}
              />
            </label>

            {conflict && (
              <div className="warning">
                <p>
                  {conflict === 'duplicate'
                    ? `Версия ${info.versionName} (versionCode ${info.versionCode}) уже опубликована.`
                    : `В витрине есть версия новее: versionCode ${published?.publishedVersionCode} против ${info.versionCode}.`}{' '}
                  Публикация заменит эту запись и перезальёт APK.
                </p>
                <p className="hint">
                  На телефон обновление приедет только при выросшем versionCode: Android не ставит
                  APK с тем же или меньшим versionCode поверх установленного.
                </p>
                <label className="checkbox">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  Всё равно перезалить
                </label>
              </div>
            )}

            <button type="button" onClick={publish} disabled={!ready}>
              {busy ? 'Публикую…' : conflict && force ? 'Перезалить' : 'Опубликовать'}
            </button>
          </>
        )}

        {steps.length > 0 && (
          <ol className="steps">
            {steps.map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
          </ol>
        )}
        {error && <p className="error">{error}</p>}
        {done && (
          <p className="done">
            Опубликовано.{' '}
            <a href={done} target="_blank" rel="noreferrer">
              APK
            </a>
          </p>
        )}
      </section>

      {catalog && <Catalog manifest={catalog} />}
    </main>
  );
}

function Catalog({ manifest }: { manifest: Manifest }) {
  return (
    <section className="card">
      <h2>Витрина</h2>
      {manifest.apps.length === 0 ? (
        <p className="hint">Пока пусто.</p>
      ) : (
        <ul className="catalog">
          {manifest.apps.map((app) => (
            <li key={app.id}>
              <strong>{app.name}</strong> <span className="hint">{app.id}</span>
              <span className="version">
                {app.versionName} ({app.versionCode})
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
