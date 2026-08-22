# store-backend — витрина личного магазина на Vercel

Замена связки «репозиторий манифеста + raw.githubusercontent»: каталог и
загрузка живут на бэкенде. Next.js (App Router) + Vercel Blob.

Что это чинит по сравнению с решением на GitHub:

- **свежесть** — `GET /api/apps` отдаётся с `Cache-Control: no-store`, а не через
  CDN с пятиминутным кэшем; телефон видит новую версию сразу;
- **загрузка из браузера** — файл идёт прямо в Blob по короткоживущему токену,
  без CORS-плясок вокруг `uploads.github.com` и без лимита 4.5 МБ на функцию;
- **никаких PAT** — CI публикует одним POST с токеном, репозиторий манифеста и
  `MANIFEST_PAT` больше не нужны;
- **обычный вход по паролю** для человека, отдельный токен для CI.

## API

| Метод | Путь | Кто | Что делает |
|---|---|---|---|
| `GET` | `/api/apps` | все | витрина в формате `schemaVersion 1` — тот же контракт, что понимает Android-клиент |
| `POST` | `/api/apps` | сессия или `Bearer PUBLISH_TOKEN` | публикует версию; `409`, если `versionCode` повторяется |
| `POST` | `/api/upload` | сессия | выдаёт токен на прямую загрузку APK в Blob |
| `POST` | `/api/auth/login` | все | вход по паролю, ставит подписанную куку |
| `POST` | `/api/auth/logout` | все | выход |
| `GET` | `/api/auth/session` | все | есть ли сессия |

Тело `POST /api/apps`:

```json
{
  "id": "com.example.app", "name": "My App",
  "versionCode": 12, "versionName": "1.4.0",
  "apkUrl": "https://…/com.example.app-1.4.0.apk",
  "sha256": "hex", "apkSizeBytes": 5242880,
  "changelog": "текст", "iconUrl": "https://…", "force": false
}
```

`force: true` разрешает перезалить уже опубликованный `versionCode` — только
для ручной загрузки. CI этот флаг не передаёт: дубликат обязан валить сборку.

## Переменные окружения

| Имя | Зачем |
|---|---|
| `STORE_PASSWORD` | аварийный пароль владельца (вход под `OWNER_LOGIN`) |
| `OWNER_LOGIN` | логин владельца для аварийного входа, по умолчанию `owner` |
| `SESSION_SECRET` | ключ подписи куки сессии (случайная строка) |
| `PUBLISH_TOKEN` | токен для CI, он же кладётся в GitHub Secrets |
| `BLOB_READ_WRITE_TOKEN` | подставляется Vercel при подключении Blob |

## Деплой

```bash
vercel login
vercel link                      # создать проект
vercel blob store add app-store  # хранилище APK и каталога
vercel env add STORE_PASSWORD production
vercel env add SESSION_SECRET production
vercel env add PUBLISH_TOKEN production
vercel deploy --prod
```

## Учётные записи

Друзьям, которые заливают свои приложения, заводятся отдельные учётки — раздел
«Пользователи» в панели (виден только владельцу).

| Роль | Что может |
|---|---|
| владелец | всё: любой каталог, любые учётки, удаление чужих приложений |
| издатель | публиковать и править **только свои** приложения |

Пароли хранятся хешами PBKDF2-SHA256 (210 000 итераций, своя соль) в
`users/<логин>.json` того же Blob. Восстановить пароль нельзя — владелец
задаёт новый.

Аварийный вход владельца по `STORE_PASSWORD` остаётся всегда: если учёток нет
или последняя удалена, войти можно логином `owner` (или значением `OWNER_LOGIN`).

Право на удаление и правку определяется тем, кто публиковал версии: если у
приложения есть хоть одна чужая версия, издатель его не тронет. Публикации из
CI помечаются автором `ci`.

**Кого приглашать.** Издатель может опубликовать APK, который ваш телефон
установит поверх существующего без диалога. Это доступ к устройствам всех, у
кого стоит магазин — зовите только тех, кому доверяете.

