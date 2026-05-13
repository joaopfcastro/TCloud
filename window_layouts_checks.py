import copy
import unittest
from datetime import datetime, timezone

from database import Database


class FakeAsyncCursor:
    def __init__(self, docs):
        self.docs = list(docs)

    def sort(self, key, direction):
        key_name = key if isinstance(key, str) else key[0][0]
        reverse = direction < 0 if isinstance(direction, int) else key[0][1] < 0
        floor = datetime.min.replace(tzinfo=timezone.utc)
        self.docs.sort(key=lambda doc: doc.get(key_name) or floor, reverse=reverse)
        return self

    def __aiter__(self):
        self._iterator = iter(self.docs)
        return self

    async def __anext__(self):
        try:
            return copy.deepcopy(next(self._iterator))
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class FakeDeleteResult:
    def __init__(self, deleted_count):
        self.deleted_count = deleted_count


class FakeWindowLayoutsCollection:
    def __init__(self):
        self.docs = {}

    async def find_one(self, query):
        key = (query.get("owner_id"), query.get("window_id"))
        return copy.deepcopy(self.docs.get(key))

    def find(self, query):
        owner_id = query.get("owner_id")
        return FakeAsyncCursor(
            doc for (doc_owner, _), doc in self.docs.items() if doc_owner == owner_id
        )

    async def find_one_and_update(self, query, update, upsert=False, return_document=None):
        key = (query.get("owner_id"), query.get("window_id"))
        existing = copy.deepcopy(self.docs.get(key))
        if existing is None:
            if not upsert:
                return None
            existing = dict(update.get("$setOnInsert") or {})
        existing.update(update.get("$set") or {})
        self.docs[key] = copy.deepcopy(existing)
        return copy.deepcopy(existing)

    async def delete_one(self, query):
        key = (query.get("owner_id"), query.get("window_id"))
        existed = key in self.docs
        self.docs.pop(key, None)
        return FakeDeleteResult(1 if existed else 0)


class FakeDesktopWindowSessionsCollection:
    def __init__(self):
        self.docs = {}

    async def find_one(self, query):
        return copy.deepcopy(self.docs.get(query.get("owner_id")))

    async def find_one_and_update(self, query, update, upsert=False, return_document=None):
        owner_id = query.get("owner_id")
        existing = copy.deepcopy(self.docs.get(owner_id))
        if existing is None:
            if not upsert:
                return None
            existing = dict(update.get("$setOnInsert") or {})
        existing.update(update.get("$set") or {})
        self.docs[owner_id] = copy.deepcopy(existing)
        return copy.deepcopy(existing)

    async def delete_one(self, query):
        owner_id = query.get("owner_id")
        existed = owner_id in self.docs
        self.docs.pop(owner_id, None)
        return FakeDeleteResult(1 if existed else 0)


class WindowLayoutDatabaseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = Database()
        self.db._window_layouts = FakeWindowLayoutsCollection()

    async def test_save_get_and_list_layouts_by_owner(self):
        result = await self.db.save_window_layout(
            "owner:alice",
            "app-viewer",
            {
                "appId": "pdf-tools",
                "status": "normal",
                "rect": {"x": 41, "y": 52, "width": 910, "height": 640},
                "restoreRect": {"x": 40, "y": 50, "width": 900, "height": 620},
                "viewport": {"width": 1440, "height": 900, "devicePixelRatio": 2},
                "last_device_id": "web:a",
                "last_reason": "resize-end",
            },
        )

        self.assertFalse(result["conflict"])
        self.assertEqual(result["layout"]["window_id"], "app-viewer")
        self.assertEqual(result["layout"]["app_id"], "pdf-tools")
        self.assertEqual(result["layout"]["rect"]["width"], 910.0)

        await self.db.save_window_layout(
            "owner:bob",
            "app-viewer",
            {
                "status": "maximized",
                "rect": {"x": 0, "y": 0, "width": 1200, "height": 800},
                "last_device_id": "web:b",
            },
        )

        listed = await self.db.list_window_layouts("owner:alice")
        self.assertEqual(list(listed["layouts"]), ["app-viewer"])
        self.assertEqual(listed["layouts"]["app-viewer"]["status"], "normal")

        loaded = await self.db.get_window_layout("owner:alice", "app-viewer")
        self.assertEqual(loaded["restoreRect"]["height"], 620.0)

    async def test_rejects_stale_cross_device_update(self):
        first = await self.db.save_window_layout(
            "owner:alice",
            "app-viewer",
            {
                "status": "normal",
                "rect": {"x": 20, "y": 30, "width": 800, "height": 500},
                "last_device_id": "web:first",
            },
        )

        stale = await self.db.save_window_layout(
            "owner:alice",
            "app-viewer",
            {
                "status": "normal",
                "rect": {"x": 99, "y": 88, "width": 700, "height": 400},
                "updated_at": "2000-01-01T00:00:00+00:00",
                "last_device_id": "web:second",
            },
        )

        self.assertTrue(stale["conflict"])
        self.assertEqual(stale["layout"]["updated_at"], first["layout"]["updated_at"])
        self.assertEqual(stale["layout"]["rect"]["x"], 20.0)

    async def test_delete_and_validation(self):
        await self.db.save_window_layout(
            "owner:alice",
            "app-viewer",
            {
                "status": "snapped",
                "snapSide": "left",
                "rect": {"x": 0, "y": 0, "width": 500, "height": 700},
            },
        )

        self.assertTrue(await self.db.delete_window_layout("owner:alice", "app-viewer"))
        self.assertIsNone(await self.db.get_window_layout("owner:alice", "app-viewer"))

        with self.assertRaises(ValueError):
            await self.db.save_window_layout("owner:alice", "bad id", {"status": "normal"})

        with self.assertRaises(ValueError):
            await self.db.save_window_layout("owner:alice", "app-viewer", {"status": "floating"})


