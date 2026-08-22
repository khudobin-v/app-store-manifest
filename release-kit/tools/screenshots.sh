#!/usr/bin/env bash
# Снимки экрана приложения на эмуляторе — для карточки в магазине.
#
#   ./tools/screenshots.sh <apk> <packageName> <каталог для кадров>
#
# Запускается конвейером сборки внутри android-emulator-runner, когда эмулятор
# уже поднят. Приложение скрипту незнакомо, поэтому экраны он ищет сам: читает
# дерево элементов через uiautomator и на каждом шаге выбирает, что сделать —
# прокрутить список, нажать кнопку или протянуть широкий элемент (так проходят
# слайдеры вроде «проведите, чтобы начать»). Кадры-дубликаты выбрасываются.

set -euo pipefail

APK="${1:?первым аргументом нужен путь к APK}"
PACKAGE="${2:?вторым аргументом нужен packageName}"
OUT="${3:?третьим аргументом нужен каталог для кадров}"

MAX_SHOTS=5
MAX_STEPS=12

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
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

if ! focused; then
    echo "::warning::$PACKAGE не в фокусе после запуска — скриншотов не будет"
    exit 0
fi

shots=0
: > "$WORK/hashes"
: > "$WORK/used"

# Снимок сохраняется, только если приложение в фокусе и такого кадра ещё не
# было: у экрана без изменений иначе получилось бы пять одинаковых картинок.
# Перетаскивание отдельными событиями. `input swipe` эмулятор в CI отдаёт
# слишком быстро, и Compose видит его как одиночное касание, а не жест —
# слайдеры «проведите, чтобы начать» так не срабатывают.
slow_drag() {
    local x1="$1" y1="$2" x2="$3" y2="$4" steps=12 i x y
    adb shell input motionevent DOWN "$x1" "$y1" >/dev/null 2>&1 || return 1
    for i in $(seq 1 "$steps"); do
        x=$(( x1 + (x2 - x1) * i / steps ))
        y=$(( y1 + (y2 - y1) * i / steps ))
        adb shell input motionevent MOVE "$x" "$y" >/dev/null 2>&1
    done
    adb shell input motionevent UP "$x2" "$y2" >/dev/null 2>&1
}

# Действие: drag выполняется по событиям, остальное — обычным input.
run_action() {
    case "$1" in
        drag*)
            # shellcheck disable=SC2086
            slow_drag $(printf '%s' "$1" | cut -d' ' -f2-)
            ;;
        *)
            # shellcheck disable=SC2086
            adb shell input $1 >/dev/null 2>&1 || true
            ;;
    esac
}

keyboard_shown() {
    adb shell dumpsys input_method | grep -q 'mInputShown=true'
}

# Слепок экрана — по дереву элементов, а не по пикселям: одна и та же страница
# с всплывающим сообщением или другой секундой на часах даёт разные картинки,
# но одинаковое дерево, и второй раз снимать её незачем.
screen_signature() {
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || return 1
    adb shell cat /sdcard/ui.xml > "$WORK/ui.xml" 2>/dev/null || return 1
    python3 - "$WORK/ui.xml" <<'SIG'
import hashlib, sys, xml.etree.ElementTree as ET

try:
    root = ET.parse(sys.argv[1]).getroot()
except ET.ParseError:
    sys.exit(1)

parts = [
    '|'.join((
        node.get('class', ''),
        node.get('resource-id', ''),
        node.get('text', ''),
        node.get('content-desc', ''),
        node.get('bounds', ''),
    ))
    for node in root.iter('node')
]
print(hashlib.sha256('\n'.join(parts).encode('utf-8')).hexdigest())
SIG
}

capture() {
    # Клавиатура могла подняться от жеста — в кадре она не нужна.
    if keyboard_shown; then
        adb shell input keyevent KEYCODE_BACK >/dev/null 2>&1 || true
        sleep 1
    fi
    focused || { echo "  кадр пропущен: приложение не в фокусе"; return 0; }
    [ "$shots" -lt "$MAX_SHOTS" ] || return 0

    local sum
    sum="$(screen_signature || true)"
    if [ -n "$sum" ] && grep -qx "$sum" "$WORK/hashes"; then
        echo "  кадр пропущен: тот же экран"
        return 0
    fi
    [ -n "$sum" ] && echo "$sum" >> "$WORK/hashes"

    shots=$((shots + 1))
    adb exec-out screencap -p > "$OUT/screenshot-$shots.png"
    echo "  кадр $shots сохранён"
}

