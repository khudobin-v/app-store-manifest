#!/usr/bin/env bash
# Смена пароля входа в магазин: перезаписывает STORE_PASSWORD и передеплоивает.
# Переменные окружения подхватываются только новым деплоем, поэтому шага два.
set -euo pipefail
# .vercel лежит в корне проекта, а не рядом со скриптом
cd "$(dirname "$0")/.."

echo "→ Удаляю старое значение STORE_PASSWORD"
npx vercel env rm STORE_PASSWORD production --yes >/dev/null 2>&1 || true

echo "→ Введите новый пароль (ввод скрыт)"
npx vercel env add STORE_PASSWORD production

echo "→ Передеплой, чтобы пароль вступил в силу"
npx vercel deploy --prod --yes >/dev/null
echo "✓ Пароль изменён"
