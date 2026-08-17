#!/usr/bin/env bash
# Одноразовая настройка репозитория приложения под релизы в личный магазин.
#
#   ./setup-app-repo.sh <владелец/репозиторий-манифеста> [путь-к-keystore]
#
# Что делает:
#   1. создаёт release-ключ (если его ещё нет) и кладёт рядом с репозиторием;
#   2. заливает KEYSTORE_BASE64 / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD
#      в GitHub Secrets текущего репозитория через gh;
#   3. подставляет имя репозитория манифеста в .github/workflows/release.yml.
#
# MANIFEST_PAT (fine-grained PAT с contents:write ТОЛЬКО на репозиторий
# манифеста) нужно создать на github.com/settings/tokens вручную — скрипт
# только попросит его вставить.
#
# Пароли не печатаются и не коммитятся. Keystore добавляется в .gitignore.

set -euo pipefail

die() {
    echo "ОШИБКА: $*" >&2
    exit 1
}

[ $# -ge 1 ] || die "использование: ./setup-app-repo.sh <владелец/манифест> [путь-к-keystore]"

MANIFEST_REPO="$1"
KEYSTORE="${2:-$HOME/.android-store-release.keystore}"
KEY_ALIAS="${KEY_ALIAS:-store-release}"

command -v gh >/dev/null || die "нужен gh (brew install gh) и gh auth login"
command -v keytool >/dev/null || die "нужен keytool из JDK"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "запускайте внутри репозитория приложения"

cd "$(git rev-parse --show-toplevel)"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "→ Репозиторий приложения: $REPO"
echo "→ Репозиторий манифеста:  $MANIFEST_REPO"

# --- 1. Ключ ----------------------------------------------------------------
# ВАЖНО: один и тот же ключ на все версии приложения. Потеряете — обновления
# поверх установленной версии перестанут ставиться.

if [ -f "$KEYSTORE" ]; then
    echo "→ Использую существующий keystore: $KEYSTORE"
    read -r -s -p "Пароль keystore: " KEYSTORE_PASSWORD
    echo
    KEY_PASSWORD="$KEYSTORE_PASSWORD"
else
    echo "→ Создаю новый keystore: $KEYSTORE"
    KEYSTORE_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
    KEY_PASSWORD="$KEYSTORE_PASSWORD"
    keytool -genkeypair -v \
        -keystore "$KEYSTORE" \
        -alias "$KEY_ALIAS" \
        -keyalg RSA -keysize 4096 -validity 10000 \
        -storepass "$KEYSTORE_PASSWORD" \
        -keypass "$KEY_PASSWORD" \
        -dname "CN=Personal App Store, OU=Dev, O=Personal, C=RU" >/dev/null
    chmod 600 "$KEYSTORE"
    echo "  ключ создан, пароль сгенерирован (сохранён только в GitHub Secrets)"
    echo "  СДЕЛАЙТЕ РЕЗЕРВНУЮ КОПИЮ ФАЙЛА $KEYSTORE"
fi

# --- 2. Secrets -------------------------------------------------------------

echo "→ Заливаю secrets в $REPO"
base64 -i "$KEYSTORE" | tr -d '\n' | gh secret set KEYSTORE_BASE64 --repo "$REPO"
printf '%s' "$KEYSTORE_PASSWORD" | gh secret set KEYSTORE_PASSWORD --repo "$REPO"
printf '%s' "$KEY_ALIAS" | gh secret set KEY_ALIAS --repo "$REPO"
printf '%s' "$KEY_PASSWORD" | gh secret set KEY_PASSWORD --repo "$REPO"

if gh secret list --repo "$REPO" | grep -q '^MANIFEST_PAT'; then
    echo "→ MANIFEST_PAT уже задан"
else
    cat <<EOF

Нужен MANIFEST_PAT — fine-grained personal access token:
  github.com/settings/personal-access-tokens/new
  Repository access: только $MANIFEST_REPO
  Permissions: Contents → Read and write

EOF
    read -r -s -p "Вставьте токен (ввод скрыт): " PAT
    echo
    [ -n "$PAT" ] || die "пустой токен"
    printf '%s' "$PAT" | gh secret set MANIFEST_PAT --repo "$REPO"
    unset PAT
fi

# --- 3. Workflow ------------------------------------------------------------

WORKFLOW=".github/workflows/release.yml"
if [ -f "$WORKFLOW" ] && grep -q 'YOUR_GITHUB_USERNAME/app-store-manifest' "$WORKFLOW"; then
    echo "→ Подставляю $MANIFEST_REPO в $WORKFLOW"
    ESCAPED="$(printf '%s' "$MANIFEST_REPO" | sed 's/[\/&]/\\&/g')"
    sed -i.bak "s/YOUR_GITHUB_USERNAME\/app-store-manifest/$ESCAPED/" "$WORKFLOW"
    rm -f "$WORKFLOW.bak"
fi

if [ -f .gitignore ] && ! grep -qx '\*.keystore' .gitignore; then
    printf '\n# release-ключи — только в GitHub Secrets\n*.keystore\n*.jks\n' >> .gitignore
fi

cat <<EOF

✓ Репозиторий настроен.

  Дальше:
    git add -A && git commit -m "release pipeline" && git push
    ./release.sh 1.0.0 "Первый релиз"
EOF
