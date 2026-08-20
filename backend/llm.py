"""用使用者已安裝的 Claude Code CLI(走訂閱)做字幕錯字校正。

設計原則(見 SPEC 3.5):
- 指令自動尋路,找不到就整個功能隱藏,不影響其他功能
- 只送「行號+文字」,LLM 碰不到時間軸;回傳用 --json-schema 強制結構
- 大批次呼叫(每次呼叫有 ~30k token 的固定開銷)
- 建議不自動套用,由前端 diff 審閱
"""

import json
import os
import shutil
import subprocess
import threading
import time
import traceback
from pathlib import Path

from . import storage

MODEL = os.environ.get("VIDSCRIBE_FIX_MODEL", "sonnet")
BATCH_CHARS = 4000  # 每批的字元預算
BATCH_LINES = 80
TIMEOUT = 300

SCHEMA = json.dumps(
    {
        "type": "object",
        "properties": {
            "changes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "i": {"type": "integer"},
                        "t": {"type": "string"},
                    },
                    "required": ["i", "t"],
                },
            }
        },
        "required": ["changes"],
    },
    separators=(",", ":"),
)

PROMPT = """你是台灣的專業字幕校對員。最後面附上一段影片的字幕 JSON 陣列(繁體中文、台灣口語),每項有行號 i 與文字 t。
請找出並修正:
1. 語音辨識造成的同音錯字與選字錯誤(例:其美博物館→奇美博物館、發老→法老、在→再)
2. 中國用語改成台灣慣用語(例:視頻→影片、質量→品質、軟件→軟體)
3. 品牌與專有名詞的正確寫法與大小寫(例:youtube→YouTube、Ig→IG)
規則:
- 只回傳有修正的行,沒錯的行不要回傳
- 不可增刪或合併句子,不可改變句意
- 口語詞與語氣詞(嗯、啊、欸、就是、其實…)一律保留,不要書面化
- 字數盡量與原文相近,禁止重寫句子
- 標點維持原樣,不要新增句尾標點
用 changes 回傳:i 是原行號,t 是修正後的整行文字。整批都沒錯就回傳空的 changes。"""

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def find_claude() -> list[str] | None:
    path = shutil.which("claude")
    if not path:
        candidates = [
            Path.home() / ".local" / "bin" / "claude.exe",
            Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd",
        ]
        for c in candidates:
            if c.is_file():
                path = str(c)
                break
    if not path:
        return None
    # .cmd/.bat 無法被 CreateProcess 直接執行,要透過 cmd /c
    if path.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", path]
    return [path]


def _public_state(job: dict | None) -> dict:
    if job is None:
        return {"status": "idle"}
    return {k: job[k] for k in ("status", "total", "done", "suggestions", "error", "started_at")}


def _fix_file(pid: str):
    return storage.project_dir(pid) / "fix.json"


def _save_fix_file(pid: str, job: dict) -> None:
    """校正結果落地,伺服器重開也還原得回來。"""
    f = _fix_file(pid)
    tmp = f.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fp:
        json.dump(
            {
                "total": job.get("total", 1),
                "started_at": job.get("started_at"),
                "suggestions": job.get("suggestions", []),
            },
            fp,
            ensure_ascii=False,
        )
    os.replace(tmp, f)


def get_state(pid: str) -> dict:
    with _lock:
        job = _jobs.get(pid)
        if job is not None:
            return _public_state(job)
    f = _fix_file(pid)
    if f.is_file():
        try:
            with f.open("r", encoding="utf-8") as fp:
                data = json.load(fp)
            return {
                "status": "done",
                "total": data.get("total", 1),
                "done": data.get("total", 1),
                "suggestions": data.get("suggestions", []),
                "error": None,
                "started_at": data.get("started_at"),
            }
        except (OSError, json.JSONDecodeError):
            pass
    return {"status": "idle"}


def cancel(pid: str) -> None:
    with _lock:
        job = _jobs.get(pid)
        if job and job["status"] == "running":
            job["cancel"] = True
        else:
            _jobs.pop(pid, None)
    _fix_file(pid).unlink(missing_ok=True)


def update_suggestions(pid: str, suggestions: list[dict]) -> None:
    """審閱時同步剩餘清單(接受/略過一條就少一條),關機重開能從剩的繼續。"""
    with _lock:
        job = _jobs.get(pid)
        if job and job["status"] == "done":
            job["suggestions"] = suggestions
        holder = dict(job) if job else {"total": 1, "started_at": None, "suggestions": suggestions}
    holder["suggestions"] = suggestions
    if suggestions:
        _save_fix_file(pid, holder)
    else:
        _fix_file(pid).unlink(missing_ok=True)


def start(pid: str) -> dict:
    cmd = find_claude()
    if cmd is None:
        raise RuntimeError("找不到 claude 指令,請先安裝 Claude Code")
    segments = storage.load_subtitles(pid)["segments"]
    if not segments:
        raise RuntimeError("這個專案還沒有字幕")

    batches: list[list[int]] = []
    cur: list[int] = []
    chars = 0
    for i, s in enumerate(segments):
        cur.append(i)
        chars += len(s["text"])
        if len(cur) >= BATCH_LINES or chars >= BATCH_CHARS:
            batches.append(cur)
            cur, chars = [], 0
    if cur:
        batches.append(cur)

    job = {
        "status": "running",
        "total": len(batches),
        "done": 0,
        "suggestions": [],
        "error": None,
        "started_at": time.time(),
        "cancel": False,
    }
    with _lock:
        existing = _jobs.get(pid)
        if existing and existing["status"] == "running":
            raise RuntimeError("AI 校正已在進行中")
        _jobs[pid] = job

    threading.Thread(target=_run, args=(pid, cmd, segments, batches, job), daemon=True).start()
    return _public_state(job)


