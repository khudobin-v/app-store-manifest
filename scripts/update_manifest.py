#!/usr/bin/env python3
"""Добавляет/обновляет запись приложения в apps.json личного магазина.

Контракт apps.json (schemaVersion 1):

    {
      "schemaVersion": 1,
      "updatedAt": "ISO-8601",
      "apps": [
        {
          "id", "name", "iconUrl",
          "versionCode", "versionName", "apkUrl", "sha256",
          "apkSizeBytes", "changelog", "releasedAt",
          "versions": [ {versionCode, versionName, apkUrl, sha256,
                         apkSizeBytes, changelog, releasedAt}, ... ]
        }
      ]
    }

Поля верхнего уровня приложения дублируют последнюю (самую новую) версию,
`versions` отсортирован от новой к старой и обрезается до MAX_HISTORY записей.

Коды возврата:
    0 — манифест обновлён;
    1 — ошибка аргументов / ввода-вывода / повреждённый манифест;
    2 — нарушение версионирования (дубликат versionCode или откат назад).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone

SCHEMA_VERSION = 1
MAX_HISTORY = 10

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_VERSION_CONFLICT = 2

VERSION_FIELDS = (
    "versionCode",
    "versionName",
    "apkUrl",
    "sha256",
    "apkSizeBytes",
    "changelog",
    "releasedAt",
)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_APP_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$")


class ManifestError(Exception):
    """Ошибка, приводящая к EXIT_ERROR."""


class VersionConflict(Exception):
    """Ошибка версионирования, приводящая к EXIT_VERSION_CONFLICT."""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_iso8601(value: str) -> str:
    """Проверяет ISO-8601 и приводит к UTC-виду с суффиксом Z."""
    raw = value.strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ManifestError(f"releasedAt не является корректной ISO-8601 датой: {value!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def empty_manifest() -> dict:
    return {"schemaVersion": SCHEMA_VERSION, "updatedAt": utc_now_iso(), "apps": []}


def load_manifest(path: str) -> dict:
    """Читает манифест; если файла нет — возвращает пустой манифест."""
    if not os.path.exists(path):
        return empty_manifest()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ManifestError(f"{path}: повреждённый JSON: {exc}") from exc
    except OSError as exc:
        raise ManifestError(f"{path}: не удалось прочитать: {exc}") from exc

    if not isinstance(data, dict):
        raise ManifestError(f"{path}: корень манифеста должен быть объектом")
    schema = data.get("schemaVersion", SCHEMA_VERSION)
    if schema != SCHEMA_VERSION:
        raise ManifestError(
            f"{path}: schemaVersion={schema!r}, поддерживается только {SCHEMA_VERSION}"
        )
    apps = data.get("apps", [])
    if not isinstance(apps, list):
        raise ManifestError(f"{path}: поле apps должно быть массивом")
    for app in apps:
        if not isinstance(app, dict) or not isinstance(app.get("id"), str):
            raise ManifestError(f"{path}: запись приложения без строкового id")
        if not isinstance(app.get("versions", []), list):
            raise ManifestError(f"{path}: versions приложения {app.get('id')} должно быть массивом")
    data["schemaVersion"] = SCHEMA_VERSION
    data["apps"] = apps
    return data


def save_manifest(path: str, manifest: dict) -> None:
    """Атомарно записывает манифест (запись во временный файл + rename)."""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    payload = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".apps.json.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(tmp_path, path)
    except OSError as exc:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise ManifestError(f"{path}: не удалось записать: {exc}") from exc


def validate_version(version: dict, app_id: str) -> None:
    if not _APP_ID_RE.match(app_id):
        raise ManifestError(f"id {app_id!r} не похож на имя Android-пакета")
    if not isinstance(version["versionCode"], int) or version["versionCode"] <= 0:
        raise ManifestError(f"versionCode должен быть положительным целым: {version['versionCode']!r}")
    if not version["versionName"]:
        raise ManifestError("versionName не может быть пустым")
    if not str(version["apkUrl"]).startswith("https://"):
        raise ManifestError(f"apkUrl должен быть https-ссылкой: {version['apkUrl']!r}")
    if not _SHA256_RE.match(str(version["sha256"]).lower()):
        raise ManifestError(f"sha256 должен быть 64 hex-символами: {version['sha256']!r}")
    if not isinstance(version["apkSizeBytes"], int) or version["apkSizeBytes"] <= 0:
        raise ManifestError(f"apkSizeBytes должен быть положительным целым: {version['apkSizeBytes']!r}")


def check_version_is_new(app: dict, version_code: int) -> None:
    """Отклоняет повтор уже опубликованного versionCode и откат версии назад."""
    published = [
        entry.get("versionCode")
        for entry in app.get("versions", [])
        if isinstance(entry, dict)
    ]
    if app.get("versionCode") is not None:
        published.append(app["versionCode"])
    if version_code in published:
        raise VersionConflict(
            f"versionCode {version_code} для {app['id']} уже опубликован — "
            "поднимите versionCode и создайте новый тег"
        )
    known = [code for code in published if isinstance(code, int)]
    if known and version_code < max(known):
        raise VersionConflict(
            f"versionCode {version_code} меньше уже опубликованного {max(known)} для {app['id']} — "
            "versionCode обязан монотонно расти"
        )


def upsert_app(
    manifest: dict,
    app_id: str,
    name: str,
    version: dict,
    icon_url: str | None = None,
    max_history: int = MAX_HISTORY,
) -> dict:
    """Вставляет версию в манифест. Изменяет и возвращает переданный manifest."""
    validate_version(version, app_id)

    app = next((entry for entry in manifest["apps"] if entry.get("id") == app_id), None)
    if app is None:
        app = {"id": app_id, "versions": []}
        manifest["apps"].append(app)
    else:
        check_version_is_new(app, version["versionCode"])

    history = [entry for entry in app.get("versions", []) if isinstance(entry, dict)]
    history.insert(0, dict(version))
    history.sort(key=lambda entry: entry.get("versionCode", 0), reverse=True)
    del history[max_history:]

    latest = history[0]
    ordered: dict = {"id": app_id, "name": name}
    if icon_url:
        ordered["iconUrl"] = icon_url
    elif app.get("iconUrl"):
        ordered["iconUrl"] = app["iconUrl"]
    for field in VERSION_FIELDS:
        ordered[field] = latest[field]
    ordered["versions"] = history

    app.clear()
    app.update(ordered)

    manifest["schemaVersion"] = SCHEMA_VERSION
    manifest["updatedAt"] = utc_now_iso()
    manifest["apps"].sort(key=lambda entry: str(entry.get("name", "")).lower())
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Добавляет/обновляет запись приложения в apps.json",
    )
    parser.add_argument("--manifest", default="apps.json", help="путь к apps.json (по умолчанию ./apps.json)")
    parser.add_argument("--id", required=True, help="packageName приложения")
    parser.add_argument("--name", required=True, help="отображаемое имя (label из APK)")
    parser.add_argument("--version-code", required=True, type=int)
    parser.add_argument("--version-name", required=True)
    parser.add_argument("--apk-url", required=True, help="https-ссылка на APK в GitHub Release")
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--apk-size", required=True, type=int, help="размер APK в байтах")
    parser.add_argument("--icon-url", default=None)
    changelog = parser.add_mutually_exclusive_group(required=True)
    changelog.add_argument("--changelog", help="текст changelog")
    changelog.add_argument("--changelog-file", help="файл с текстом changelog")
    parser.add_argument("--released-at", default=None, help="ISO-8601, по умолчанию текущий момент UTC")
    parser.add_argument("--max-history", type=int, default=MAX_HISTORY)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.changelog_file:
            with open(args.changelog_file, "r", encoding="utf-8") as handle:
                changelog_text = handle.read()
        else:
            changelog_text = args.changelog
        changelog_text = changelog_text.strip() or f"Release {args.version_name}"

        version = {
            "versionCode": args.version_code,
            "versionName": args.version_name,
            "apkUrl": args.apk_url,
            "sha256": args.sha256.lower(),
            "apkSizeBytes": args.apk_size,
            "changelog": changelog_text,
            "releasedAt": normalize_iso8601(args.released_at) if args.released_at else utc_now_iso(),
        }

        manifest = load_manifest(args.manifest)
        upsert_app(
            manifest,
            app_id=args.id,
            name=args.name,
            version=version,
            icon_url=args.icon_url,
            max_history=args.max_history,
        )
        save_manifest(args.manifest, manifest)
    except VersionConflict as exc:
        print(f"ОТКЛОНЕНО: {exc}", file=sys.stderr)
        return EXIT_VERSION_CONFLICT
    except (ManifestError, OSError) as exc:
        print(f"ОШИБКА: {exc}", file=sys.stderr)
        return EXIT_ERROR

    print(f"OK: {args.id} {args.version_name} (versionCode {args.version_code}) → {args.manifest}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
