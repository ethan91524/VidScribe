"""成品影片匯出:ffmpeg + libass 把字幕燒進影片。

先試 NVENC 硬體編碼 + 音訊直接複製;失敗自動降級
(NVENC+重編音訊 → CPU x264+重編音訊),進度即時回報。
"""

import json
import re
import subprocess
import threading
import traceback

from . import config, exporter, storage

OUT_NAME = "export.mp4"

_jobs: dict[str, dict] = {}
_lock = threading.Lock()

# (影像編碼器, 音訊處理),由快到慢依序嘗試
ATTEMPTS = [
    ("h264_nvenc", "copy"),
    ("h264_nvenc", "aac"),
    ("libx264", "aac"),
]


def get_state(pid: str) -> dict:
    with _lock:
        job = _jobs.get(pid)
        state = (
            {k: job[k] for k in ("status", "progress", "error")}
            if job
            else {"status": "idle", "progress": 0.0, "error": None}
        )
    state["has_file"] = (storage.project_dir(pid) / OUT_NAME).is_file()
    return state


def cancel(pid: str) -> None:
    with _lock:
        job = _jobs.get(pid)
        if job and job["status"] == "running":
            job["cancel"] = True
            proc = job.get("proc")
            if proc is not None:
                try:
                    proc.kill()
                except OSError:
                    pass
        else:
            _jobs.pop(pid, None)


def _probe_size(media) -> tuple[int, int]:
    out = subprocess.run(
        [config.FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "json", str(media)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    streams = json.loads(out.stdout).get("streams") or []
    if not streams:
        raise RuntimeError("讀不到影片解析度")
    return int(streams[0]["width"]), int(streams[0]["height"])


def start(pid: str) -> dict:
    meta = storage.load_project(pid)
    if meta is None:
        raise RuntimeError("找不到專案")
    if not meta.get("has_video"):
        raise RuntimeError("純音訊檔沒有畫面,無法輸出成品影片")
    d = storage.project_dir(pid)
    media = d / meta["media_file"]
    if not media.is_file():
        raise RuntimeError("找不到媒體檔")
    subs = storage.load_subtitles(pid)
    segments = subs["segments"]
    if not segments:
        raise RuntimeError("沒有字幕可以燒錄")
    with _lock:
        existing = _jobs.get(pid)
        if existing and existing["status"] == "running":
            raise RuntimeError("匯出已在進行中")

    width, height = _probe_size(media)
    (d / "burn.ass").write_text(
        exporter.to_ass(segments, width, height, subs.get("style")), encoding="utf-8"
    )

    job = {"status": "running", "progress": 0.0, "error": None, "cancel": False, "proc": None}
    with _lock:
        _jobs[pid] = job
    duration = float(meta.get("duration") or 0)
    threading.Thread(
        target=_run, args=(pid, d, meta["media_file"], duration, job), daemon=True
    ).start()
    return get_state(pid)


def _run(pid: str, d, media_name: str, duration: float, job: dict) -> None:
    err_file = d / "burn_err.txt"
    try:
        last_err = ""
        for vcodec, acodec in ATTEMPTS:
            if job["cancel"]:
                job["status"] = "canceled"
                return
            args = [config.FFMPEG, "-y", "-v", "error", "-nostats", "-progress", "pipe:1",
                    "-i", media_name, "-vf", "ass=burn.ass", "-c:v", vcodec]
            if vcodec == "h264_nvenc":
                args += ["-preset", "p5", "-cq", "19"]
            else:
                args += ["-preset", "medium", "-crf", "19"]
            args += ["-c:a", acodec]
            if acodec == "aac":
                args += ["-b:a", "192k"]
            args += [OUT_NAME]

            # stderr 導到檔案,避免管線塞滿造成死鎖
            with err_file.open("w", encoding="utf-8") as ef:
                proc = subprocess.Popen(
                    args, cwd=str(d), stdout=subprocess.PIPE, stderr=ef,
                    text=True, encoding="utf-8", errors="replace",
                )
                job["proc"] = proc
                assert proc.stdout is not None
                for line in proc.stdout:
                    m = re.match(r"out_time=(\d+):(\d+):([\d.]+)", line.strip())
                    if m and duration > 0:
                        t = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
                        job["progress"] = min(round(t / duration, 3), 0.99)
                proc.wait()
                job["proc"] = None

            if job["cancel"]:
                job["status"] = "canceled"
                return
            if proc.returncode == 0:
                job["progress"] = 1.0
                job["status"] = "done"
                return
            last_err = err_file.read_text(encoding="utf-8", errors="replace").strip()[-300:]
            print(f"[vidscribe] {vcodec}+{acodec} 匯出失敗,換下一個組合:{last_err}")
        raise RuntimeError(f"ffmpeg 匯出失敗:{last_err}")
    except Exception as e:
        traceback.print_exc()
        if job.get("status") != "canceled":
            job["status"] = "error"
            job["error"] = str(e)[:400]
    finally:
        job["proc"] = None
        err_file.unlink(missing_ok=True)
