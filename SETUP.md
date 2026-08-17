# Личный магазин Android-приложений

Свои приложения — на своём телефоне, без Google Play и без пересылки APK в
мессенджерах. Разработчик выполняет одну команду:

```bash
./release.sh 1.4.0 "Тёмная тема, починен экспорт"
```

Через пару минут приложение в магазине на телефоне показывает «Обновить».

## Как это устроено

Бэкенда нет. Витрина — статический `apps.json` в публичном репозитории
манифеста, APK — в GitHub Releases репозиториев самих приложений.

```
  репозиторий приложения                  репозиторий манифеста        телефон
 ┌────────────────────────┐              ┌────────────────────┐    ┌────────────┐
 │ ./release.sh 1.4.0     │              │                    │    │            │
 │   └─ git tag v1.4.0 ──────┐           │  apps.json         │    │  магазин   │
 │                        │  │           │   (raw.github…)  ←─────── читает     │
 │ .github/workflows      │  │ push tag  │        ▲           │    │            │
 │   release.yml  ←──────────┘           │        │ commit    │    │  ставит /  │
 │     ├─ assembleRelease │              │        │           │    │  обновляет │
 │     ├─ aapt2 badging   │              │  scripts/          │    │  в один тап│
 │     ├─ sha256 + size   │              │   update_manifest.py    │            │
 │     ├─ gh release create ─→ APK       │        ▲           │    │      ▲     │
 │     └─ update_manifest.py ─────────────────────┘           │    │      │     │
 └────────────────────────┘              └────────────────────┘    └──────┼─────┘
                                                                  APK из Releases
```

## Что в репозитории

| Каталог | Что это |
|---|---|
| `scripts/`, `tests/` (этот репозиторий) | репозиторий манифеста: `scripts/update_manifest.py` + тесты |
| [`release-kit/`](release-kit/) | что копируется в репозиторий каждого приложения: `release.sh`, workflow, сниппет подписи, скрипт настройки secrets |
| [`store-client/`](store-client/) | Android-клиент магазина (Kotlin, Compose, minSdk 26) |
| [`sample-app/`](sample-app/) | тестовое приложение для приёмочного прогона |

Клиент магазина и тестовое приложение — обычные репозитории приложений: в
каждом уже лежит `release.sh` и workflow, магазин публикует сам себя и умеет
обновляться (баннер «Обновить магазин»).

## Чек-лист настройки с нуля

1. **Репозиторий манифеста** — один на все приложения, публичный:

   ```bash
   gh repo create app-store-manifest --public --clone
   cp -r app-store-manifest/scripts app-store-manifest/tests app-store-manifest/README.md <клон>/
   cd <клон> && git add -A && git commit -m "manifest tooling" && git push
   ```

2. **Fine-grained PAT** для записи в манифест:
   github.com/settings/personal-access-tokens/new →
   Repository access: только `app-store-manifest`, Permissions: Contents → Read and write.
   Понадобится как secret `MANIFEST_PAT` в каждом репозитории приложения.

3. **Репозиторий приложения** (для каждого приложения, включая магазин):

   ```bash
   cp release-kit/release.sh <репо>/ && chmod +x <репо>/release.sh
   cp -r release-kit/.github <репо>/
   cp -r release-kit/tools <репо>/
   # вставить сниппет из release-kit/signing-config.gradle.kts.snippet в app/build.gradle.kts
   cd <репо> && ./tools/setup-app-repo.sh <владелец>/app-store-manifest
   ```

   Скрипт создаст release-ключ, зальёт `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`,
   `KEY_ALIAS`, `KEY_PASSWORD`, спросит `MANIFEST_PAT` и подставит имя
   репозитория манифеста в workflow (placeholder `YOUR_GITHUB_USERNAME`).

4. **Клиент магазина**: в [`store-client/gradle.properties`](store-client/gradle.properties)
   заменить `YOUR_GITHUB_USERNAME` в `MANIFEST_URL` на своего владельца
   репозитория. Это единственное место, где задаётся адрес витрины.

5. Собрать и поставить магазин на телефон один раз руками:

   ```bash
   cd store-client && ./gradlew assembleRelease   # либо ./release.sh 1.0.0, тогда APK будет в Releases
   adb install app/build/outputs/apk/release/*.apk
   ```

   Дальше магазин обновляет себя сам.

6. На телефоне разрешить магазину установку приложений — система спросит сама
   при первой установке (Настройки → Установка неизвестных приложений).

## Ежедневный цикл

```bash
# в репозитории приложения: поднять versionCode/versionName в app/build.gradle.kts
git commit -am "фича" && git push
./release.sh 1.4.0 "Что нового"
```

Всё остальное делает CI. Ручных шагов после `release.sh` нет.

## Жёсткие гарантии

- **Подпись.** APK подписывается ключом из GitHub Secrets; workflow падает,
  если APK оказался подписан debug-ключом. Один ключ на все версии приложения —
  иначе Android не даст поставить обновление поверх.
- **Целостность.** Клиент считает sha256 скачанного APK и сверяет с витриной.
  Не совпало — файл удаляется, установка не запускается
  ([`ApkDownloader`](store-client/app/src/main/java/com/personal/appstore/data/remote/ApkDownloader.kt)).
- **Монотонность версий.** `update_manifest.py` возвращает код 2, если такой
  `versionCode` уже опубликован или меньше текущего; workflow падает с понятным
  сообщением.
- **Секреты.** Только в GitHub Secrets и env. В логи попадает лишь размер
  keystore и sha256 APK.
- **Один тег = один релиз.** `release.sh` отказывается работать при грязном
  дереве, существующем теге и незапушенном коммите.

## Тесты

```bash
cd app-store-manifest && python3 -m unittest discover -s tests -v     # 20 тестов
cd store-client && ./gradlew testDebugUnitTest                        # 40 тестов
```

Покрыто: разбор манифеста (включая отбраковку записей без валидной sha256),
логика статусов «Установить/Обновить/Открыть», офлайн-режим и ретраи,
проверка контрольной суммы при скачивании, `update_manifest.py` (в том числе
отказ при дубликате `versionCode`).

## Приёмочный сценарий

См. [`ACCEPTANCE.md`](ACCEPTANCE.md) — прогон от `./release.sh` до установки и
обновления на устройстве.
