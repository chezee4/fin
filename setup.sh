#!/usr/bin/env bash
# Розгортання «Бюджету на двох» на Cloudflare (безкоштовно). Запуск: ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "1/5 Встановлюю залежності…"
npm install --no-fund --no-audit >/dev/null

echo "2/5 Вхід у Cloudflare…"
npx wrangler whoami 2>/dev/null | grep -qi "logged in" || npx wrangler login

if grep -q REPLACE_WITH_DATABASE_ID wrangler.toml; then
  echo "3/5 Створюю базу даних…"
  OUT=$(npx wrangler d1 create budget --location eeur < /dev/null 2>&1) || { echo "$OUT"; exit 1; }
  ID=$(echo "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  [ -n "$ID" ] || { echo "$OUT"; echo "Не знайшов ID бази в відповіді вище."; exit 1; }
  sed -i '' "s/REPLACE_WITH_DATABASE_ID/$ID/" wrangler.toml
else
  echo "3/5 База вже є, пропускаю."
fi

echo "4/5 Публікую воркер…"
DEPLOY=$(npx wrangler deploy < /dev/null 2>&1) || {
  if echo "$DEPLOY" | grep -q "workers.dev subdomain"; then
    LINK=$(echo "$DEPLOY" | grep -oE 'https://dash\.cloudflare\.com/[^ ]*onboarding' | head -1)
    echo
    echo "⚠️  У Cloudflare ще не вибрана адреса *.workers.dev (одноразово)."
    echo "   1) Відкриваю: ${LINK:-https://dash.cloudflare.com → Workers & Pages}"
    echo "   2) Придумай назву (напр. vadym-budget) → Set up / Continue."
    echo "   3) Запусти ще раз: ./setup.sh"
    [ -n "$LINK" ] && open "$LINK" 2>/dev/null || true
  else
    echo "$DEPLOY"
  fi
  exit 1
}
URL=$(echo "$DEPLOY" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)
[ -n "$URL" ] || { echo "$DEPLOY"; echo "Не знайшов адресу воркера."; exit 1; }

echo "5/5 Секрети…"
[ -f .secret ] || openssl rand -hex 24 > .secret
SECRET=$(cat .secret)
if [ "${1:-}" != "--keep-bot" ]; then
  read -rsp "Встав токен бота від @BotFather і натисни Enter: " BOT; echo
  printf '%s' "$BOT" | npx wrangler secret put BOT_TOKEN >/dev/null
fi
printf '%s' "$SECRET" | npx wrangler secret put SECRET >/dev/null

echo
echo "Готово: $URL"
echo "Відкриваю сторінку налаштування з посиланням-запрошенням…"
sleep 3
open "$URL/setup?key=$SECRET" 2>/dev/null || echo "Відкрий у браузері: $URL/setup?key=$SECRET"
