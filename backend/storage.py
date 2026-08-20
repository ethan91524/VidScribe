import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

from . import config

RUNNING_STATUSES = {"extracting", "loading_model", "transcribing", "converting"}

# Windows 上 os.replace 的目標檔若正被另一個執行緒讀取會拒絕存取,
# 所以所有 JSON 讀寫共用一把鎖,寫入失敗再小睡重試(擋外部程式如備份軟體)。
_io_lock = threading.Lock()


def project_dir(pid: str) -> Path:
    return config.PROJECTS_DIR / pid


def _load_json(path: Path, default=None):
    with _io_lock:
        try:
            with path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return default


def _save_json(path: Path, data) -> None:
    with _io_lock:
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                time.sleep(0.05 * (attempt + 1))
        os.replace(tmp, path)


def create_project(display_name: str, media_suffix: str) -> dict:
    pid = uuid.uuid4().hex[:12]
    d = project_dir(pid)
    d.mkdir(parents=True, exist_ok=True)
    meta = {
        "id": pid,
        "name": display_name or "未命名專案",
        "created_at": time.time(),
        "media_file": "media" + media_suffix,
        "status": "uploaded",
        "progress": 0.0,
        "error": None,
        "duration": None,
        "language": None,
        "has_video": None,
        "model": config.MODEL_NAME,
        "device": None,
    }
    save_project(meta)
    return meta


def load_project(pid: str) -> dict | None:
    if not pid or "/" in pid or "\\" in pid or ".." in pid:
        return None
    return _load_json(project_dir(pid) / "project.json")


def save_project(meta: dict) -> None:
    _save_json(project_dir(meta["id"]) / "project.json", meta)


def list_projects() -> list[dict]:
    if not config.PROJECTS_DIR.is_dir():
        return []
    projects = []
    for d in config.PROJECTS_DIR.iterdir():
        if d.is_dir():
            meta = _load_json(d / "project.json")
            if meta:
                projects.append(meta)
    projects.sort(key=lambda m: m.get("created_at", 0), reverse=True)
    return projects


def delete_project(pid: str) -> None:
    d = project_dir(pid)
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)


def load_subtitles(pid: str) -> dict:
    data = _load_json(project_dir(pid) / "subtitles.json", {"version": 1, "segments": []})
    data.setdefault("marks", [])
    data.setdefault("style", None)
    return data


def save_subtitles(pid: str, data: dict) -> None:
    _save_json(project_dir(pid) / "subtitles.json", data)


def backup_subtitles(pid: str) -> None:
    """重新辨識覆蓋前,把現有字幕留一份 subtitles.bak.json。"""
    data = load_subtitles(pid)
    if data.get("segments"):
        _save_json(project_dir(pid) / "subtitles.bak.json", data)


def mark_stale_jobs_interrupted() -> None:
    """伺服器啟動時,把上次沒跑完的辨識標記為中斷,讓使用者可以重跑。"""
    for meta in list_projects():
        if meta.get("status") in RUNNING_STATUSES:
            meta["status"] = "interrupted"
            meta["error"] = "辨識中斷(伺服器重啟),請重新辨識"
            save_project(meta)
