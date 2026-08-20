'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { readApk, type ApkInfo } from '@/lib/apk/apk';
import { checkVersion, type AppEntry, type Manifest } from '@/lib/manifest';
import { QrCode } from './QrCode';

/** Пакет самого магазина: его APK предлагается поставить по QR. */
const STORE_PACKAGE = 'com.personal.appstore';

type Role = 'owner' | 'publisher';

interface Session {
  login: string;
  role: Role;
}

interface User {
  login: string;
  role: Role;
  createdAt: string;
  createdBy?: string;
}

interface Stats {
  apps: number;
  versions: number;
  bytes: number;
}

type Tab = 'catalog' | 'publish' | 'users';

/** Размер числом и единицей отдельно: единица набирается мельче. */
function size(value: number): [string, string] {
  if (value < 1024) return [String(value), 'Б'];
  if (value < 1024 * 1024) return [String(Math.round(value / 1024)), 'КБ'];
  if (value < 1024 * 1024 * 1024) return [(value / 1024 / 1024).toFixed(1), 'МБ'];
  return [(value / 1024 / 1024 / 1024).toFixed(2), 'ГБ'];
}

function bytes(value: number): string {
  return size(value).join(' ');
}

function date(iso: string | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...init });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export default function Admin() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [catalog, setCatalog] = useState<Manifest | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tab, setTab] = useState<Tab>('catalog');
  const [toast, setToast] = useState<{ text: string; kind: 'error' | 'ok' } | null>(null);

  const notify = useCallback((text: string | null, kind: 'error' | 'ok' = 'error') => {
    setToast(text ? { text, kind } : null);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.kind === 'ok' ? 2600 : 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const load = useCallback(async () => {
    try {
      setCatalog(await api<Manifest>('/api/apps'));
    } catch (e) {
      // Молчать нельзя: без витрины панель не увидит уже опубликованных версий.
      setToast({ text: `Витрина не загрузилась: ${(e as Error).message}`, kind: 'error' });
    }
    try {
      setStats(await api<Stats>('/api/stats'));
    } catch {
      setStats(null); // без сессии сводка недоступна — это нормально
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const current = await api<{ authorized: boolean } & Session>('/api/auth/session');
      setSession(current.authorized ? { login: current.login, role: current.role } : null);
      await load();
    })();
  }, [load]);

  if (session === undefined) {
    return (
      <main className="shell">
        <div style={{ maxWidth: 320, marginTop: '20vh' }}>
          <div className="skeleton" style={{ width: '40%' }} />
          <div className="skeleton" style={{ width: '70%' }} />
        </div>
      </main>
    );
  }

  if (session === null) return <Login onSuccess={setSession} />;

  const apkBytes = catalog?.apps.reduce((sum, app) => sum + app.apkSizeBytes, 0) ?? 0;
  const versions = stats?.versions ?? catalog?.apps.reduce((sum, a) => sum + a.versions.length, 0) ?? 0;
  const [apkValue, apkUnit] = size(apkBytes);
  const storeApp = catalog?.apps.find((app) => app.id === STORE_PACKAGE) ?? null;

  return (
    <>
      <main className="shell">
        <header className="masthead">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              М
            </span>
            <div style={{ minWidth: 0 }}>
              <h1>Магазин приложений</h1>
              <span className="sub">
                {typeof window === 'undefined' ? '' : window.location.host}/api/apps{' '}
                <CopyButton
                  value={`${typeof window === 'undefined' ? '' : window.location.origin}/api/apps`}
                />
              </span>
            </div>
          </div>

          <div className="who">
            <div className="who-name">
              <b>{session.login}</b>
              <span>{session.role === 'owner' ? 'владелец' : 'издатель'}</span>
            </div>
            <button
              type="button"
              className="ghost tiny"
              onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST' });
                setSession(null);
              }}
            >
              Выйти
            </button>
          </div>
        </header>

        <nav className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === 'catalog'}
            onClick={() => setTab('catalog')}
          >
            Витрина<span className="count">{catalog?.apps.length ?? '—'}</span>
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === 'publish'}
            onClick={() => setTab('publish')}
          >
            Публикация
          </button>
          {session.role === 'owner' && (
            <button
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === 'users'}
              onClick={() => setTab('users')}
            >
              Пользователи
            </button>
          )}
        </nav>

        {tab === 'catalog' && (
          <>
            <section className="block">
              <dl className="stats">
                <div>
                  <dt>Приложений</dt>
                  <dd>{catalog?.apps.length ?? '—'}</dd>
                </div>
                <div>
                  <dt>Версий</dt>
                  <dd>{versions}</dd>
                </div>
                <div>
                  <dt>Объём APK</dt>
                  <dd>
                    {apkValue}
                    <small>{apkUnit}</small>
                  </dd>
                </div>
              </dl>
            </section>

            <section className="block">
              <div className="block-head">
                <h2 className="block-title">Приложения</h2>
                <button type="button" className="link" onClick={() => void load()}>
                  обновить
                </button>
              </div>
              <Catalog catalog={catalog} session={session} onChanged={load} onError={notify} />
              {stats && (
                <p className="hint">
                  В Blob-хранилище занято {bytes(stats.bytes)}: APK из конвейера лежат в GitHub
                  Releases, здесь только записи каталога и файлы, загруженные вручную.
                </p>
              )}
            </section>

            {storeApp && (
              <section className="block">
                <div className="block-head">
                  <h2 className="block-title">Магазин на телефон</h2>
                </div>
                <div className="card install">
                  <QrCode value={storeApp.apkUrl} />
                  <div>
                    <p style={{ margin: 0 }}>
                      Наведите камеру — скачается{' '}
                      <b>
                        {storeApp.name} {storeApp.versionName}
                      </b>
                      .
                    </p>
                    <p className="hint">
                      Поставить нужно один раз: дальше магазин обновляет себя сам. Телефон попросит
                      разрешить установку из этого источника — это нормально.
                    </p>
                    <div className="actions" style={{ marginTop: 'var(--s-3)' }}>
                      <CopyButton value={storeApp.apkUrl} />
                    </div>
                  </div>
                </div>
              </section>
            )}
          </>
        )}

        {tab === 'publish' && (
          <Publish
            catalog={catalog}
            onPublished={async () => {
              await load();
              notify('Опубликовано', 'ok');
              setTab('catalog');
            }}
            onError={notify}
          />
        )}

        {tab === 'users' && session.role === 'owner' && <Users session={session} onError={notify} />}
      </main>

      {toast && (
        <div className={`toast${toast.kind === 'error' ? ' error' : ''}`} role="status">
          <span>{toast.text}</span>
          <button type="button" className="link" onClick={() => setToast(null)}>
            закрыть
          </button>
        </div>
      )}
    </>
  );
}

