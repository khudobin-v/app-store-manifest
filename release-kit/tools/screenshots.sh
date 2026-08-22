#!/usr/bin/env bash
# Снимки экрана приложения на эмуляторе — для карточки в магазине.
#
#   ./tools/screenshots.sh <apk> <packageName> <каталог для кадров>
#
# Запускается конвейером сборки внутри android-emulator-runner, когда эмулятор
# уже поднят. Приложение неизвестно скрипту, поэтому кадры снимаются вслепую:
# запуск, две прокрутки и свайп вбок. Одинаковые кадры выбрасываются — у
# приложения без прокрутки останется один снимок, а не пять копий.

set -euo pipefail

APK="${1:?первым аргументом нужен путь к APK}"
PACKAGE="${2:?вторым аргументом нужен packageName}"
OUT="${3:?третьим аргументом нужен каталог для кадров}"

MAX_SHOTS=5
mkdir -p "$OUT"

echo "Ставлю $APK"
adb install -r -g "$APK"

ACTIVITY="$(adb shell cmd package resolve-activity --brief "$PACKAGE" | tail -1 | tr -d '\r')"
if [ -z "$ACTIVITY" ] || [ "$ACTIVITY" = "No activity found" ]; then
    echo "::warning::у $PACKAGE нет экрана запуска — скриншотов не будет"
    exit 0
fi

echo "Запускаю $ACTIVITY"
adb shell am start -n "$ACTIVITY" >/dev/null
sleep 8

focused() {
    adb shell dumpsys activity activities | grep -m1 topResumedActivity | grep -q "$PACKAGE"
}

# Если приложение упало на старте, снимать нечего: в кадре будет лаунчер.
if ! focused; then
    echo "::warning::$PACKAGE не в фокусе после запуска — скриншотов не будет"
    exit 0
fi

index=0
capture() {
    # Жест мог увести из приложения (например, назад с первого экрана) — тогда
    # в кадр попал бы чужой экран, и такой снимок в витрине не нужен.
    if ! focused; then
        echo "пропускаю кадр: приложение больше не в фокусе"
        return 0
    fi
    index=$((index + 1))
    [ "$index" -le "$MAX_SHOTS" ] || return 0
    adb exec-out screencap -p > "$OUT/raw-$index.png"
    echo "кадр $index: $(stat -c%s "$OUT/raw-$index.png" 2>/dev/null || stat -f%z "$OUT/raw-$index.png") байт"
}

capture                                                        # первый экран
adb shell input swipe 540 1600 540 700 300; sleep 2; capture   # прокрутка вниз
adb shell input swipe 540 1600 540 700 300; sleep 2; capture   # ещё ниже
adb shell input swipe 900 1200 200 1200 300; sleep 2; capture  # свайп вбок
adb shell input swipe 200 1200 900 1200 300; sleep 2; capture  # и обратно

seen=()
# Одинаковые кадры не нужны: у статичного экрана все снимки совпадут побайтно.
kept=0
for raw in "$OUT"/raw-*.png; do
    [ -f "$raw" ] || continue
    sum="$(sha256sum "$raw" | cut -d' ' -f1)"
    if [ "${#seen[@]}" -gt 0 ] && printf '%s\n' "${seen[@]}" | grep -qx "$sum"; then
        rm -f "$raw"
        continue
    fi
    seen+=("$sum")
    kept=$((kept + 1))
    mv "$raw" "$OUT/screenshot-$kept.png"
done

echo "Снято кадров: $kept"