## Забыли пароль

Пароль лежит только в переменных окружения проекта Vercel. Хеша нет и «восстановления
по почте» тоже — пользователь один, доступ к проекту и есть право сменить пароль.

Посмотреть текущий (значение попадёт в `.env.local`, файл в `.gitignore`):

```bash
vercel env pull .env.local --environment production
grep STORE_PASSWORD .env.local
```

Сменить:

```bash
npm run set-password
```

Скрипт удаляет старое значение, спрашивает новое и передеплоивает — без нового
деплоя переменная не подхватится. Все открытые сессии остаются валидными: их
подпись зависит от `SESSION_SECRET`, а не от пароля. Чтобы разлогинить всех,
смените и его тем же способом.

## Локально

```bash
npm run dev     # http://localhost:3000
npm test        # 22 теста правил витрины
npm run build
```

Для локальной работы с Blob нужен `BLOB_READ_WRITE_TOKEN` в `.env.local`
(`vercel env pull` после линковки проекта).

## Подключение остального

**Android-клиент**: в `store-client/gradle.properties` заменить `MANIFEST_URL`
на `https://<проект>.vercel.app/api/apps`. Формат ответа не изменился, поэтому
код клиента трогать не нужно; адрес можно поменять и на устройстве.

**CI приложения**: вместо шагов с репозиторием манифеста —

```yaml
      - name: Publish to store
        env:
          STORE_API: ${{ secrets.STORE_API }}
          PUBLISH_TOKEN: ${{ secrets.PUBLISH_TOKEN }}
        run: |
          curl -fsS -X POST "$STORE_API/api/apps" \
            -H "Authorization: Bearer $PUBLISH_TOKEN" \
            -H "Content-Type: application/json" \
            -d @- <<JSON
          {
            "id": "${{ steps.apk.outputs.package }}",
            "name": "${{ steps.apk.outputs.label }}",
            "versionCode": ${{ steps.apk.outputs.version_code }},
            "versionName": "${{ steps.apk.outputs.version_name }}",
            "apkUrl": "https://github.com/${{ github.repository }}/releases/download/${{ steps.tag.outputs.tag }}/${{ steps.apk.outputs.file }}",
            "sha256": "${{ steps.apk.outputs.sha256 }}",
            "apkSizeBytes": ${{ steps.apk.outputs.size }},
            "changelog": $(python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read().strip()))' "${{ steps.tag.outputs.changelog_file }}")
          }
          JSON
```

APK при этом остаются в GitHub Releases — сборка не меняется, трафик бесплатный.
Загруженные вручную APK лежат в Blob. Витрине всё равно: в `apkUrl` любая
https-ссылка.

## Иконка из APK

У приложений с `minSdk 26` растровой иконки в пакете нет вообще: иконка — это
adaptive icon, то есть цвет фона плюс векторные контуры, а картинку рисует сам
Android при отрисовке лаунчера. Проверено на реальном пакете: во всём APK
лежал один PNG — монохромный слой 192×192 для тематических иконок.

Поэтому разбор устроен так: сначала ищется готовый растр (если он есть, брать
его дешевле и точнее), а если растра нет — вектор переводится в SVG
(`lib/apk/vector.ts`) и растрируется уже в браузере через canvas. Синтаксис
`android:pathData` совпадает с атрибутом `d` в SVG, так что контуры переносятся
как есть; переводить приходится цвета, трансформации групп и правило заливки.
Adaptive icon собирается по правилам системы: слои в поле 108×108, видимой
остаётся центральная часть 72×72, края срезает маска.

Имена тегов и атрибутов в оптимизированных сборках вырезаны из пула строк
(`res/BW.xml`, `res/20.png`), поэтому атрибуты опознаются по числовым
идентификаторам системных атрибутов, а слои adaptive icon — по порядку тегов:
background, foreground, monochrome.
