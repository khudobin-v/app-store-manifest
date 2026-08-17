#!/usr/bin/env python3
"""Юнит-тесты update_manifest.py. Запуск: python3 -m unittest discover -s tests"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

import update_manifest as um  # noqa: E402


def version(code: int, name: str | None = None, **overrides) -> dict:
    data = {
        "versionCode": code,
        "versionName": name or f"1.{code}.0",
        "apkUrl": f"https://github.com/o/r/releases/download/v1.{code}.0/com.example.app-1.{code}.0.apk",
        "sha256": f"{code:064x}",
        "apkSizeBytes": 1024 * code,
        "changelog": f"changelog {code}",
        "releasedAt": "2026-01-01T00:00:00Z",
    }
    data.update(overrides)
    return data


class UpsertTest(unittest.TestCase):
    def setUp(self):
        self.manifest = um.empty_manifest()

    def test_creates_app_entry_with_top_level_fields(self):
        um.upsert_app(self.manifest, "com.example.app", "Example", version(1))
        app = self.manifest["apps"][0]
        self.assertEqual(app["id"], "com.example.app")
        self.assertEqual(app["name"], "Example")
        self.assertEqual(app["versionCode"], 1)
        self.assertEqual(app["versionName"], "1.1.0")
        self.assertEqual(app["changelog"], "changelog 1")
        self.assertEqual(len(app["versions"]), 1)
        self.assertEqual(self.manifest["schemaVersion"], 1)

    def test_top_level_fields_mirror_latest_version(self):
        um.upsert_app(self.manifest, "com.example.app", "Example", version(1))
        um.upsert_app(self.manifest, "com.example.app", "Example", version(2))
        app = self.manifest["apps"][0]
        for field in um.VERSION_FIELDS:
            self.assertEqual(app[field], app["versions"][0][field], field)
        self.assertEqual(app["versionCode"], 2)

    def test_history_is_sorted_newest_first(self):
        for code in (1, 2, 3):
            um.upsert_app(self.manifest, "com.example.app", "Example", version(code))
        codes = [v["versionCode"] for v in self.manifest["apps"][0]["versions"]]
        self.assertEqual(codes, [3, 2, 1])

    def test_history_is_trimmed_to_ten(self):
        for code in range(1, 15):
            um.upsert_app(self.manifest, "com.example.app", "Example", version(code))
        versions = self.manifest["apps"][0]["versions"]
        self.assertEqual(len(versions), 10)
        self.assertEqual([v["versionCode"] for v in versions], list(range(14, 4, -1)))

    def test_duplicate_version_code_is_rejected(self):
        um.upsert_app(self.manifest, "com.example.app", "Example", version(7))
        with self.assertRaises(um.VersionConflict):
            um.upsert_app(self.manifest, "com.example.app", "Example", version(7))

    def test_duplicate_deep_in_history_is_rejected(self):
        for code in (1, 2, 3):
            um.upsert_app(self.manifest, "com.example.app", "Example", version(code))
        with self.assertRaises(um.VersionConflict):
            um.upsert_app(self.manifest, "com.example.app", "Example", version(1))

    def test_downgrade_is_rejected(self):
        um.upsert_app(self.manifest, "com.example.app", "Example", version(5))
        with self.assertRaises(um.VersionConflict):
            um.upsert_app(self.manifest, "com.example.app", "Example", version(4))

    def test_second_app_does_not_touch_the_first(self):
        um.upsert_app(self.manifest, "com.example.app", "Example", version(1))
        um.upsert_app(self.manifest, "com.example.other", "Other", version(1))
        self.assertEqual(len(self.manifest["apps"]), 2)
        first = next(a for a in self.manifest["apps"] if a["id"] == "com.example.app")
        self.assertEqual(len(first["versions"]), 1)

    def test_icon_url_is_preserved_when_not_passed(self):
        um.upsert_app(self.manifest, "com.example.app", "Example", version(1), icon_url="https://x/i.png")
        um.upsert_app(self.manifest, "com.example.app", "Example", version(2))
        self.assertEqual(self.manifest["apps"][0]["iconUrl"], "https://x/i.png")

    def test_name_is_updated_from_apk_label(self):
        um.upsert_app(self.manifest, "com.example.app", "Old", version(1))
        um.upsert_app(self.manifest, "com.example.app", "New", version(2))
        self.assertEqual(self.manifest["apps"][0]["name"], "New")

    def test_invalid_sha256_is_rejected(self):
        with self.assertRaises(um.ManifestError):
            um.upsert_app(self.manifest, "com.example.app", "Example", version(1, sha256="deadbeef"))

    def test_non_https_apk_url_is_rejected(self):
        with self.assertRaises(um.ManifestError):
            um.upsert_app(
                self.manifest, "com.example.app", "Example", version(1, apkUrl="http://x/a.apk")
            )

    def test_non_positive_size_is_rejected(self):
        with self.assertRaises(um.ManifestError):
            um.upsert_app(self.manifest, "com.example.app", "Example", version(1, apkSizeBytes=0))


class FileIoTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "apps.json")
        self.addCleanup(self.dir.cleanup)

    def run_cli(self, **overrides) -> int:
        args = {
            "--manifest": self.path,
            "--id": "com.example.app",
            "--name": "Example",
            "--version-code": "1",
            "--version-name": "1.0.0",
            "--apk-url": "https://github.com/o/r/releases/download/v1.0.0/com.example.app-1.0.0.apk",
            "--sha256": "a" * 64,
            "--apk-size": "2048",
            "--changelog": "первый релиз",
        }
        args.update(overrides)
        argv = [item for pair in args.items() for item in pair]
        return um.main(argv)

    def read(self) -> dict:
        with open(self.path, encoding="utf-8") as handle:
            return json.load(handle)

    def test_creates_manifest_file_when_missing(self):
        self.assertEqual(self.run_cli(), um.EXIT_OK)
        data = self.read()
        self.assertEqual(data["schemaVersion"], 1)
        self.assertEqual(data["apps"][0]["id"], "com.example.app")
        self.assertEqual(data["apps"][0]["changelog"], "первый релиз")

    def test_cli_rejects_duplicate_version_code_with_exit_code_2(self):
        self.assertEqual(self.run_cli(), um.EXIT_OK)
        self.assertEqual(self.run_cli(), um.EXIT_VERSION_CONFLICT)
        self.assertEqual(len(self.read()["apps"][0]["versions"]), 1)

    def test_cli_appends_second_version(self):
        self.assertEqual(self.run_cli(), um.EXIT_OK)
        code = self.run_cli(**{"--version-code": "2", "--version-name": "1.1.0", "--changelog": "вторая"})
        self.assertEqual(code, um.EXIT_OK)
        app = self.read()["apps"][0]
        self.assertEqual(app["versionCode"], 2)
        self.assertEqual(app["changelog"], "вторая")
        self.assertEqual([v["versionCode"] for v in app["versions"]], [2, 1])

    def test_cli_reads_changelog_from_file(self):
        changelog_path = os.path.join(self.dir.name, "changelog.txt")
        with open(changelog_path, "w", encoding="utf-8") as handle:
            handle.write("  многострочный\nchangelog\n")
        args = {"--changelog-file": changelog_path}
        base = {
            "--manifest": self.path,
            "--id": "com.example.app",
            "--name": "Example",
            "--version-code": "3",
            "--version-name": "1.2.0",
            "--apk-url": "https://github.com/o/r/releases/download/v1.2.0/x.apk",
            "--sha256": "b" * 64,
            "--apk-size": "10",
        }
        base.update(args)
        argv = [item for pair in base.items() for item in pair]
        self.assertEqual(um.main(argv), um.EXIT_OK)
        self.assertEqual(self.read()["apps"][0]["changelog"], "многострочный\nchangelog")

    def test_corrupted_manifest_is_reported(self):
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("{ not json")
        self.assertEqual(self.run_cli(), um.EXIT_ERROR)

    def test_existing_manifest_is_not_destroyed_on_conflict(self):
        self.assertEqual(self.run_cli(), um.EXIT_OK)
        before = self.read()
        self.assertEqual(self.run_cli(**{"--changelog": "другой текст"}), um.EXIT_VERSION_CONFLICT)
        self.assertEqual(self.read(), before)

    def test_released_at_is_normalized_to_utc(self):
        self.assertEqual(self.run_cli(**{"--released-at": "2026-03-01T12:00:00+03:00"}), um.EXIT_OK)
        self.assertEqual(self.read()["apps"][0]["releasedAt"], "2026-03-01T09:00:00Z")


if __name__ == "__main__":
    unittest.main()
