#!/usr/bin/env bash
# Публикация новой версии приложения в личный магазин.
#
#   ./release.sh <версия> ["<changelog>"]
#
# Скрипт только создаёт и пушит аннотированный тег v<версия>.
# Всё остальное (сборка, подпись, GitHub Release, обновление apps.json)
# делает workflow .github/workflows/release.yml по этому тегу.

set -euo pipefail

usage() {
    cat >&2 <<'EOF'
Использование: ./release.sh <версия> ["<changelog>"]

  версия      обязательна, например 1.4.0 (тег будет v1.4.0)
  changelog   опционально, по умолчанию "Release <версия>"

Примеры:
  ./release.sh 1.4.0
  ./release.sh 1.4.0 "Тёмная тема, починен экспорт"
  ./release.sh 1.5.0 "$(cat CHANGELOG-next.md)"
EOF
    exit 2
}

die() {
    echo "ОШИБКА: $*" >&2
    exit 1
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
case "${1:-}" in -h | --help | "") usage ;; esac

VERSION="$1"
CHANGELOG="${2:-Release $VERSION}"
TAG="v$VERSION"

# --- Проверки окружения -----------------------------------------------------

command -v git >/dev/null 2>&1 || die "git не найден в PATH"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    die "текущий каталог не является git-репозиторием"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

[ -f .github/workflows/release.yml ] ||
    die "нет .github/workflows/release.yml — репозиторий не настроен на релизы"

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+(\.[0-9]+){1,3}(-[0-9A-Za-z.]+)?$'; then
    die "версия '$VERSION' некорректна, ожидается что-то вроде 1.4.0 или 1.4.0-beta1"
fi

if [ -n "$(git status --porcelain)" ]; then
    git status --short >&2
    die "рабочее дерево не чистое — закоммитьте или спрячьте изменения перед релизом"
fi

git remote get-url origin >/dev/null 2>&1 || die "не настроен remote 'origin'"

echo "→ Синхронизирую теги с origin…"
git fetch --tags --quiet origin || die "не удалось получить теги с origin"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    die "тег $TAG уже существует локально — один тег = один релиз, поднимите версию"
fi

if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
    die "тег $TAG уже существует в origin — поднимите версию"
fi

# Тег должен указывать на коммит, который уже есть на origin,
# иначе CI соберёт не тот код (или не соберёт вовсе).
HEAD_SHA="$(git rev-parse HEAD)"
if [ -z "$(git branch -r --contains "$HEAD_SHA" 2>/dev/null)" ]; then
    die "коммит $(git rev-parse --short HEAD) отсутствует на origin — сначала выполните git push"
fi

# --- Тег --------------------------------------------------------------------

echo "→ Создаю аннотированный тег $TAG"
if ! printf '%s\n' "$CHANGELOG" | git tag --annotate --cleanup=verbatim --file=- "$TAG"; then
    die "не удалось создать тег $TAG (см. сообщение git выше; частая причина — не настроены user.name/user.email)"
fi

echo "→ Пушу тег в origin"
if ! git push origin "refs/tags/$TAG"; then
    git tag --delete "$TAG" >/dev/null 2>&1 || true
    die "не удалось запушить тег $TAG (локальный тег удалён, можно повторить)"
fi

REPO_SLUG="$(git remote get-url origin |
    sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##')"

cat <<EOF

✓ Тег $TAG запушен.

  changelog: $(printf '%s' "$CHANGELOG" | head -1)
  сборка:    $REPO_SLUG/actions

CI соберёт подписанный APK, создаст Release и обновит apps.json.
Через минуту-две приложение появится в магазине как «Обновить».
EOF
