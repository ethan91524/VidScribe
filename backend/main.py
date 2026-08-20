import asyncio
import shutil
import urllib.parse
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import burn, config, cuts, dictionary, exporter, llm, storage, transcriber, waveform

MEDIA_EXTS = {
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".mts", ".m2ts",
    ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    storage.mark_stale_jobs_interrupted()

    # 瀏覽器拖影片進度條時會不斷掐斷串流連線,Windows 的 Proactor 迴圈
    # 每次都印一段 ConnectionResetError——無害但很吵,這裡吃掉它。
    loop = asyncio.get_running_loop()

    def quiet_handler(loop: asyncio.AbstractEventLoop, context: dict) -> None:
        if isinstance(context.get("exception"), ConnectionResetError):
            return
        loop.default_exception_handler(context)

    loop.set_exception_handler(quiet_handler)
    yield


app = FastAPI(title="VidScribe", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)

# 擋 DNS rebinding:只接受本機 Host,其他一律拒絕
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

# 擋 CSRF:跨站的「簡單請求」(如 multipart POST)不需 preflight 就會送達,
# 瀏覽器會帶上 Origin,非本站來源的寫入請求一律拒絕(無 Origin 的本機工具照常)。
_ALLOWED_ORIGINS = {
    f"http://127.0.0.1:{config.PORT}",
    f"http://localhost:{config.PORT}",
}


@app.middleware("http")
async def csrf_guard(request: Request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and origin not in _ALLOWED_ORIGINS:
            return JSONResponse({"detail": "跨站請求被拒"}, status_code=403)
    return await call_next(request)


def _get_project_or_404(pid: str) -> dict:
    meta = storage.load_project(pid)
    if meta is None:
        raise HTTPException(404, "找不到專案")
    return meta


@app.get("/api/health")
def health():
    return {
        "ffmpeg": config.ffmpeg_available(),
        "claude": llm.find_claude() is not None,
    }


@app.get("/api/projects")
def list_projects():
    return storage.list_projects()


@app.post("/api/projects")
def create_project(file: UploadFile = File(...)):
    # 同步函式:FastAPI 會丟進 threadpool,大檔複製才不會卡住整個事件迴圈
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in MEDIA_EXTS:
        raise HTTPException(400, f"不支援的檔案格式:{suffix or '(無副檔名)'}")
    meta = storage.create_project(Path(file.filename).stem, suffix)
    dest = storage.project_dir(meta["id"]) / meta["media_file"]
    try:
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f, 1024 * 1024)
    except Exception:
        storage.delete_project(meta["id"])
        raise HTTPException(500, "檔案儲存失敗")
    transcriber.start_job(meta["id"])
    return storage.load_project(meta["id"])


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return _get_project_or_404(pid)


@app.patch("/api/projects/{pid}")
def rename_project(pid: str, body: dict = Body(...)):
    meta = _get_project_or_404(pid)
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "名稱不可為空")
    meta["name"] = name
    storage.save_project(meta)
    return meta


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    _get_project_or_404(pid)
    if transcriber.is_running(pid):
        raise HTTPException(409, "辨識進行中,無法刪除")
    storage.delete_project(pid)
    return {"ok": True}


@app.post("/api/projects/{pid}/transcribe")
def retranscribe(pid: str):
    meta = _get_project_or_404(pid)
    if not transcriber.start_job(pid):
        raise HTTPException(409, "辨識已在進行中")
    return storage.load_project(pid) or meta


@app.get("/api/projects/{pid}/subtitles")
def get_subtitles(pid: str):
    _get_project_or_404(pid)
    return storage.load_subtitles(pid)


@app.put("/api/projects/{pid}/subtitles")
def put_subtitles(pid: str, body: dict = Body(...)):
    _get_project_or_404(pid)
    segments = body.get("segments")
    if not isinstance(segments, list):
        raise HTTPException(400, "segments 必須是陣列")
    for s in segments:
        if not (isinstance(s, dict) and "start" in s and "end" in s and "text" in s):
            raise HTTPException(400, "字幕格式錯誤")
    marks = body.get("marks") or []
    if not (isinstance(marks, list) and all(isinstance(m, (int, float)) for m in marks)):
        raise HTTPException(400, "marks 必須是數字陣列")
    style = body.get("style")
    if style is not None and not isinstance(style, dict):
        raise HTTPException(400, "style 必須是物件")
    storage.save_subtitles(
        pid, {"version": 1, "segments": segments, "marks": marks, "style": style}
    )
    return {"ok": True}