class DesktopWindowSessionNormalizationTests(unittest.TestCase):
    def test_normalizes_desktop_window_session_payload(self):
        session = Database._normalize_desktop_window_session_payload({
            "activeWindowId": "finder-window-main",
            "windows": [
                {
                    "windowId": "finder-window-main",
                    "kind": "finder",
                    "appId": "finder",
                    "status": "minimized",
                    "rect": {"x": "12", "y": 24, "width": 980, "height": 640},
                    "payload": {
                        "path": "/Livros",
                        "mode": "cloud",
                        "activeTabId": "tab-2",
                        "tabOrder": ["tab-1", "tab-2"],
                        "tabs": [
                            {"id": "tab-1", "title": "TCloud", "mode": "cloud", "path": "/"},
                            {"id": "tab-2", "title": "Livros", "mode": "cloud", "path": "/Livros"},
                        ],
                    },
                },
                {
                    "windowId": "bad id with spaces",
                    "kind": "mystery",
                    "status": "floating",
                    "payload": {"launchPayload": {"path": "/Seguro", "nested": {"ignored": True}}},
                },
            ],
        })

        self.assertEqual(session["schema_version"], 2)
        self.assertEqual(session["active_window_id"], "finder-window-main")
        self.assertEqual(len(session["windows"]), 2)
        finder = session["windows"][0]
        self.assertEqual(finder["kind"], "finder")
        self.assertEqual(finder["status"], "minimized")
        self.assertTrue(finder["minimized"])
        self.assertEqual(finder["rect"]["x"], 12.0)
        self.assertEqual(finder["payload"]["activeTabId"], "tab-2")
        self.assertEqual(len(finder["payload"]["tabs"]), 2)

        generated = session["windows"][1]
        self.assertTrue(generated["window_id"].startswith("desktop-window-"))
        self.assertEqual(generated["kind"], "generic")
        self.assertEqual(generated["status"], "normal")
        self.assertEqual(generated["payload"]["launchPayload"]["path"], "/Seguro")
        self.assertNotIn("nested", generated["payload"]["launchPayload"])


class DesktopWindowSessionDatabaseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = Database()
        self.db._desktop_window_sessions = FakeDesktopWindowSessionsCollection()
        self.db._window_layouts = FakeWindowLayoutsCollection()
        self.db._finder_sessions = FakeDesktopWindowSessionsCollection()
        self.db._app_sessions = FakeDesktopWindowSessionsCollection()

    async def test_save_get_delete_desktop_window_session(self):
        result = await self.db.save_desktop_window_session(
            "owner:alice",
            {
                "activeWindowId": "app-viewer",
                "last_device_id": "web:test",
                "windows": [
                    {
                        "window_id": "app-viewer",
                        "kind": "pdf-tools",
                        "app_id": "pdf-tools",
                        "status": "snapped",
                        "snapSide": "right",
                        "rect": {"x": 500, "y": 0, "width": 900, "height": 800},
                        "payload": {"app_id": "pdf-tools"},
                    }
                ],
            },
        )

        self.assertFalse(result["conflict"])
        self.assertEqual(result["session"]["active_window_id"], "app-viewer")
        self.assertEqual(result["session"]["windows"][0]["snapSide"], "right")

        loaded = await self.db.get_desktop_window_session("owner:alice")
        self.assertEqual(loaded["windows"][0]["kind"], "pdf-tools")

        stale = await self.db.save_desktop_window_session(
            "owner:alice",
            {
                "activeWindowId": "app-viewer",
                "updated_at": "2000-01-01T00:00:00+00:00",
                "last_device_id": "web:other",
                "windows": [{"window_id": "app-viewer", "status": "normal"}],
            },
        )
        self.assertTrue(stale["conflict"])
        self.assertEqual(stale["session"]["windows"][0]["status"], "snapped")

        self.assertTrue(await self.db.delete_desktop_window_session("owner:alice"))
        self.assertIsNone(await self.db.get_desktop_window_session("owner:alice"))


if __name__ == "__main__":
    unittest.main()
