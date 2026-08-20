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
# 前端沒存過樣式時燒錄長相 = 原本的白字黑邊置底置中。
STYLE_DEFAULTS = {
    "anim": "none",
    "font": "Microsoft JhengHei",
    "bold": True,
    "italic": False,
    "underline": False,
    "size": 0.055,       # 字級,佔影片高度比例
    "spacing": 0.0,      # 字距,佔影片高度比例
    "color": "#FFFFFF",
    "alpha": 1.0,
    "box": False,
    "boxColor": "#080808",
    "boxAlpha": 0.88,
    "boxRadius": 6,      # 圓角只在預覽呈現,libass 不支援
    "boxPadX": 0,        # 底框額外寬/高,以 1080p 為基準的 px
    "boxPadY": 0,
    "outline": 4,        # 描邊粗細(1080p 基準 px);開底框時 ASS 無法同時描邊
    "shadow": True,
    "x": 0.5,            # 錨點位置(比例)
    "y": 0.90,
    "align": "center",
}


def _ass_color(hex_color: str, alpha: float) -> str:
    """#RRGGBB + 不透明度(1=不透明) → ASS 的 &HAABBGGRR。"""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    aa = max(0, min(255, round((1 - alpha) * 255)))
    return f"&H{aa:02X}{b}{g}{r}".upper()


def to_ass(segments: list[dict], width: int, height: int, style: dict | None = None) -> str:
    """燒錄用 ASS 字幕,吃編輯器的字幕樣式(位置用 \\pos 對齊預覽)。"""
    st = {**STYLE_DEFAULTS, **(style or {})}
    scale = height / 1080  # 1080p 基準 px → 實際解析度
    fs = max(round(float(st["size"]) * height), 8)
    spacing = round(float(st["spacing"]) * height, 1)
    primary = _ass_color(st["color"], float(st["alpha"]))
    if st["box"]:
        # BorderStyle=3:OutlineColour 就是底框顏色,Outline 是底框留邊
        border_style = 3
        outline_color = _ass_color(st["boxColor"], float(st["boxAlpha"]))
        base_pad = fs * 0.22
        pad_x = max(round(base_pad + float(st["boxPadX"]) * scale, 1), 0)
        pad_y = max(round(base_pad * 0.6 + float(st["boxPadY"]) * scale, 1), 0)
        outline = pad_y  # style 層先填一個,實際用 \xbord \ybord 分開控制
    else:
        border_style = 1
        outline_color = "&H00000000"
        outline = round(float(st["outline"]) * scale, 1)
        pad_x = pad_y = None
    shadow = round(2 * scale, 1) if st["shadow"] else 0
    margin_lr = max(round(width * 0.04), 16)
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
        f"{outline_color},&H80000000,{-1 if st['bold'] else 0},"
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
    events = [
        f"Dialogue: 0,{_ass_time(s['start'])},{_ass_time(s['end'])},Default,,0,0,0,,"
        f"{{{tags}}}{_ass_escape(s['text'])}"
        for s in segments
        if s["text"].strip()
    ]
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