@app.post("/api/projects/{pid}/burn")
def start_burn(pid: str):
    _get_project_or_404(pid)
    try:
        return burn.start(pid)
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@app.get("/api/projects/{pid}/burn")
def get_burn(pid: str):
    _get_project_or_404(pid)
    return burn.get_state(pid)


@app.delete("/api/projects/{pid}/burn")
def cancel_burn(pid: str):
    _get_project_or_404(pid)
    burn.cancel(pid)
    return {"ok": True}


@app.get("/api/projects/{pid}/burn/file")
def get_burn_file(pid: str):
    meta = _get_project_or_404(pid)
    path = storage.project_dir(pid) / burn.OUT_NAME
    if not path.is_file():
        raise HTTPException(404, "還沒有匯出的影片")
    filename = urllib.parse.quote(f"{meta['name']}_字幕.mp4")
    return FileResponse(
        path,
        media_type="video/mp4",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@app.get("/api/projects/{pid}/cuts")
def get_cuts(pid: str):
    _get_project_or_404(pid)
    return cuts.get_state(pid)


@app.post("/api/projects/{pid}/cuts")
def start_cuts(pid: str):
    _get_project_or_404(pid)
    try:
        return cuts.start(pid)
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@app.get("/api/dictionary")
def get_dictionary():
    return {"entries": dictionary.load()}


@app.post("/api/dictionary")
def add_dict_entry(body: dict = Body(...)):
    try:
        entries = dictionary.add(body.get("wrong") or "", body.get("right") or "")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"entries": entries}


@app.delete("/api/dictionary/{entry_id}")
def delete_dict_entry(entry_id: str):
    return {"entries": dictionary.remove(entry_id)}


@app.get("/api/llm/status")
def llm_status():
    return {"available": llm.find_claude() is not None}


@app.post("/api/projects/{pid}/fix")
def start_fix(pid: str):
    _get_project_or_404(pid)
    try:
        return llm.start(pid)
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@app.get("/api/projects/{pid}/fix")
def get_fix(pid: str):
    _get_project_or_404(pid)
    return llm.get_state(pid)


@app.put("/api/projects/{pid}/fix")
def update_fix(pid: str, body: dict = Body(...)):
    _get_project_or_404(pid)
    suggestions = body.get("suggestions")
    if not isinstance(suggestions, list) or not all(
        isinstance(s, dict) and "id" in s and "old" in s and "new" in s for s in suggestions
    ):
        raise HTTPException(400, "suggestions 格式錯誤")
    llm.update_suggestions(pid, suggestions)
    return {"ok": True}


@app.delete("/api/projects/{pid}/fix")
def cancel_fix(pid: str):
    _get_project_or_404(pid)
    llm.cancel(pid)
    return {"ok": True}


@app.get("/api/projects/{pid}/waveform")
def get_waveform(pid: str):
    _get_project_or_404(pid)
    d = storage.project_dir(pid)
    f = d / "waveform.json"
    if not f.is_file():
        wav = d / "audio.wav"
        if not wav.is_file():
            raise HTTPException(404, "找不到音軌,請重新辨識一次")
        waveform.generate(wav, f)
    return FileResponse(f, media_type="application/json")


@app.get("/api/projects/{pid}/media")
def get_media(pid: str):
    meta = _get_project_or_404(pid)
    path = storage.project_dir(pid) / meta["media_file"]
    if not path.is_file():
        raise HTTPException(404, "找不到媒體檔")
    return FileResponse(path)


@app.get("/api/projects/{pid}/export")
def export_subtitles(pid: str, format: str = "srt"):
    meta = _get_project_or_404(pid)
    subs = storage.load_subtitles(pid)
    try:
        filename, content, mime = exporter.export(subs["segments"], format, meta["name"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{urllib.parse.quote(filename)}"
    }
    return Response(content=content, media_type=mime, headers=headers)


if config.FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST, html=True), name="static")
