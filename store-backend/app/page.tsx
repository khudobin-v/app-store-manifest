'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { readApk, type ApkInfo } from '@/lib/apk/apk';
import { checkVersion, type AppEntry, type Manifest } from '@/lib/manifest';

interface Session {
  login: string;
  role: 'owner' | 'publisher';
}

interface User {
  login: string;
  role: 'owner' | 'publisher';
  createdAt: string;
  createdBy?: string;
}

interface Stats {
  apps: number;
  versions: number;
  bytes: number;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} МБ`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function date(iso: string | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const manifest = await api<Manifest>('/api/apps');
    setCatalog(manifest);
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

  const versionCount = catalog?.apps.reduce((sum, app) => sum + app.versions.length, 0) ?? null;
  const apkBytes = catalog?.apps.reduce((sum, app) => sum + app.apkSizeBytes, 0) ?? null;

  if (session === undefined) {
    return <main className="shell muted">Загрузка…</main>;
  }

  if (session === null) {
    return <Login onSuccess={(entered) => setSession(entered)} />;
  }

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <h1>Магазин приложений</h1>
          <div className="endpoint">
            <span>/api/apps</span>
            <CopyButton value={`${typeof window === 'undefined' ? '' : window.location.origin}/api/apps`} />
          </div>
        </div>
        <div className="who">
          <span className="mono">{session.login}</span>
          <span className="hint">{session.role === 'owner' ? 'владелец' : 'издатель'}</span>
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST' });
              setSession(null);
            }}
          >
            Выйти
          </button>
        </div>
      </header>

      {error && <p className="notice error">{error}</p>}

      <section className="section">
        <h2 className="section-title">Витрина</h2>
        <dl className="stats">
          <div>
            <dt>Приложений</dt>
            <dd>{catalog?.apps.length ?? '—'}</dd>
          </div>
          <div>
            <dt>Версий</dt>
            <dd>{stats?.versions ?? versionCount ?? '—'}</dd>
          </div>
          <div>
            <dt>Объём APK</dt>
            <dd>{apkBytes === null ? '—' : bytes(apkBytes)}</dd>
          </div>
        </dl>
        <p className="hint">
          Объём — сумма размеров последних версий. В Blob-хранилище занято{' '}
          {stats ? bytes(stats.bytes) : '—'}: APK из конвейера лежат в GitHub Releases, там только
          записи каталога и файлы, загруженные вручную.
        </p>
      </section>

      <Publish catalog={catalog} onPublished={load} onError={setError} />

      <section className="section">
        <h2 className="section-title">Каталог</h2>
        <Catalog catalog={catalog} session={session} onChanged={load} onError={setError} />
      </section>

      {session.role === 'owner' && <Users onError={setError} />}
    </main>
  );
}

function Login({ onSuccess }: { onSuccess: (session: Session) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main className="shell login">
      <h1>Магазин приложений</h1>
      <p className="hint">Панель управления витриной</p>
      <form
        style={{ marginTop: 24 }}
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
            onChange={(e) => setLogin(e.target.value)}
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
        <button type="submit" disabled={busy || !password || !login}>
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
      {copied ? 'скопировано' : 'скопировать'}
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
  onError: (message: string | null) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (!catalog) return <p className="empty">Загрузка…</p>;
  if (catalog.apps.length === 0) return <p className="empty">Каталог пуст.</p>;

  return (
    <div className="apps">
      {catalog.apps.map((app) => (
        <div key={app.id}>
          <button
            type="button"
            className="app-row"
            onClick={() => setOpenId(openId === app.id ? null : app.id)}
          >
            <span className="app-icon">
              {app.iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={app.iconUrl} alt="" width={32} height={32} />
              ) : (
                app.name.trim().charAt(0).toUpperCase()
              )}
            </span>
            <span>
              <span className="app-name">{app.name}</span>
              <br />
              <span className="app-package">{app.id}</span>
            </span>
            <span className="app-version">
              {app.versionName} · {bytes(app.apkSizeBytes)}
            </span>
          </button>

          {openId === app.id && (
            <AppDetails app={app} session={session} onChanged={onChanged} onError={onError} />
          )}
        </div>
      ))}
    </div>
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
  onError: (message: string | null) => void;
}) {
  const mine = session.role === 'owner' || app.publishedBy === session.login;
  const [name, setName] = useState(app.name);
  const [iconUrl, setIconUrl] = useState(app.iconUrl ?? '');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try {
      await action();
      await onChanged();
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
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Иконка (URL)
          <input value={iconUrl} onChange={(e) => setIconUrl(e.target.value)} placeholder="https://…" />
        </label>
        <button
          type="button"
          className="ghost"
          disabled={!mine || busy || (name === app.name && iconUrl === (app.iconUrl ?? ''))}
          onClick={() =>
            run(() =>
              api(`/api/apps/${app.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, iconUrl: iconUrl.trim() || null }),
              }),
            )
          }
        >
          Сохранить
        </button>
      </div>

      <table className="versions">
        <thead>
          <tr>
            <th>Версия</th>
            <th>Код</th>
            <th>Размер</th>
            <th>Дата</th>
            <th>APK</th>
            <th />
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
                  файл
                </a>
              </td>
              <td style={{ textAlign: 'right' }}>
                <button
                  type="button"
                  className="danger tiny"
                  disabled={!mine || busy}
                  onClick={() => {
                    if (!confirm(`Удалить версию ${version.versionName} из витрины?`)) return;
                    void run(() =>
                      api(`/api/apps/${app.id}/versions/${version.versionCode}`, { method: 'DELETE' }),
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

      <p className="hint" style={{ marginTop: 14 }}>
        sha256 последней версии: <span className="mono">{app.sha256}</span>
        <br />
        опубликовал: <span className="mono">{app.publishedBy ?? 'ci'}</span>
        {!mine && ' · чужое приложение, изменения недоступны'}
      </p>

      <div className="actions" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="danger"
          disabled={!mine || busy}
          onClick={() => {
            if (!confirm(`Удалить «${app.name}» со всеми версиями? Отменить нельзя.`)) return;
            void run(() => api(`/api/apps/${app.id}`, { method: 'DELETE' }));
          }}
        >
          Удалить приложение
        </button>
        <span className="hint">Файлы APK останутся в хранилище, из витрины запись исчезнет.</span>
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
  onError: (message: string | null) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<ApkInfo | null>(null);
  const [name, setName] = useState('');
  const [changelog, setChangelog] = useState('');
  const [force, setForce] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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
    } catch (e) {
      onError((e as Error).message);
      setFile(null);
    }
  };

  const check = catalog && info ? checkVersion(catalog, info.packageName, info.versionCode) : null;
  const conflict = check?.issue ?? null;
  const ready = Boolean(file && info && name.trim() && !busy && (!conflict || force));

  const publish = async () => {
    if (!file || !info) return;
    setBusy(true);
    onError(null);
    setSteps([]);
    const step = (message: string) => setSteps((prev) => [...prev, message]);

    try {
      step(`Загружаю ${bytes(info.sizeBytes)}`);
      const blob = await upload(`apk/${info.packageName}-${info.versionName}.apk`, file, {
        access: 'public',
        handleUploadUrl: '/api/upload',
        contentType: 'application/vnd.android.package-archive',
      });

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
        }),
      });

      step('Готово');
      setFile(null);
      setInfo(null);
      setChangelog('');
      await onPublished();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <h2 className="section-title">Публикация</h2>

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
        {file ? <span className="mono">{file.name}</span> : 'Перетащите APK или нажмите, чтобы выбрать'}
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
        <>
          <dl className="meta">
            <dt>Пакет</dt>
            <dd>{info.packageName}</dd>
            <dt>Версия</dt>
            <dd>
              {info.versionName} ({info.versionCode})
              {check?.publishedVersionCode ? (
                <span className="muted"> · в витрине {check.publishedVersionCode}</span>
              ) : null}
            </dd>
            <dt>Размер</dt>
            <dd>{bytes(info.sizeBytes)}</dd>
            <dt>sha256</dt>
            <dd>{info.sha256}</dd>
            <dt>Подпись</dt>
            <dd>{info.signed ? 'есть' : 'нет — система не установит'}</dd>
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
              <p className="hint">
                На телефон обновление приедет только при выросшем versionCode: Android не ставит APK
                с тем же или меньшим кодом поверх установленного.
              </p>
              <label className="checkbox">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                Всё равно перезалить
              </label>
            </div>
          )}

          <div className="actions" style={{ marginTop: 18 }}>
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
        </>
      )}

      {steps.length > 0 && (
        <ul className="steps">
          {steps.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Users({ onError }: { onError: (message: string | null) => void }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'owner' | 'publisher'>('publisher');
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

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try {
      await action();
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <h2 className="section-title">Пользователи</h2>

      {users && users.length > 0 ? (
        <table className="versions">
          <thead>
            <tr>
              <th>Логин</th>
              <th>Роль</th>
              <th>Заведён</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.login}>
                <td>{user.login}</td>
                <td className="text">{user.role === 'owner' ? 'владелец' : 'издатель'}</td>
                <td>{date(user.createdAt)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={busy}
                    onClick={() => {
                      const next = prompt(`Новый пароль для ${user.login} (минимум 8 символов)`);
                      if (!next) return;
                      void run(() =>
                        api(`/api/users/${user.login}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ password: next }),
                        }),
                      );
                    }}
                  >
                    Сменить пароль
                  </button>{' '}
                  <button
                    type="button"
                    className="danger tiny"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`Удалить ${user.login}? Его приложения останутся в витрине.`)) return;
                      void run(() => api(`/api/users/${user.login}`, { method: 'DELETE' }));
                    }}
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">Учётных записей пока нет — вход только по паролю владельца.</p>
      )}

      <div className="field-row" style={{ marginTop: 20 }}>
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
          <select value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'publisher')}>
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
            })
          }
        >
          Добавить
        </button>
      </div>

      <p className="hint">
        Издатель публикует приложения и правит только свои. Владелец распоряжается всем каталогом и
        учётными записями. Пароли хранятся хешами PBKDF2, восстановить их нельзя — только задать новый.
      </p>
    </section>
  );
}
