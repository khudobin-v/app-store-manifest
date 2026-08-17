# release-kit — публикация приложения в личный магазин

Набор файлов, который кладётся **в репозиторий каждого Android-приложения**.
После настройки публикация версии = одна команда:

```bash
./release.sh 1.4.0 "Тёмная тема, починен экспорт"
```

Дальше без единого ручного действия: CI собирает подписанный APK → создаёт
GitHub Release → обновляет `apps.json` в репозитории манифеста → приложение в
магазине на телефоне показывает «Обновить».

## Что куда копировать

| Файл в release-kit | Куда в репозитории приложения |
|---|---|
| `release.sh` | `release.sh` (в корень, `chmod +x`) |
| `.github/workflows/release.yml` | `.github/workflows/release.yml` |
| `signing-config.gradle.kts.snippet` | вставить в `app/build.gradle.kts` |
| `tools/setup-app-repo.sh` | запустить один раз, коммитить не нужно |
| `store/icon.png` | иконка 512×512 (необязательно) |

## Чек-лист настройки нового приложения

1. **Репозиторий манифеста** уже должен существовать — см. `app-store-manifest/README.md`.
   Достаточно создать его один раз на все приложения.

2. Скопируйте файлы из таблицы выше в репозиторий приложения.

3. В `app/build.gradle.kts`:
   - вставьте сниппет подписи из `signing-config.gradle.kts.snippet`;
   - убедитесь, что `versionName` совпадает с версией, которую передаёте в
     `./release.sh` (CI отклонит релиз при расхождении);
   - **поднимайте `versionCode` на каждый релиз** — конвейер отклонит дубликат.

4. Настройте ключ и secrets — один раз на репозиторий:

   ```bash
   ./tools/setup-app-repo.sh <владелец>/app-store-manifest
   ```

   Скрипт создаст release-ключ, зальёт `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`,
   `KEY_ALIAS`, `KEY_PASSWORD` в GitHub Secrets и подставит имя репозитория
   манифеста в workflow. Отдельно попросит `MANIFEST_PAT`.

   Вручную то же самое (Settings → Secrets and variables → Actions):

   | Secret | Значение |
   |---|---|
   | `KEYSTORE_BASE64` | `base64 -i release.keystore \| tr -d '\n'` |
   | `KEYSTORE_PASSWORD` | пароль хранилища |
   | `KEY_ALIAS` | алиас ключа |
   | `KEY_PASSWORD` | пароль ключа |
   | `MANIFEST_PAT` | fine-grained PAT, `Contents: read and write` **только** на репозиторий манифеста |

5. Замените placeholder в `.github/workflows/release.yml`:

   ```yaml
   env:
     MANIFEST_REPO: YOUR_GITHUB_USERNAME/app-store-manifest   # ← ваш репозиторий
   ```

6. Закоммитьте и запушьте, затем:

   ```bash
   ./release.sh 1.0.0 "Первый релиз"
   ```

## Ключ подписи

**Один и тот же ключ на все версии одного приложения.** Android не даёт
установить обновление, подписанное другим ключом — пользователю пришлось бы
удалять приложение с данными. Сделайте резервную копию `.keystore` (пароль
живёт в GitHub Secrets, файл — только у вас).

## Что делает workflow

1. `actions/checkout` с `fetch-depth: 0` — нужен объект аннотированного тега.
2. Changelog = сообщение тега (`git tag -l --format='%(contents…)'`).
3. JDK 17, `./gradlew assembleRelease`; keystore декодируется из
   `KEYSTORE_BASE64` во временный файл рантайма, путь передаётся через
   `KEYSTORE_PATH`.
4. `aapt2 dump badging` → `packageName`, `versionCode`, `versionName`, `label`;
   плюс `sha256sum` и размер файла.
5. Проверки: `versionName` == версия из тега; APK не подписан debug-ключом.
6. APK переименовывается в `<package>-<versionName>.apk`, `gh release create`.
7. Checkout репозитория манифеста по `MANIFEST_PAT` → `scripts/update_manifest.py`
   → коммит и пуш (с ретраем, если параллельный релиз успел раньше).

Если `versionCode` уже опубликован, `update_manifest.py` возвращает код 2 и
workflow падает с понятным сообщением — Release при этом уже создан, поэтому
поднимайте `versionCode` и делайте новый тег.

## Локальная сборка

`KEYSTORE_PATH` локально не задан → `signingConfigs` не создаётся, релизная
сборка проходит без подписи и ничего не ломает:

```bash
./gradlew assembleRelease
```
