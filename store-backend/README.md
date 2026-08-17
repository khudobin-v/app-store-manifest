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
| `STORE_PASSWORD` | пароль входа в веб-интерфейс |
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
