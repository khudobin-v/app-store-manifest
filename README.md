# app-store-manifest — витрина личного магазина приложений

Публичный репозиторий-источник данных. Бэкенда нет: клиент читает один файл

```
https://raw.githubusercontent.com/<owner>/app-store-manifest/main/apps.json
```

Файл пишет только CI репозиториев приложений (через `MANIFEST_PAT`) —
руками его править не нужно.

## Настройка (один раз)

1. Создайте **публичный** репозиторий `app-store-manifest`:

   ```bash
   gh repo create app-store-manifest --public --clone
   ```

2. Скопируйте в него `scripts/update_manifest.py` (и `tests/`, если хотите
   гонять тесты в CI), закоммитьте, запушьте. `apps.json` создастся сам при
   первом релизе.

3. Создайте fine-grained PAT: github.com/settings/personal-access-tokens/new
   - Repository access: **только** этот репозиторий;
   - Permissions: **Contents → Read and write**;
   - положите его в secret `MANIFEST_PAT` каждого репозитория приложения.

4. Пропишите raw-ссылку в клиенте магазина — `store-client/gradle.properties`,
   свойство `MANIFEST_URL`.

Репозиторий должен быть публичным: клиент ходит за `apps.json` без токена.
APK лежат в GitHub Releases репозиториев приложений — они тоже должны быть
публичными, иначе ссылки на скачивание потребуют авторизации.

## Формат apps.json (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-08-16T12:00:00Z",
  "apps": [
    {
      "id": "com.example.myapp",
      "name": "My App",
      "iconUrl": "https://raw.githubusercontent.com/.../store/icon.png",
      "versionCode": 12,
      "versionName": "1.4.0",
      "apkUrl": "https://github.com/.../releases/download/v1.4.0/com.example.myapp-1.4.0.apk",
      "sha256": "hex",
      "apkSizeBytes": 5242880,
      "changelog": "текст",
      "releasedAt": "2026-08-16T12:00:00Z",
      "versions": [
        { "versionCode": 12, "versionName": "1.4.0", "apkUrl": "...", "sha256": "...",
          "apkSizeBytes": 5242880, "changelog": "...", "releasedAt": "..." }
      ]
    }
  ]
}
```

- поля верхнего уровня приложения дублируют самую свежую версию;
- `versions` отсортирован от новой к старой, максимум 10 записей;
- `iconUrl` необязателен — клиент рисует заглушку.

## scripts/update_manifest.py

```bash
python3 scripts/update_manifest.py \
  --manifest apps.json \
  --id com.example.myapp --name "My App" \
  --version-code 12 --version-name 1.4.0 \
  --apk-url https://github.com/o/r/releases/download/v1.4.0/com.example.myapp-1.4.0.apk \
  --sha256 <hex> --apk-size 5242880 \
  --changelog-file changelog.txt \
  [--icon-url https://…/icon.png] [--released-at 2026-08-16T12:00:00Z]
```

Коды возврата: `0` — обновлено, `1` — ошибка ввода/формата,
**`2` — versionCode уже опубликован или меньше текущего** (workflow трактует
это как отказ публикации).

Гарантии: атомарная запись (temp + rename), история обрезается до 10, при
конфликте версий файл не меняется вообще.

## Тесты

```bash
python3 -m unittest discover -s tests -v
```