function Login({ onSuccess }: { onSuccess: (session: Session) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main className="login">
      <span className="brand-mark" aria-hidden="true">
        М
      </span>
      <h1>Магазин приложений</h1>
      <p>Панель управления витриной</p>

      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const result = await api<Session>('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ login, password }),
            });
            onSuccess({ login: result.login, role: result.role });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Логин
          <input
            value={login}
            onChange={(e) => setLogin(e.target.value.trim().toLowerCase())}
            autoFocus
            autoComplete="username"
            spellCheck={false}
          />
        </label>
        <label>
          Пароль
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button type="submit" disabled={busy || !login || !password}>
          {busy ? 'Проверяю…' : 'Войти'}
        </button>
        {error && <p className="notice error">{error}</p>}
      </form>
    </main>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'скопировано' : 'копировать'}
    </button>
  );
}

function Catalog({
  catalog,
  session,
  onChanged,
  onError,
}: {
  catalog: Manifest | null;
  session: Session;
  onChanged: () => Promise<void>;
  onError: (message: string | null, kind?: 'error' | 'ok') => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  if (!catalog) {
    return (
      <div className="apps" style={{ padding: 'var(--s-4)' }}>
        <div className="skeleton" style={{ width: '55%' }} />
        <div className="skeleton" style={{ width: '35%' }} />
        <div className="skeleton" style={{ width: '45%' }} />
      </div>
    );
  }

  if (catalog.apps.length === 0) {
    return <p className="empty">Пока пусто. Опубликуйте первое приложение на вкладке «Публикация».</p>;
  }

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? catalog.apps.filter(
        (app) => app.name.toLowerCase().includes(needle) || app.id.toLowerCase().includes(needle),
      )
    : catalog.apps;

  return (
    <>
      {catalog.apps.length > 1 && (
        <div className="search">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по названию или пакету"
            spellCheck={false}
            aria-label="Поиск по каталогу"
          />
          {needle && (
            <span className="search-count">
              {shown.length} из {catalog.apps.length}
            </span>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="empty">Ничего не найдено по запросу «{query.trim()}».</p>
      ) : (
    <div className="apps">
      {shown.map((app) => {
        const open = openId === app.id;
        return (
          <div key={app.id}>
            <button
              type="button"
              className="app-row"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : app.id)}
            >
              <span className="app-icon">
                {app.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={app.iconUrl} alt="" width={34} height={34} />
                ) : (
                  app.name.trim().charAt(0).toUpperCase()
                )}
              </span>
              <span className="app-title">
                <span className="app-name">{app.name}</span>
                <span className="app-package">{app.id}</span>
              </span>
              <span className="app-meta">
                <span>{app.versionName}</span>
                <span>{bytes(app.apkSizeBytes)}</span>
                <span>{date(app.releasedAt)}</span>
              </span>
              <span className="chevron" aria-hidden="true" />
            </button>

            {open && <AppDetails app={app} session={session} onChanged={onChanged} onError={onError} />}
          </div>
        );
      })}
    </div>
      )}
    </>
  );
}

