def _fmt_time(t: float, ms_sep: str) -> str:
    if t < 0:
        t = 0.0
    ms = round(t * 1000)
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{ms_sep}{ms:03d}"


def to_srt(segments: list[dict]) -> str:
    blocks = []
    for i, s in enumerate(segments, 1):
        blocks.append(
            f"{i}\n{_fmt_time(s['start'], ',')} --> {_fmt_time(s['end'], ',')}\n{s['text']}\n"
        )
    return "\n".join(blocks)


def to_vtt(segments: list[dict]) -> str:
    blocks = ["WEBVTT\n"]
    for s in segments:
        blocks.append(
            f"{_fmt_time(s['start'], '.')} --> {_fmt_time(s['end'], '.')}\n{s['text']}\n"
        )
    return "\n".join(blocks)


def to_txt(segments: list[dict]) -> str:
    return "\n".join(s["text"] for s in segments) + "\n"


def to_txt_ts(segments: list[dict]) -> str:
    lines = []
    for s in segments:
        m, sec = divmod(int(s["start"]), 60)
        h, m = divmod(m, 60)
        stamp = f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"
        lines.append(f"[{stamp}] {s['text']}")
    return "\n".join(lines) + "\n"


def _ass_time(t: float) -> str:
    if t < 0:
        t = 0.0
    cs = round(t * 100)
    h, rem = divmod(cs, 360_000)
    m, rem = divmod(rem, 6_000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _ass_escape(text: str) -> str:
    # 大括號在 ASS 是樣式控制碼,換行用 \N
    return text.replace("{", "(").replace("}", ")").replace("\n", "\\N")


# 字幕樣式預設值,鍵名與前端 types.ts 的 DEFAULT_STYLE 一致。
# 對齊「字在」app 實測外觀:白字、特粗、底框深灰、置中偏下。
STYLE_DEFAULTS = {
    "anim": "none",
    "font": "Microsoft JhengHei",
    "weight": 800,        # 400/700/800/900,取代原本的 bold 布林
    "italic": False,
    "underline": False,
    "size": 0.0909,       # 字級,佔影片高度比例
    "lineHeight": 1.25,   # 行高倍率;ASS 無對應欄位,僅預覽生效 [TODO]
    "spacing": 0.0,       # 字距,佔影片高度比例
    "color": "#FFFFFF",
    "alpha": 1.0,
    "box": True,
    "boxColor": "#111111",
    "boxAlpha": 0.78,
    "boxRadius": 0.0214,  # 圓角,佔影片高度比例;圓角只在預覽呈現,libass 不支援
    "padX": 0.0374,       # 底框左右內距,佔影片高度比例(取代舊 boxPadX)
    "padY": 0.0187,       # 底框上下內距,佔影片高度比例(取代舊 boxPadY)
    "maxWidth": 0.86,     # 字幕最大寬度,佔影片寬度比例
    "outline": 0,         # 描邊粗細,佔影片高度比例;開底框時 ASS 無法同時描邊
    "outlineColor": "#000000",
    "shadow": False,
    "x": 0.5,             # 錨點位置(比例)
    "y": 0.84,
    "align": "center",
    "highlight": False,   # 逐字高亮開關
    "highlightColor": "#C9FF38",
}


def _ass_color(hex_color: str, alpha: float) -> str:
    """#RRGGBB + 不透明度(1=不透明) → ASS 的 &HAABBGGRR。"""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    aa = max(0, min(255, round((1 - alpha) * 255)))
    return f"&H{aa:02X}{b}{g}{r}".upper()


def _ass_color_inline(hex_color: str) -> str:
    """#RRGGBB → ASS 行內 \\c 標籤用的 &HBBGGRR&(不含透明度)。"""
    h = (hex_color or "").lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{b}{g}{r}&".upper()


def _locate_word_events(s: dict, tags: str, primary_inline: str, highlight_inline: str) -> list[str] | None:
    """把一句拆成逐字 Dialogue(當下字用 highlightColor 包住,其餘用字色)。

    每個 word 各發一條 [word.start, word.end) 的 Dialogue,文字為整句,
    但當下那個字用 {\\c高亮}詞{\\c字色} 包起來。定位邏輯與前端
    frontend/src/segments.ts 的 splitSegmentAtTime 一致:用 indexOf 從
    searchFrom 往後找,對不上就回傳 None,呼叫端退回整句一條。
    """
    words = s.get("words") or []
    text = s["text"]
    if not words or not text.strip():
        return None
    search_from = 0
    located = []
    for w in words:
        token = (w.get("word") or "").strip()
        if not token:
            continue
        idx = text.find(token, search_from)
        if idx < 0:
            return None
        located.append((w, idx, token))
        search_from = idx + len(token)
    if not located:
        return None
    events = []
    for w, idx, token in located:
        before = _ass_escape(text[:idx])
        mid = _ass_escape(token)
        after = _ass_escape(text[idx + len(token):])
        line = f"{before}{{\\c{highlight_inline}}}{mid}{{\\c{primary_inline}}}{after}"
        events.append(
            f"Dialogue: 0,{_ass_time(w['start'])},{_ass_time(w['end'])},Default,,0,0,0,,"
            f"{{{tags}}}{line}"
        )
    return events


# 數值欄位的合法範圍,與前端 types.ts 的 STYLE_RANGE 一致。
_STYLE_RANGE = {
    "weight": (400, 900), "size": (0.02, 0.2), "lineHeight": (1, 2),
    "spacing": (0, 0.05), "alpha": (0, 1), "boxAlpha": (0, 1),
    "boxRadius": (0, 0.06), "padX": (0, 0.12), "padY": (0, 0.08),
    "maxWidth": (0.3, 0.96), "outline": (0, 0.012), "x": (0.02, 0.98), "y": (0.02, 0.98),
}


def _sanitize_style(style: dict | None) -> dict:
    """補預設值、換算舊單位、夾住範圍。

    舊版存檔的 outline/boxRadius 是「1080p 基準 px」(例如 outline=4),
    新版是比例;直接拿來乘畫面高度會變成 4 倍畫面高的描邊,字幕整個爆掉。
    前端 migrateStyle 做同樣的事,這裡是給直接吃舊 JSON 的燒錄流程兜底。
    """
    st = {**STYLE_DEFAULTS, **(style or {})}
    if "weight" not in (style or {}) and isinstance((style or {}).get("bold"), bool):
        st["weight"] = 700 if style["bold"] else 400
    for key, base in (("outline", 1080.0), ("boxRadius", 1080.0)):
        v = st.get(key)
        if isinstance(v, (int, float)) and v > _STYLE_RANGE[key][1]:
            st[key] = v / base
    for key, (lo, hi) in _STYLE_RANGE.items():
        v = st.get(key)
        st[key] = STYLE_DEFAULTS[key] if not isinstance(v, (int, float)) else min(max(v, lo), hi)
    return st


def to_ass(segments: list[dict], width: int, height: int, style: dict | None = None) -> str:
    """燒錄用 ASS 字幕,吃編輯器的字幕樣式(位置用 \\pos 對齊預覽)。

    size/spacing/outline/padX/padY/boxRadius/maxWidth 在前端都是「佔影片
    高度或寬度的比例」,這裡一律直接乘 height/width 換算成該解析度的 px,
    不再走舊版以 1080p 為基準再乘 scale 的間接算法。
    lineHeight、boxRadius 的圓角視覺效果 ASS/libass 無對應欄位,僅預覽生
    效 [TODO];weight 的 800/900 在 ASS 只有 Bold 二值可用,一律映射為粗體。
    """
    st = _sanitize_style(style)
    fs = max(round(float(st["size"]) * height), 8)
    spacing = round(float(st["spacing"]) * height, 1)
    primary = _ass_color(st["color"], float(st["alpha"]))
    weight = int(float(st.get("weight", 800) or 800))
    bold_flag = 0 if weight == 400 else -1
    if st["box"]:
        # BorderStyle=3:OutlineColour 就是底框顏色,Outline 是底框留邊
        border_style = 3
        outline_color = _ass_color(st["boxColor"], float(st["boxAlpha"]))
        pad_x = max(round(float(st["padX"]) * height, 1), 0)
        pad_y = max(round(float(st["padY"]) * height, 1), 0)
        outline = pad_y  # style 層先填一個,實際用 \xbord \ybord 分開控制
    else:
        border_style = 1
        outline_color = _ass_color(st.get("outlineColor", "#000000"), 1.0)
        outline = round(float(st["outline"]) * height, 1)
        pad_x = pad_y = None
    shadow = round(0.002 * height) if st["shadow"] else 0
    max_width = float(st.get("maxWidth", 0.86))
    margin_lr = max(round((1 - max_width) / 2 * width), 0)
    align_an = {"left": 4, "center": 5, "right": 6}.get(st["align"], 5)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{st['font']},{fs},{primary},{primary},"
        f"{outline_color},&H80000000,{bold_flag},"
        f"{-1 if st['italic'] else 0},{-1 if st['underline'] else 0},0,"
        f"100,100,{spacing},0,{border_style},{outline},{shadow},"
        f"{align_an},{margin_lr},{margin_lr},20,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    pos_x = round(float(st["x"]) * width, 1)
    pos_y = round(float(st["y"]) * height, 1)
    tags = f"\\an{align_an}\\pos({pos_x},{pos_y})"
    if st["box"]:
        tags += f"\\xbord{pad_x}\\ybord{pad_y}"
    if st["anim"] == "fade":
        tags += "\\fad(200,0)"
    elif st["anim"] == "pop":
        tags += "\\fscx70\\fscy70\\t(0,140,\\fscx100\\fscy100)"

    primary_inline = _ass_color_inline(st["color"])
    highlight_inline = _ass_color_inline(st.get("highlightColor", "#C9FF38"))

    events: list[str] = []
    for s in segments:
        if not s["text"].strip():
            continue
        if st.get("highlight") and s.get("words"):
            word_events = _locate_word_events(s, tags, primary_inline, highlight_inline)
            if word_events:
                events.extend(word_events)
                continue
        events.append(
            f"Dialogue: 0,{_ass_time(s['start'])},{_ass_time(s['end'])},Default,,0,0,0,,"
            f"{{{tags}}}{_ass_escape(s['text'])}"
        )
    return header + "\n".join(events) + "\n"


# format -> (轉換函式, 副檔名, MIME, 是否加 BOM)
# SRT/TXT 加 BOM,Premiere/剪映等軟體讀中文比較不會亂碼;VTT 規範上以 WEBVTT 開頭,不加。
FORMATS = {
    "srt": (to_srt, "srt", "application/x-subrip", True),
    "vtt": (to_vtt, "vtt", "text/vtt", False),
    "txt": (to_txt, "txt", "text/plain", True),
    "txt-ts": (to_txt_ts, "txt", "text/plain", True),
}


def export(segments: list[dict], fmt: str, name: str) -> tuple[str, bytes, str]:
    if fmt not in FORMATS:
        raise ValueError(f"不支援的格式:{fmt}")
    fn, ext, mime, bom = FORMATS[fmt]
    content = fn(segments).encode("utf-8-sig" if bom else "utf-8")
    suffix = "_逐字稿" if fmt.startswith("txt") else ""
    return f"{name}{suffix}.{ext}", content, mime
