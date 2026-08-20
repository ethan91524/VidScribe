import json
import subprocess
import threading
import traceback
import math
import uuid

from . import config, storage

_model = None
_model_device = None
_model_lock = threading.Lock()
_transcribe_lock = threading.Lock()  # 一次只跑一個辨識,後來的排隊
_force_cpu = False
_running: set[str] = set()
_running_lock = threading.Lock()

_cc = None


def is_running(pid: str) -> bool:
    with _running_lock:
        return pid in _running


def start_job(pid: str) -> bool:
    with _running_lock:
        if pid in _running:
            return False
        _running.add(pid)
    threading.Thread(target=_run, args=(pid,), daemon=True).start()
    return True


def _update(meta: dict, **kw) -> None:
    meta.update(kw)
    storage.save_project(meta)


def _probe(media) -> tuple[float, bool]:
    out = subprocess.run(
        [config.FFPROBE, "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(media)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe 讀取失敗:{out.stderr.strip()[-300:]}")
    info = json.loads(out.stdout)
    duration = float(info.get("format", {}).get("duration") or 0.0)
    has_video = any(
        s.get("codec_type") == "video" and s.get("codec_name") not in ("mjpeg", "png", "bmp", "gif")
        for s in info.get("streams", [])
    )
    return duration, has_video


def _extract_audio(media, wav) -> None:
    out = subprocess.run(
        [config.FFMPEG, "-y", "-v", "error", "-i", str(media),
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffmpeg 抽取音軌失敗:{out.stderr.strip()[-300:]}")


def _get_model(status_cb):
    global _model, _model_device, _force_cpu
    with _model_lock:
        if _model is None:
            status_cb()
            config.setup_cuda_dlls()
            from faster_whisper import WhisperModel
            config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
            root = str(config.MODELS_DIR)
            if not _force_cpu:
                try:
                    _model = WhisperModel(
                        config.MODEL_NAME, device="cuda", compute_type="float16",
                        download_root=root,
                    )
                    _model_device = "cuda"
                except Exception as e:
                    print(f"[vidscribe] CUDA 初始化失敗,改用 CPU:{e}")
                    _force_cpu = True
            if _model is None:
                _model = WhisperModel(
                    config.MODEL_NAME, device="cpu", compute_type="int8",
                    download_root=root,
                )
                _model_device = "cpu"
        return _model, _model_device


def _reset_model_to_cpu() -> None:
    global _model, _force_cpu
    with _model_lock:
        _model = None
        _force_cpu = True


def _snap_starts_to_speech(segments: list[dict], wav_path, max_shift=0.6, backoff=0.08) -> list[dict]:
    """把句子起點推到真正發出聲音的位置。

    Whisper 的字級時間戳是用 cross-attention 對齊推出來的,句首普遍偏早;
    實測一段 54 秒的問診錄音,字幕平均比人聲早 0.55 秒(最多 1.08 秒)出現。
    這裡直接讀音檔算 10ms 音量,從句首往後找第一個高於門檻的位置。
    只會把起點往後移、不會往前,位移上限 max_shift 秒,再往回讓 backoff 秒
    避免削掉氣音開頭;句子被壓到太短就放棄不動。
    """
    import wave

    import numpy as np

    try:
        with wave.open(str(wav_path), "rb") as w:
            sr = w.getframerate()
            data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    except (OSError, wave.Error):
        return segments
    hop = max(int(sr * 0.01), 1)
    n = (len(data) - hop) // hop
    if n <= 0:
        return segments
    frames = data[: n * hop].reshape(n, hop)
    rms = np.sqrt((frames**2).mean(axis=1))
    noise = float(np.percentile(rms, 20))
    peak = float(np.percentile(rms, 95))
    if peak <= noise:
        return segments
    thr = noise + (peak - noise) * 0.15

    for s in segments:
        i0 = int(s["start"] / 0.01)
        limit = min(int((s["start"] + max_shift) / 0.01), n)
        j = i0
        while j < limit and rms[j] < thr:
            j += 1
        if j <= i0 or j >= limit:
            continue  # 句首本來就有聲音,或整段都在門檻下(氣音/背景吵) → 不動
        onset = max(s["start"], j * 0.01 - backoff)
        if onset < s["end"] - 0.15:
            s["start"] = round(onset, 3)
    return segments


def _transcribe(meta: dict, audio, duration: float) -> list[dict]:
    model, device = _get_model(lambda: _update(meta, status="loading_model"))
    _update(meta, status="transcribing", progress=0.0, device=device)

    lang = None if config.LANGUAGE == "auto" else config.LANGUAGE
    kwargs = dict(
        language=lang,
        word_timestamps=True,
        vad_filter=True,
        # VAD 的 speech_pad_ms 維持預設 400ms:實測調到 100ms 雖然時間更貼,
        # 但會削掉字頭害辨識變差(「你現在有沒有好一點」被聽成「按一下有沒有
        # 好一點」,句子還被合併變長)。時間軸改用 _snap_starts_to_speech 修。
        # 預設會把前文餵回模型當條件。好處是標點風格連貫,壞處是前面錯了會一路
        # 帶錯、模型鬼打牆重複時還會反覆重試解碼:實測同一段 54 秒音檔,開著要
        # 319~1350 秒且整段漏掉兩句對話,關掉只要 9 秒且不漏句。
        condition_on_previous_text=False,
    )
    if lang == "zh":
        kwargs["initial_prompt"] = "以下是繁體中文的內容。"

    seg_iter, info = model.transcribe(str(audio), **kwargs)
    segments = []
    for s in seg_iter:
        text = s.text.strip()
        if not text:
            continue
        # p = 該字的辨識信心(0~1),供編輯器標出最沒把握的字
        words = [
            {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word,
             "p": round(float(w.probability), 3)}
            for w in (s.words or [])
        ]
        # 句子邊界收緊到實際發音的第一個字/最後一個字:VAD 補值與模型的
        # 區段時間都會比真正的語音早開始、晚結束,逐字時間戳準得多。
        # 只在合理範圍內採用(不能比原邊界早、也不能把句子壓成負長度)。
        start, end = round(s.start, 3), round(s.end, 3)
        if words:
            w0, w1 = words[0]["start"], words[-1]["end"]
            if start <= w0 < end:
                start = w0
            if start < w1 <= end:
                end = w1
        # 整句信心:avg_logprob 是每 token 的平均對數機率,取 exp 還原成 0~1
        conf = round(min(math.exp(s.avg_logprob), 1.0), 3) if s.avg_logprob is not None else None
        segments.append({
            "id": uuid.uuid4().hex[:8],
            "start": start,
            "end": end,
            "text": text,
            "words": words,
            "conf": conf,
        })
        if duration > 0:
            meta["progress"] = min(round(s.end / duration, 3), 0.99)
        if len(segments) % 5 == 0:
            storage.save_project(meta)
    meta["language"] = info.language
    return _snap_starts_to_speech(segments, audio)


def _to_traditional(segments: list[dict]) -> list[dict]:
    global _cc
    if _cc is None:
        from opencc import OpenCC
        _cc = OpenCC("s2twp")
    for s in segments:
        s["text"] = _cc.convert(s["text"])
        for w in s.get("words", []):
            w["word"] = _cc.convert(w["word"])
    return segments


def _run(pid: str) -> None:
    meta = storage.load_project(pid)
    if meta is None:
        with _running_lock:
            _running.discard(pid)
        return
    d = storage.project_dir(pid)
    try:
        _update(meta, status="extracting", progress=0.0, error=None)
        media = d / meta["media_file"]
        duration, has_video = _probe(media)
        _update(meta, duration=duration, has_video=has_video)

        audio = d / "audio.wav"
        _extract_audio(media, audio)

        try:
            from . import waveform
            waveform.generate(audio, d / "waveform.json")
        except Exception:
            traceback.print_exc()  # 波形失敗不影響辨識,之後 API 會再試一次

        with _transcribe_lock:
            try:
                segments = _transcribe(meta, audio, duration)
            except Exception:
                if _model_device == "cuda":
                    # GPU 在辨識途中失敗(常見於 cuDNN 缺 DLL),換 CPU 重試一次
                    traceback.print_exc()
                    print("[vidscribe] GPU 辨識失敗,改用 CPU 重試")
                    _reset_model_to_cpu()
                    segments = _transcribe(meta, audio, duration)
                else:
                    raise

        _update(meta, status="converting", progress=1.0)
        if (meta.get("language") or "").startswith("zh"):
            segments = _to_traditional(segments)

        # 套用詞庫(錯誤寫法 → 正確寫法)
        from . import dictionary
        entries = dictionary.load()
        if entries:
            for s in segments:
                s["text"] = dictionary.apply_text(s["text"], entries)

        storage.backup_subtitles(pid)  # 覆蓋前備份舊字幕(若有)
        storage.save_subtitles(pid, {"version": 1, "segments": segments})
        _update(meta, status="done", progress=1.0)
    except Exception as e:
        traceback.print_exc()
        try:
            _update(meta, status="error", error=str(e)[:500])
        except Exception:
            traceback.print_exc()
    finally:
        with _running_lock:
            _running.discard(pid)