def _run_batch(cmd: list[str], segments: list[dict], indices: list[int]) -> list[dict]:
    payload = json.dumps(
        [{"i": i, "t": segments[i]["text"]} for i in indices], ensure_ascii=False
    )
    # 多行的提示詞不放命令列(npm 版 claude.cmd 經 cmd /c 轉手會壞),
    # 全部改走 stdin;命令列只留單行參數。
    proc = subprocess.run(
        cmd
        + [
            "-p",
            "--output-format", "json",
            "--json-schema", SCHEMA,
            "--model", MODEL,
        ],
        input=f"{PROMPT}\n\n字幕內容:\n{payload}",
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=TIMEOUT,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude 執行失敗:{(proc.stderr or proc.stdout).strip()[-300:]}")
    data = json.loads(proc.stdout)
    if data.get("is_error") or data.get("subtype") != "success":
        raise RuntimeError(f"claude 回傳錯誤:{str(data.get('result'))[:300]}")
    out = data.get("structured_output")
    if not isinstance(out, dict):
        # 少數情況沒有 structured_output,退而求其次從文字結果解析
        text = str(data.get("result", "")).strip()
        if text.startswith("```"):
            text = text.strip("`").removeprefix("json").strip()
        out = json.loads(text)
    changes = out.get("changes") or []

    valid = set(indices)
    suggestions = []
    for c in changes:
        i = c.get("i")
        new = (c.get("t") or "").strip()
        if i in valid and new and new != segments[i]["text"]:
            suggestions.append({"id": segments[i]["id"], "old": segments[i]["text"], "new": new})
    return suggestions


def _run(pid: str, cmd: list[str], segments: list[dict], batches: list[list[int]], job: dict) -> None:
    try:
        for indices in batches:
            if job["cancel"]:
                job["status"] = "canceled"
                return
            suggestions = _run_batch(cmd, segments, indices)
            with _lock:
                job["suggestions"].extend(suggestions)
                job["done"] += 1
        job["status"] = "done"
        try:
            _save_fix_file(pid, job)
        except OSError:
            traceback.print_exc()  # 存檔失敗不影響本次結果,只是重開伺服器會遺失
    except Exception as e:
        traceback.print_exc()
        job["status"] = "error"
        job["error"] = str(e)[:500]


# ---- 詞庫建議:使用者改字後,判斷這是不是「值得記起來」的專有名詞修正 ----

_DICT_SCHEMA = (
    '{"type":"object","properties":{"add":{"type":"boolean"},'
    '"reason":{"type":"string"}},"required":["add","reason"]}'
)

_DICT_PROMPT = """你在協助一個字幕編輯器維護「錯字自動取代」詞庫。
使用者把辨識結果的某段文字改掉了。請判斷這個修正是否值得寫進詞庫
(寫進去之後,以後每次辨識完都會自動把「錯誤寫法」換成「正確寫法」)。

值得加入 (add=true) 的情況:
- 人名、頻道名、品牌名、地名等專有名詞被聽錯(例:依利 → 伊森)
- 該領域的專業術語被聽成同音的一般詞
- 固定用字偏好(例:妳 → 你)且錯誤寫法夠獨特,不會誤傷其他句子

不值得加入 (add=false) 的情況:
- 只是修飾語氣、增刪標點、調整語序
- 錯誤寫法是很常見的一般詞(例:「他」「這個」),全域取代會誤傷別的句子
- 兩邊意思根本不同,是使用者自己改寫內容,不是辨識錯誤

reason 用繁體中文一句話說明。"""


def suggest_dict_entry(wrong: str, right: str) -> dict:
    """回傳 {"add": bool, "reason": str, "by": "ai"|"rule"}。

    有 Claude Code CLI 就問它;沒有就退回保守規則(只有等長、純中文、
    2~6 字的修正才建議),避免把「他→她」這種常見字寫進詞庫誤傷全片。
    """
    cmd = find_claude()
    if cmd:
        try:
            proc = subprocess.run(
                cmd + ["-p", "--output-format", "json", "--json-schema", _DICT_SCHEMA,
                       "--model", MODEL],
                input=f"{_DICT_PROMPT}\n\n錯誤寫法:{wrong}\n正確寫法:{right}",
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=45,
            )
            if proc.returncode == 0:
                data = json.loads(proc.stdout)
                out = data.get("structured_output")
                if not isinstance(out, dict):
                    text = str(data.get("result", "")).strip().strip("`")
                    out = json.loads(text.removeprefix("json").strip())
                return {"add": bool(out.get("add")), "reason": str(out.get("reason", ""))[:120],
                        "by": "ai"}
        except (OSError, ValueError, subprocess.SubprocessError):
            pass  # AI 不可用就走規則

    cjk = all("\u4e00" <= c <= "\u9fff" for c in wrong + right)
    ok = cjk and len(wrong) == len(right) and 2 <= len(wrong) <= 6 and wrong != right
    return {
        "add": ok,
        "reason": "看起來像專有名詞的同音修正" if ok else "不像固定的專有名詞修正",
        "by": "rule",
    }