function AppDetails({
  app,
  session,
  onChanged,
  onError,
}: {
  app: AppEntry;
  session: Session;
  onChanged: () => Promise<void>;
  onError: (message: string | null, kind?: 'error' | 'ok') => void;
}) {
  const mine = session.role === 'owner' || app.publishedBy === session.login;
  const [name, setName] = useState(app.name);
  const [iconUrl, setIconUrl] = useState(app.iconUrl ?? '');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    onError(null);
    try {
      await action();
      await onChanged();
      if (done) onError(done, 'ok');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="details">
      <div className="field-row">
        <label>
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!mine} />
        </label>
        <label>
          Иконка
          <input
            value={iconUrl}
            onChange={(e) => setIconUrl(e.target.value)}
            placeholder="https://…"
            disabled={!mine}
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="ghost"
          disabled={!mine || busy || (name === app.name && iconUrl === (app.iconUrl ?? ''))}
          onClick={() =>
            run(
              () =>
                api(`/api/apps/${app.id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name, iconUrl: iconUrl.trim() || null }),
                }),
              'Сохранено',
            )
          }
        >
          Сохранить
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Версия</th>
            <th>Код</th>
            <th>Размер</th>
            <th>Дата</th>
            <th>APK</th>
            <th className="right" />
          </tr>
        </thead>
        <tbody>
          {app.versions.map((version) => (
            <tr key={version.versionCode}>
              <td>{version.versionName}</td>
              <td>{version.versionCode}</td>
              <td>{bytes(version.apkSizeBytes)}</td>
              <td>{date(version.releasedAt)}</td>
              <td>
                <a href={version.apkUrl} target="_blank" rel="noreferrer">
                  скачать
                </a>
              </td>
              <td className="right">
                <button
                  type="button"
                  className="danger tiny"
                  disabled={!mine || busy}
                  onClick={() => {
                    if (!confirm(`Удалить версию ${version.versionName} из витрины?`)) return;
                    void run(
                      () =>
                        api(`/api/apps/${app.id}/versions/${version.versionCode}`, {
                          method: 'DELETE',
                        }),
                      'Версия удалена',
                    );
                  }}
                >
                  Удалить
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="install">
        <QrCode value={app.apkUrl} size={120} />
        <div>
          <h3 className="block-title" style={{ marginBottom: 'var(--s-2)' }}>
            Установка
          </h3>
          <p className="hint" style={{ margin: 0 }}>
            Наведите камеру телефона — скачается{' '}
            <span className="mono">
              {app.versionName} ({app.versionCode})
            </span>
            . Ставится как обычный APK; если магазин уже стоит, обновляйтесь через него.
          </p>
          <div className="actions" style={{ marginTop: 'var(--s-3)' }}>
            <CopyButton value={app.apkUrl} />
          </div>
        </div>
      </div>

      <dl className="meta" style={{ marginTop: 'var(--s-5)' }}>
        <dt>Опубликовал</dt>
        <dd>{app.publishedBy ?? 'ci'}</dd>
        <dt>Changelog</dt>
        <dd style={{ fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>{app.changelog}</dd>
        <dt>sha256</dt>
        <dd>{app.sha256}</dd>
      </dl>

      <div className="actions">
        <button
          type="button"
          className="danger"
          disabled={!mine || busy}
          onClick={() => {
            if (!confirm(`Удалить «${app.name}» со всеми версиями? Отменить нельзя.`)) return;
            void run(() => api(`/api/apps/${app.id}`, { method: 'DELETE' }), 'Приложение удалено');
          }}
        >
          Удалить приложение
        </button>
        <span className="hint" style={{ margin: 0 }}>
          {mine
            ? 'Файлы APK останутся в хранилище, из витрины запись исчезнет.'
            : 'Приложение опубликовано не вами — изменения недоступны.'}
        </span>
      </div>
    </div>
  );
}

function Publish({
  catalog,
  onPublished,
  onError,
}: {
  catalog: Manifest | null;
  onPublished: () => Promise<void>;
  onError: (message: string | null, kind?: 'error' | 'ok') => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<ApkInfo | null>(null);
  const [name, setName] = useState('');
  const [changelog, setChangelog] = useState('');
  const [force, setForce] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Превью живёт как object URL — освобождаем при смене файла.
  useEffect(() => () => {
    if (iconPreview) URL.revokeObjectURL(iconPreview);
  }, [iconPreview]);

  const select = async (selected: File) => {
    onError(null);
    setSteps([]);
    setForce(false);
    setFile(selected);
    setInfo(null);
    try {
      const parsed = await readApk(new Uint8Array(await selected.arrayBuffer()));
      setInfo(parsed);
      setName(parsed.label ?? parsed.packageName);
      setIconPreview(
        parsed.icon
          ? URL.createObjectURL(new Blob([parsed.icon.bytes as BlobPart], { type: parsed.icon.mime }))
          : null,
      );
    } catch (e) {
      onError((e as Error).message);
      setFile(null);
    }
  };

  const check = catalog && info ? checkVersion(catalog, info.packageName, info.versionCode) : null;
  const conflict = check?.issue ?? null;
  const ready = Boolean(catalog && file && info && name.trim() && !busy && (!conflict || force));

  const publish = async () => {
    if (!file || !info) return;
    setBusy(true);
    onError(null);
    setSteps([]);
    const step = (message: string) => setSteps((prev) => [...prev, message]);

    try {
      step(`Загружаю ${bytes(info.sizeBytes)} в хранилище`);
      const blob = await upload(`apk/${info.packageName}-${info.versionName}.apk`, file, {
        access: 'public',
        handleUploadUrl: '/api/upload',
        contentType: 'application/vnd.android.package-archive',
      });

      let iconUrl: string | undefined;
      if (info.icon) {
        step('Загружаю иконку из APK');
        const extension = info.icon.path.split('.').pop() ?? 'png';
        const iconBlob = await upload(
          `icons/${info.packageName}-${info.versionCode}.${extension}`,
          new Blob([info.icon.bytes as BlobPart], { type: info.icon.mime }),
          { access: 'public', handleUploadUrl: '/api/upload', contentType: info.icon.mime },
        );
        iconUrl = iconBlob.url;
      }

      step('Обновляю витрину');
      await api('/api/apps', {
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
          ...(iconUrl ? { iconUrl } : {}),
        }),
      });

      setFile(null);
      setInfo(null);
      setChangelog('');
      setSteps([]);
      setIconPreview(null);
      await onPublished();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="block">
      <div className="block-head">
        <h2 className="block-title">Новая версия</h2>
      </div>

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
          if (dropped) void select(dropped);
        }}
        onClick={() => input.current?.click()}
      >
        {file ? (
          <>
            <strong>{file.name}</strong>
            <span>нажмите, чтобы выбрать другой</span>
          </>
        ) : (
          <>
            <strong>Перетащите APK</strong>
            <span>или нажмите, чтобы выбрать файл</span>
          </>
        )}
        <input
          ref={input}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          hidden
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) void select(selected);
          }}
        />
      </div>

      {info && (
        <div className="card">
          <dl className="meta">
            <dt>Пакет</dt>
            <dd>{info.packageName}</dd>
            <dt>Версия</dt>
            <dd>
              {info.versionName} ({info.versionCode})
              {!catalog ? (
                <span className="muted"> · витрина не загружена</span>
              ) : check?.publishedVersionCode ? (
                <span className="muted"> · в витрине код {check.publishedVersionCode}</span>
              ) : (
                <span className="muted"> · новое приложение</span>
              )}
            </dd>
            <dt>Размер</dt>
            <dd>{bytes(info.sizeBytes)}</dd>
            <dt>sha256</dt>
            <dd>{info.sha256}</dd>
            <dt>Подпись</dt>
            <dd>
              <span className={`badge ${info.signed ? 'ok' : 'bad'}`}>
                {info.signed ? 'подписан' : 'не подписан'}
              </span>
            </dd>
            <dt>Иконка</dt>
            <dd>
              {iconPreview ? (
                <span className="icon-found">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={iconPreview} alt="" width={28} height={28} />
                  <span className="muted">{info.icon?.path}</span>
                </span>
              ) : (
                <span className="muted">
                  не нашлась — в APK только вектор; можно указать ссылку в карточке приложения
                </span>
              )}
            </dd>
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
            <div className="notice warn">
              <p>
                {conflict === 'duplicate'
                  ? `Версия ${info.versionName} (код ${info.versionCode}) уже опубликована.`
                  : `В витрине есть версия новее: код ${check?.publishedVersionCode} против ${info.versionCode}.`}{' '}
                Публикация заменит запись и перезальёт APK.
              </p>
              <p className="hint" style={{ margin: '0 0 8px' }}>
                На телефон обновление приедет только при выросшем versionCode: Android не ставит APK
                с тем же или меньшим кодом поверх установленного.
              </p>
              <label className="checkbox">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                Всё равно перезалить
              </label>
            </div>
          )}

          <div className="actions" style={{ marginTop: 'var(--s-5)' }}>
            <button type="button" onClick={publish} disabled={!ready}>
              {busy ? 'Публикую…' : conflict && force ? 'Перезалить' : 'Опубликовать'}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setFile(null);
                setInfo(null);
                setSteps([]);
              }}
            >
              Отмена
            </button>
          </div>

          {steps.length > 0 && (
            <ul className="steps">
              {steps.map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function Users({
  session,
  onError,
}: {
  session: Session;
  onError: (message: string | null, kind?: 'error' | 'ok') => void;
}) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('publisher');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ users: User[] }>('/api/users');
      setUsers(data.users);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    onError(null);
    try {
      await action();
      await load();
      if (done) onError(done, 'ok');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="block">
        <div className="block-head">
          <h2 className="block-title">Учётные записи</h2>
        </div>

        {users === null ? (
          <div className="skeleton" style={{ width: '60%' }} />
        ) : users.length === 0 ? (
          <p className="empty">
            Учёток пока нет. Вы вошли аварийным паролем владельца — заведите себе обычную запись ниже.
          </p>
        ) : (
          <div className="apps" style={{ padding: '0 var(--s-4)' }}>
            <table>
              <thead>
                <tr>
                  <th>Логин</th>
                  <th>Роль</th>
                  <th>Заведён</th>
                  <th className="right" />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.login}>
                    <td>{user.login}</td>
                    <td className="text">{user.role === 'owner' ? 'владелец' : 'издатель'}</td>
                    <td>{date(user.createdAt)}</td>
                    <td className="right">
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className="ghost tiny"
                          disabled={busy}
                          onClick={() => {
                            const next = prompt(`Новый пароль для ${user.login} (от 8 символов)`);
                            if (!next) return;
                            void run(
                              () =>
                                api(`/api/users/${user.login}`, {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ password: next }),
                                }),
                              'Пароль изменён',
                            );
                          }}
                        >
                          Сменить пароль
                        </button>
                        <button
                          type="button"
                          className="danger tiny"
                          disabled={busy || user.login === session.login}
                          onClick={() => {
                            if (!confirm(`Удалить ${user.login}? Его приложения останутся в витрине.`))
                              return;
                            void run(
                              () => api(`/api/users/${user.login}`, { method: 'DELETE' }),
                              'Учётка удалена',
                            );
                          }}
                        >
                          Удалить
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="block">
        <div className="block-head">
          <h2 className="block-title">Новый пользователь</h2>
        </div>

        <div className="card">
          <div className="field-row">
            <label>
              Логин
              <input
                value={login}
                onChange={(e) => setLogin(e.target.value.toLowerCase())}
                placeholder="ivan"
                spellCheck={false}
              />
            </label>
            <label>
              Пароль
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <label style={{ flex: '0 0 150px' }}>
              Роль
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="publisher">издатель</option>
                <option value="owner">владелец</option>
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !login || password.length < 8}
              onClick={() =>
                run(async () => {
                  await api('/api/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ login, password, role }),
                  });
                  setLogin('');
                  setPassword('');
                }, 'Пользователь добавлен')
              }
            >
              Добавить
            </button>
          </div>

          <p className="hint" style={{ margin: 0 }}>
            Издатель публикует приложения и правит только свои. Владелец распоряжается всем каталогом
            и учётками. Пароли хранятся хешами PBKDF2 — восстановить нельзя, только задать новый.
            Издатель может опубликовать APK, который встанет на телефоны без диалога: зовите тех,
            кому доверяете.
          </p>
        </div>
      </section>
    </>
  );
}
