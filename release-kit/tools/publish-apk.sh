#!/usr/bin/env bash
# Публикация ГОТОВОГО APK (без исходников) в личный магазин.
#
#   ./publish-apk.sh <файл.apk> ["<changelog>"]
#
# Когда использовать: приложение собирается не вами (или собрано когда-то давно),
# репозитория с исходниками нет, а поставить его на телефон через магазин хочется.
# Для своих приложений с исходниками используйте release.sh + workflow: там сборка
# и подпись воспроизводимы, а публикация не зависит от вашей машины.
#
# Что делает:
#   1. читает метаданные APK (packageName, versionCode, versionName, label);
#   2. проверяет, что APK подписан (иначе Android его не поставит);
#   3. кладёт APK в GitHub Release репозитория-хранилища (по умолчанию
#      <владелец>/app-store-uploads, создаётся при первом запуске);
#   4. вытаскивает иконку из APK и кладёт рядом ассетом, если она PNG;
#   5. добавляет запись в apps.json репозитория манифеста и пушит.
#
# Работает локально под вашей учёткой gh — MANIFEST_PAT здесь не нужен.
#
# Переменные окружения:
#   MANIFEST_REPO   владелец/репозиторий манифеста (обязательно)
#   UPLOADS_REPO    где хранить APK (по умолчанию <владелец манифеста>/app-store-uploads)
#   ANDROID_HOME    путь к Android SDK (нужен aapt2/apksigner)

set -euo pipefail

die() {
    echo "ОШИБКА: $*" >&2
    exit 1
}

usage() {
    sed -n '2,25p' "$0" >&2
    exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
case "${1:-}" in -h | --help | "") usage ;; esac

APK="$1"
CHANGELOG_RAW="${2:-}"

MANIFEST_REPO="${MANIFEST_REPO:-}"
[ -n "$MANIFEST_REPO" ] || die "задайте MANIFEST_REPO=<владелец>/app-store-manifest"
UPLOADS_REPO="${UPLOADS_REPO:-${MANIFEST_REPO%%/*}/app-store-uploads}"

[ -f "$APK" ] || die "файл не найден: $APK"
command -v gh >/dev/null || die "нужен gh (brew install gh) и gh auth login"
gh auth status >/dev/null 2>&1 || die "выполните gh auth login"

ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -d "$ANDROID_HOME/build-tools" ] || die "не найден Android SDK build-tools (задайте ANDROID_HOME)"
BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
AAPT2="$BUILD_TOOLS/aapt2"
APKSIGNER="$BUILD_TOOLS/apksigner"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. Метаданные ----------------------------------------------------------

BADGING="$("$AAPT2" dump badging "$APK")" || die "это не похоже на APK"
PACKAGE_LINE="$(printf '%s\n' "$BADGING" | grep -m1 '^package:')"
field() { printf '%s' "$PACKAGE_LINE" | grep -o " $1='[^']*'" | head -1 | cut -d"'" -f2; }

PACKAGE="$(field name)"
VERSION_CODE="$(field versionCode)"
VERSION_NAME="$(field versionName)"
LABEL="$(printf '%s' "$BADGING" | sed -n "s/^application-label:'\(.*\)'$/\1/p" | head -1)"
[ -n "$LABEL" ] || LABEL="$PACKAGE"

[ -n "$PACKAGE" ] || die "не удалось прочитать packageName"
[ -n "$VERSION_CODE" ] || die "не удалось прочитать versionCode"
[ -n "$VERSION_NAME" ] || die "не удалось прочитать versionName"

# --- 2. Подпись -------------------------------------------------------------
# Неподписанный APK система не установит; подписанный debug-ключом поставится,
# но это почти всегда означает, что взяли не тот файл.

"$APKSIGNER" verify --print-certs "$APK" > "$WORK/signer.txt" 2>/dev/null ||
    die "APK не подписан — Android откажется его устанавливать"
if grep -qi 'CN=Android Debug' "$WORK/signer.txt"; then
    echo "ВНИМАНИЕ: APK подписан debug-ключом" >&2
fi
CERT="$(grep -m1 'SHA-256 digest' "$WORK/signer.txt" | awk '{print $NF}')"

STAGED="$WORK/${PACKAGE}-${VERSION_NAME}.apk"
cp "$APK" "$STAGED"
SHA256="$(shasum -a 256 "$STAGED" 2>/dev/null | cut -d' ' -f1 || sha256sum "$STAGED" | cut -d' ' -f1)"
SIZE="$(stat -f%z "$STAGED" 2>/dev/null || stat -c%s "$STAGED")"

CHANGELOG="${CHANGELOG_RAW:-Версия $VERSION_NAME}"
printf '%s\n' "$CHANGELOG" > "$WORK/changelog.txt"

cat <<EOF
→ Приложение:  $LABEL
  пакет:       $PACKAGE
  версия:      $VERSION_NAME ($VERSION_CODE)
  размер:      $SIZE байт
  sha256:      $SHA256
  сертификат:  ${CERT:-неизвестен}
  хранилище:   $UPLOADS_REPO
  витрина:     $MANIFEST_REPO
EOF

# --- 3. Иконка --------------------------------------------------------------
# Берём самую крупную растровую иконку. Adaptive icon (XML) пропускаем —
# клиент нарисует заглушку с первой буквой имени.