# Следующее действие выбирается по дереву элементов: сначала прокрутка списка,
# потом широкие элементы (слайдеры), потом обычные кнопки. Уже испробованные
# элементы пропускаются, иначе обход топчется на первой же кнопке.
next_action() {
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || return 1
    adb shell cat /sdcard/ui.xml > "$WORK/ui.xml" 2>/dev/null || return 1
    python3 - "$WORK/ui.xml" "$WORK/used" <<'PY'
import re, sys, xml.etree.ElementTree as ET

tree_path, used_path = sys.argv[1], sys.argv[2]
try:
    root = ET.parse(tree_path).getroot()
except ET.ParseError:
    sys.exit(1)

used = set(open(used_path, encoding='utf-8').read().split('\n'))
BOUNDS = re.compile(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]')

nodes = []
for node in root.iter('node'):
    match = BOUNDS.match(node.get('bounds', ''))
    if not match:
        continue
    x1, y1, x2, y2 = (int(v) for v in match.groups())
    width, height = x2 - x1, y2 - y1
    if width < 40 or height < 40:
        continue
    # Поля ввода не трогаем: от нажатия поднимется клавиатура, и кадр уйдёт
    # в витрину с ней, а нового экрана не появится.
    if 'EditText' in node.get('class', ''):
        continue
    nodes.append({
        'key': f"{node.get('resource-id', '')}|{node.get('content-desc', '')}|{node.get('bounds')}",
        'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2,
        'width': width, 'height': height,
        'scrollable': node.get('scrollable') == 'true',
        'clickable': node.get('clickable') == 'true',
    })

if not nodes:
    sys.exit(1)

screen_width = max(n['x2'] for n in nodes)
screen_height = max(n['y2'] for n in nodes)

def free(node):
    return node['key'] not in used

# 1. Прокрутка: самый крупный список, который ещё не крутили.
scrollables = sorted(
    (n for n in nodes if n['scrollable'] and free(n)),
    key=lambda item: item['width'] * item['height'],
    reverse=True,
)
if scrollables:
    n = scrollables[0]
    cx = (n['x1'] + n['x2']) // 2
    print(f"{n['key']}\tswipe {cx} {n['y1'] + int(n['height'] * 0.75)} {cx} {n['y1'] + int(n['height'] * 0.25)} 300")
    sys.exit(0)

# 2. Широкий элемент — тянем слева направо: так проходят слайдеры
#    «проведите, чтобы продолжить», которые от нажатия не срабатывают.
wide = [
    n for n in nodes
    if free(n) and n['clickable'] and n['width'] > screen_width * 0.6 and n['height'] < screen_height * 0.25
]
if wide:
    n = min(wide, key=lambda item: item['y1'])
    cy = (n['y1'] + n['y2']) // 2
    print(f"{n['key']}\tdrag {n['x1'] + n['width'] // 10} {cy} {n['x2'] - n['width'] // 10} {cy}")
    sys.exit(0)

# 3. Обычная кнопка или карточка: жмём самую крупную из неиспробованных.
clickables = sorted(
    (n for n in nodes if n['clickable'] and free(n)),
    key=lambda item: item['width'] * item['height'],
    reverse=True,
)
if clickables:
    n = clickables[0]
    print(f"{n['key']}\ttap {(n['x1'] + n['x2']) // 2} {(n['y1'] + n['y2']) // 2}")
    sys.exit(0)

sys.exit(1)
PY
}

capture

step=0
while [ "$shots" -lt "$MAX_SHOTS" ] && [ "$step" -lt "$MAX_STEPS" ]; do
    step=$((step + 1))

    if ! action="$(next_action)"; then
        echo "шаг $step: подходящих элементов не нашлось"
        break
    fi

    key="${action%%$'\t'*}"
    command="${action#*$'\t'}"
    last_signature="$(screen_signature || true)"
    echo "шаг $step: $command"
    printf '%s\n' "$key" >> "$WORK/used"

    run_action "$command"
    # Ждём дольше, чем живёт короткое всплывающее сообщение: иначе оно попадёт
    # в кадр поверх экрана.
    sleep 4

    # Медленный эмулятор мог не отработать жест с первого раза — пробуем ещё
    # раз, прежде чем считать элемент бесполезным.
    if [ "$(screen_signature || true)" = "$last_signature" ]; then
        echo "  экран не изменился, повторяю"
        run_action "$command"
        sleep 4
    fi

    # Нажатие могло увести из приложения — возвращаемся и пробуем дальше.
    if ! focused; then
        echo "  вышли из приложения, возвращаюсь"
        adb shell input keyevent KEYCODE_BACK >/dev/null 2>&1 || true
        sleep 2
    fi

    capture
done

echo "Снято кадров: $shots"
