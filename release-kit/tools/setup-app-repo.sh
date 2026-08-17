#!/usr/bin/env bash
# Одноразовая настройка репозитория приложения под релизы в личный магазин.
#
#   ./setup-app-repo.sh <владелец/репозиторий-манифеста> [путь-к-keystore]
#
# Что делает:
#   1. создаёт release-ключ приложения в ~/.android-store-keys/ (или использует
#      переданный вторым аргументом, если хотите общий ключ на несколько приложений);
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
# По умолчанию — отдельный ключ на приложение: Android требует постоянства ключа
# между версиями ОДНОГО приложения, общий ключ на все приложения не обязателен.
# Чтобы переиспользовать существующий ключ, передайте путь к нему вторым аргументом.
KEYSTORE="${2:-}"
KEY_ALIAS="${KEY_ALIAS:-store-release}"

command -v gh >/dev/null || die "нужен gh (brew install gh) и gh auth login"
command -v keytool >/dev/null || die "нужен keytool из JDK"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "запускайте внутри репозитория приложения"

cd "$(git rev-parse --show-toplevel)"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
[ -n "$KEYSTORE" ] || KEYSTORE="$HOME/.android-store-keys/${REPO//\//-}.keystore"

echo "→ Репозиторий приложения: $REPO"
echo "→ Репозиторий манифеста:  $MANIFEST_REPO"
echo "→ Ключ подписи:           $KEYSTORE"

# --- 1. Ключ ----------------------------------------------------------------
# ВАЖНО: один и тот же ключ на все версии приложения. Потеряете — обновления
# поверх установленной версии перестанут ставиться.

read_password() {
    # $1 — приглашение; результат в переменной PASSWORD_VALUE
    printf '%s' "$1" >&2
    stty -echo
    read -r PASSWORD_VALUE
    stty echo
    printf '\n' >&2
}

if [ -f "$KEYSTORE" ]; then
    echo "→ Использую существующий keystore: $KEYSTORE"
    read_password "Пароль keystore: "
    KEYSTORE_PASSWORD="$PASSWORD_VALUE"
    KEY_PASSWORD="$KEYSTORE_PASSWORD"

    # Сразу проверяем пароль: иначе ошибка всплывёт только в CI при сборке.
    if ! keytool -list -keystore "$KEYSTORE" -alias "$KEY_ALIAS" \
        -storepass "$KEYSTORE_PASSWORD" >/dev/null 2>&1; then
        die "пароль не подходит или в хранилище нет алиаса '$KEY_ALIAS'"
    fi
else
    echo "→ Создаю новый keystore: $KEYSTORE"
    echo "  Пароль задаёте вы: он понадобится, чтобы позже подключить этот же ключ"
    echo "  к другому репозиторию. Сохраните его в менеджере паролей."
    read_password "Новый пароль (минимум 6 символов): "
    KEYSTORE_PASSWORD="$PASSWORD_VALUE"
    read_password "Повторите пароль: "
    [ "$KEYSTORE_PASSWORD" = "$PASSWORD_VALUE" ] || die "пароли не совпали"
    [ ${#KEYSTORE_PASSWORD} -ge 6 ] || die "keytool требует пароль не короче 6 символов"
    KEY_PASSWORD="$KEYSTORE_PASSWORD"

    mkdir -p "$(dirname "$KEYSTORE")"
    keytool -genkeypair -v \
        -keystore "$KEYSTORE" \
        -alias "$KEY_ALIAS" \
        -keyalg RSA -keysize 4096 -validity 10000 \
        -storepass "$KEYSTORE_PASSWORD" \
        -keypass "$KEY_PASSWORD" \
        -dname "CN=Personal App Store, OU=Dev, O=Personal, C=RU" >/dev/null
    chmod 600 "$KEYSTORE"
    echo "  ключ создан"
    echo "  СДЕЛАЙТЕ РЕЗЕРВНУЮ КОПИЮ ФАЙЛА $KEYSTORE И СОХРАНИТЕ ПАРОЛЬ"
fi
unset PASSWORD_VALUE

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