ICON_ASSET=""
ICON_ENTRY="$(printf '%s\n' "$BADGING" | grep -oE "application-icon-[0-9]+:'[^']*\.png'" |
    sort -t- -k3 -n | tail -1 | cut -d"'" -f2 || true)"
if [ -n "$ICON_ENTRY" ]; then
    if unzip -o -q -j "$APK" "$ICON_ENTRY" -d "$WORK" 2>/dev/null; then
        ICON_ASSET="$WORK/${PACKAGE}-icon.png"
        mv "$WORK/$(basename "$ICON_ENTRY")" "$ICON_ASSET"
        echo "  иконка:      $ICON_ENTRY"
    fi
fi

# --- 4. Release с APK -------------------------------------------------------

if [ -n "${DRY_RUN:-}" ]; then
    echo "→ DRY_RUN: Release $PACKAGE-$VERSION_NAME в $UPLOADS_REPO не создаётся"
else
    if ! gh repo view "$UPLOADS_REPO" >/dev/null 2>&1; then
        echo "→ Создаю репозиторий-хранилище $UPLOADS_REPO"
        # --add-readme обязателен: в репозитории без коммитов GitHub отказывается
        # создавать Release с невнятным «Validation Failed» (422).
        gh repo create "$UPLOADS_REPO" --public --add-readme \
            --description "APK приложений без исходников для личного магазина" >/dev/null
    elif ! gh api "repos/$UPLOADS_REPO/commits?per_page=1" >/dev/null 2>&1; then
        echo "→ Хранилище пустое, добавляю начальный коммит"
        printf '# %s\n\nAPK приложений личного магазина. Файлы лежат в Releases.\n' "${UPLOADS_REPO#*/}" |
            base64 | tr -d '\n' > "$WORK/readme.b64"
        gh api "repos/$UPLOADS_REPO/contents/README.md" -X PUT \
            -f message='Инициализация хранилища APK' \
            -f content="@$WORK/readme.b64" >/dev/null
    fi
fi

TAG="${PACKAGE}-${VERSION_NAME}"
if [ -n "${DRY_RUN:-}" ]; then
    :
elif gh release view "$TAG" --repo "$UPLOADS_REPO" >/dev/null 2>&1; then
    echo "→ Release $TAG уже есть, перезаливаю ассеты"
    gh release upload "$TAG" "$STAGED" ${ICON_ASSET:+"$ICON_ASSET"} --clobber --repo "$UPLOADS_REPO"
else
    echo "→ Публикую Release $TAG в $UPLOADS_REPO"
    gh release create "$TAG" "$STAGED" ${ICON_ASSET:+"$ICON_ASSET"} \
        --repo "$UPLOADS_REPO" \
        --title "$LABEL $VERSION_NAME" \
        --notes-file "$WORK/changelog.txt" >/dev/null
fi

APK_URL="https://github.com/$UPLOADS_REPO/releases/download/$TAG/${PACKAGE}-${VERSION_NAME}.apk"
ICON_URL=""
[ -n "$ICON_ASSET" ] && ICON_URL="https://github.com/$UPLOADS_REPO/releases/download/$TAG/${PACKAGE}-icon.png"

# --- 5. Витрина -------------------------------------------------------------

echo "→ Обновляю $MANIFEST_REPO/apps.json"
gh repo clone "$MANIFEST_REPO" "$WORK/manifest" -- --quiet
cd "$WORK/manifest"

set +e
python3 scripts/update_manifest.py \
    --manifest apps.json \
    --id "$PACKAGE" \
    --name "$LABEL" \
    --version-code "$VERSION_CODE" \
    --version-name "$VERSION_NAME" \
    --apk-url "$APK_URL" \
    --sha256 "$SHA256" \
    --apk-size "$SIZE" \
    --changelog-file "$WORK/changelog.txt" \
    ${ICON_URL:+--icon-url "$ICON_URL"}
STATUS=$?
set -e

if [ "$STATUS" -eq 2 ]; then
    die "versionCode $VERSION_CODE уже опубликован (или меньше текущего) — витрина не изменена"
fi
[ "$STATUS" -eq 0 ] || die "update_manifest.py завершился с кодом $STATUS"

git add apps.json
if [ -n "${DRY_RUN:-}" ]; then
    echo "→ DRY_RUN: витрина не обновляется. Изменения, которые были бы внесены:"
    git --no-pager diff --cached --stat
    git --no-pager diff --cached | head -40
    exit 0
fi
git -c user.name="$(gh api user -q .name)" -c user.email="$(gh api user -q '.email // "noreply@github.com"')" \
    commit -qm "$PACKAGE $VERSION_NAME ($VERSION_CODE) — загружен готовый APK"
git push -q

cat <<EOF

✓ $LABEL $VERSION_NAME опубликовано.

  APK:     $APK_URL
  витрина: https://github.com/$MANIFEST_REPO/blob/main/apps.json

Откройте магазин на телефоне и потяните список вниз.

Следующую версию заливайте этим же скриптом — versionCode обязан вырасти,
а APK должен быть подписан тем же ключом ($CERT), иначе обновление
не встанет поверх установленного.
EOF
