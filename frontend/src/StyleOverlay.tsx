import { useEffect, useRef, useState } from "react";
import type { SubStyle, Word } from "./types";

/** 字型下拉選項:label 給人看,ass 存進 style.font(燒錄用),css 是預覽用的字型堆疊。 */
export const FONT_OPTIONS: { label: string; ass: string; css: string }[] = [
  { label: "微軟正黑體", ass: "Microsoft JhengHei", css: '"Microsoft JhengHei", "Segoe UI", sans-serif' },
  { label: "思源黑體", ass: "Noto Sans TC", css: '"Noto Sans TC", "Microsoft JhengHei", sans-serif' },
  { label: "標楷體", ass: "DFKai-SB", css: '"DFKai-SB", "BiauKai", serif' },
  { label: "新細明體", ass: "PMingLiU", css: 'PMingLiU, serif' },
  { label: "Arial", ass: "Arial", css: 'Arial, "Segoe UI", sans-serif' },
];

function cssFontStack(ass: string): string {
  return FONT_OPTIONS.find((f) => f.ass === ass)?.css ?? '"Microsoft JhengHei", sans-serif';
}

function fontLabel(ass: string): string {
  return FONT_OPTIONS.find((f) => f.ass === ass)?.label ?? ass;
}

/**
 * 逐字高亮渲染:依 words 的 [start,end) 定位目前字,包成單獨 span 上色。
 * 定位失敗(文字被改過對不上)就退回整句一般渲染。
 */
function renderHighlightedText(
  text: string,
  words: Word[],
  currentTime: number,
  normalColor: string,
  highlightColor: string
): React.ReactNode {
  let searchFrom = 0;
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < words.length; i++) {
    const token = words[i].word.trim();
    if (!token) continue;
    const idx = text.indexOf(token, searchFrom);
    if (idx < 0) return text;
    if (idx > searchFrom) nodes.push(text.slice(searchFrom, idx));
    const active = currentTime >= words[i].start && currentTime < words[i].end;
    nodes.push(
      <span key={i} style={{ color: active ? highlightColor : normalColor }}>
        {text.slice(idx, idx + token.length)}
      </span>
    );
    searchFrom = idx + token.length;
  }
  nodes.push(text.slice(searchFrom));
  return nodes;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** 面板顯示句子文字用,截斷過長內容並加省略號。 */
function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** #RRGGBB + 不透明度(0~1) → rgba() 字串,格式不對就退回白色。 */
function hexToRgba(hex: string, alpha: number): string {
  let h = (hex || "").trim().replace("#", "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) h = "ffffff";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

/**
 * 影片實際內容區(扣掉黑邊)的座標,數學與 SafeFrame.tsx 相同。
 * 另外回傳來源解析度(videoWidth/videoHeight),樣式換算要用。
 */
export function useVideoContentRect(
  videoRef: React.RefObject<HTMLVideoElement>,
  /** 版面尺寸的識別字串;改變就強制重新量測。ResizeObserver 在頁面沒有
   *  進行渲染步驟時不會觸發,而且只有位移、沒有尺寸變化時也不會觸發,
   *  所以不能只靠它。 */
  layoutKey?: string
) {
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [videoW, setVideoW] = useState(0);
  const [videoH, setVideoH] = useState(0);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const update = () => {
      const W = v.clientWidth;
      const H = v.clientHeight;
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      if (!W || !H || !vw || !vh) {
        setRect(null);
        return;
      }
      const a = vw / vh;
      const A = W / H;
      let w = W;
      let h = H;
      // 疊層是絕對定位在 .video-wrap 上,而 video 元素用 object-fit:contain 填滿容器後
      // 本身可能置中留邊、與容器原點不重合,所以要把 video 在容器內的位移一起算進來,
      // 否則拖曳版面改變影片大小時字幕會整個偏掉。
      let left = v.offsetLeft;
      let top = v.offsetTop;
      if (A > a) {
        w = H * a;
        left += (W - w) / 2;
      } else {
        h = W / a;
        top += (H - h) / 2;
      }
      setRect({ left, top, width: w, height: h });
      setVideoW(vw);
      setVideoH(vh);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(v);
    if (v.parentElement) ro.observe(v.parentElement);
    v.addEventListener("loadedmetadata", update);
    return () => {
      ro.disconnect();
      v.removeEventListener("loadedmetadata", update);
    };
  }, [videoRef, layoutKey]);

  return { rect, videoW, videoH };
}

interface SubtitleOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  style: SubStyle;
  text: string;
  words?: Word[];
  currentTime: number;
  open: boolean;
  onOpen: () => void;
  onChange: (patch: Partial<SubStyle>) => void;
  /** 版面尺寸識別字串,改變時重新量測影片內容區 */
  layoutKey?: string;
}

/** 疊在影片內容區上的字幕預覽,可直接拖曳改位置/大小,點一下開設定面板。 */
export function SubtitleOverlay({
  videoRef,
  style,
  text,
  words,
  currentTime,
  open,
  onOpen,
  onChange,
  layoutKey,
}: SubtitleOverlayProps) {
  const { rect, videoW, videoH } = useVideoContentRect(videoRef, layoutKey);

  if (!rect) return null;
  const displayText = text || (open ? "字幕樣式預覽" : "");
  if (!displayText) return null;

  const vh = videoH || 1080;
  const k = rect.height / vh; // 來源解析度 px → 預覽 px
  const s1080 = vh / 1080;

  const fontSize = style.size * rect.height;
  const letterSpacing = style.spacing * rect.height;
  const color = hexToRgba(style.color, style.alpha);
  const highlightColor = hexToRgba(style.highlightColor, style.alpha);

  const content =
    style.highlight && text && words && words.length > 0
      ? renderHighlightedText(text, words, currentTime, color, highlightColor)
      : displayText;

  let background = "transparent";
  let borderRadius = 0;
  let padLR = 0;
  let padTB = 0;
  let webkitStroke: string | undefined;
  let textShadow: string | undefined;
  const shadowOffset = 2 * s1080 * k;

  if (style.box) {
    background = hexToRgba(style.boxColor, style.boxAlpha);
    borderRadius = style.boxRadius * rect.height;
    padLR = Math.max(style.padX * rect.height, 0);
    padTB = Math.max(style.padY * rect.height, 0);
  } else if (style.outline > 0) {
    webkitStroke = `${style.outline * rect.height}px ${style.outlineColor}`;
  }
  // 陰影一律套在文字上(不論有沒有底框),不再有 boxShadow。
  if (style.shadow) {
    textShadow = `0 0 ${shadowOffset * 2}px rgba(0,0,0,.6), ${shadowOffset}px ${shadowOffset}px ${shadowOffset}px rgba(0,0,0,.55)`;
  }

  let transform = "translate(-50%, -50%)";
  if (style.align === "left") transform = "translate(0, -50%)";
  else if (style.align === "right") transform = "translate(-100%, -50%)";

  const beginDrag = (e: React.PointerEvent, mode: "move" | "resize") => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startX0 = style.x;
    const startY0 = style.y;
    const startSize = style.size;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      if (!rect.width || !rect.height) return;
      if (mode === "move") {
        onChange({
          x: clamp(startX0 + dx / rect.width, 0.02, 0.98),
          y: clamp(startY0 + dy / rect.height, 0.02, 0.98),
        });
      } else {
        onChange({ size: clamp(startSize + dy / rect.height, 0.02, 0.2) });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (mode === "move" && !moved) onOpen();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="subtitle-overlay-wrap"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      <div
        key={style.anim === "fade" ? text : undefined}
        className={"subtitle-box" + (open ? " open" : "") + (style.anim === "fade" ? " fade-in" : "")}
        style={{
          left: `${style.x * 100}%`,
          top: `${style.y * 100}%`,
          transform,
          // 絕對定位只給 left 時,寬度是 shrink-to-fit,可用寬度只剩「容器寬 - left」,
          // 字幕擺中間就只拿得到一半畫面寬而提早換行。明確指定 width 可跳過這個
          // 規則,再用 px 版 max-width(對整個內容區,而非剩餘空間)控制換行寬度。
          width: "max-content",
          maxWidth: `${Math.round(style.maxWidth * rect.width)}px`,
          whiteSpace: "pre-wrap",
          textAlign: style.align,
          fontFamily: cssFontStack(style.font),
          fontSize,
          lineHeight: style.lineHeight,
          letterSpacing,
          color,
          fontWeight: style.weight,
          fontStyle: style.italic ? "italic" : "normal",
          textDecoration: style.underline ? "underline" : "none",
          background,
          borderRadius,
          padding: `${padTB}px ${padLR}px`,
          WebkitTextStroke: webkitStroke,
          paintOrder: webkitStroke ? "stroke" : undefined,
          textShadow,
        }}
        onPointerDown={(e) => beginDrag(e, "move")}
      >
        <span
          key={style.anim === "pop" ? text : undefined}
          className={style.anim === "pop" ? "subtitle-pop-inner" : undefined}
          style={{ display: "inline-block" }}
        >
          {content}
        </span>
        {open && (
          <>
            <div
              className="style-handle"
              title="拖曳調整字級"
              onPointerDown={(e) => beginDrag(e, "resize")}
            />
            <div className="style-chip">
              {fontLabel(style.font)} ▾ {(style.size * 100).toFixed(1)}%
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface StylePanelProps {
  style: SubStyle;
  videoW: number;
  videoH: number;
  onChange: (patch: Partial<SubStyle>) => void;
  onReset: () => void;
  onClose: () => void;
  /** "all"=改全域樣式(現行行為);"one"=只改目前選取那句的覆寫 */
  scope: "all" | "one";
  onScopeChange: (scope: "all" | "one") => void;
  /** scope="one" 時目前選取的句子(-1/null 代表沒選) */
  selectedIndex: number;
  selectedText: string | null;
  /** 該句是否已有樣式覆寫,決定要不要顯示「清除這句樣式」 */
  hasOverride: boolean;
  onClearOverride: () => void;
}

function RangeRow({
  label,
  min,
  max,
  step,
  value,
  onChange,
  display,
  indent,
  disabled,
  title,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  display: string;
  indent?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className={"style-range-row" + (indent ? " style-indent-row" : "")} title={title}>
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="style-value mono">{display}</span>
    </div>
  );
}

/** 浮動樣式面板,對應 SubtitleOverlay 的所有可調欄位。
 *  scope="all" 時行為與過去完全一致(改全域樣式);scope="one" 時面板顯示/套用
 *  的是「全域疊上該句覆寫」的值,使用者的改動只會寫進該句的覆寫。 */
export function StylePanel({
  style,
  videoW,
  videoH,
  onChange,
  onReset,
  onClose,
  scope,
  onScopeChange,
  selectedIndex,
  selectedText,
  hasOverride,
  onClearOverride,
}: StylePanelProps) {
  const vw = videoW || 1920;
  const vh = videoH || 1080;
  // scope="one" 但沒有選取句子:整組控制項鎖住,提示先點一句字幕
  const locked = scope === "one" && selectedText === null;
  // 左右內距/上下內距的鎖定連動:純 UI 狀態,不存進 SubStyle
  const [padLocked, setPadLocked] = useState(false);
  const handlePadXChange = (v: number) => {
    if (!padLocked) {
      onChange({ padX: v });
      return;
    }
    // 依目前兩者的比例同步變化;基準值是 0 時比例無意義,改成等值變化
    if (style.padX > 0) {
      onChange({ padX: v, padY: clamp((style.padY * v) / style.padX, 0, 0.08) });
    } else {
      onChange({ padX: v, padY: clamp(v, 0, 0.08) });
    }
  };
  const handlePadYChange = (v: number) => {
    if (!padLocked) {
      onChange({ padY: v });
      return;
    }
    if (style.padY > 0) {
      onChange({ padY: v, padX: clamp((style.padX * v) / style.padY, 0, 0.12) });
    } else {
      onChange({ padY: v, padX: clamp(v, 0, 0.12) });
    }
  };
  return (
    <div className="style-panel" role="dialog" aria-label="字幕樣式">
      <div className="style-scope-toggle">
        <button
          type="button"
          className={"btn small" + (scope === "all" ? " active" : "")}
          onClick={() => onScopeChange("all")}
        >
          全部字幕
        </button>
        <button
          type="button"
          className={"btn small" + (scope === "one" ? " active" : "")}
          onClick={() => onScopeChange("one")}
        >
          這一句
        </button>
      </div>

      <div className="style-panel-head">
        <div>
          <div className="style-panel-title">字幕樣式</div>
          <div className="style-panel-sub">
            {scope === "all"
              ? "位置與大小也可以直接在影片上拖曳。"
              : selectedText !== null
                ? `第 ${selectedIndex + 1} 句:${truncateText(selectedText, 14)}`
                : "先點一句字幕"}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="關閉">
          ✕
        </button>
      </div>

      <fieldset className="style-fieldset" disabled={locked}>
      <div className="style-field">
        <label>動畫樣式</label>
        <select
          className="select"
          value={style.anim}
          onChange={(e) => onChange({ anim: e.target.value as SubStyle["anim"] })}
        >
          <option value="none">無</option>
          <option value="fade">淡入</option>
          <option value="pop">彈出</option>
        </select>
      </div>

      <div className="style-field">
        <label>字型</label>
        <select className="select" value={style.font} onChange={(e) => onChange({ font: e.target.value })}>
          {FONT_OPTIONS.map((f) => (
            <option key={f.ass} value={f.ass}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={String(style.weight)}
          onChange={(e) => onChange({ weight: parseInt(e.target.value, 10) })}
        >
          <option value="400">標準</option>
          <option value="700">粗體</option>
          <option value="800">特粗</option>
          <option value="900">最粗</option>
        </select>
      </div>

      <RangeRow
        label="字級"
        min={0.02}
        max={0.2}
        step={0.001}
        value={style.size}
        onChange={(v) => onChange({ size: v })}
        display={(style.size * vh).toFixed(1)}
      />
      <RangeRow
        label="字距"
        min={0}
        max={0.05}
        step={0.001}
        value={style.spacing}
        onChange={(v) => onChange({ spacing: v })}
        display={(style.spacing * vh).toFixed(1)}
      />
      <RangeRow
        label="行高"
        min={1}
        max={2}
        step={0.05}
        value={style.lineHeight}
        onChange={(v) => onChange({ lineHeight: v })}
        display={style.lineHeight.toFixed(2)}
      />
      <RangeRow
        label="最大寬度"
        min={0.3}
        max={0.96}
        step={0.01}
        value={style.maxWidth}
        onChange={(v) => onChange({ maxWidth: v })}
        display={`${Math.round(style.maxWidth * 100)}%`}
      />

      <div className="style-field">
        <label>字色</label>
        <input type="color" value={style.color} onChange={(e) => onChange({ color: e.target.value })} />
        <input
          className="style-hex mono"
          value={style.color}
          onChange={(e) => onChange({ color: e.target.value })}
        />
      </div>
      <RangeRow
        indent
        label="透明度"
        min={0}
        max={1}
        step={0.01}
        value={style.alpha}
        onChange={(v) => onChange({ alpha: v })}
        display={`${Math.round(style.alpha * 100)}%`}
      />

      <label className="style-checkbox">
        <input type="checkbox" checked={style.box} onChange={(e) => onChange({ box: e.target.checked })} />
        底框
      </label>
      {style.box && (
        <div className="style-indent">
          <div className="style-field">
            <label>底色</label>
            <input
              type="color"
              value={style.boxColor}
              onChange={(e) => onChange({ boxColor: e.target.value })}
            />
            <input
              className="style-hex mono"
              value={style.boxColor}
              onChange={(e) => onChange({ boxColor: e.target.value })}
            />
          </div>
          <RangeRow
            label="透明度"
            min={0}
            max={1}
            step={0.01}
            value={style.boxAlpha}
            onChange={(v) => onChange({ boxAlpha: v })}
            display={`${Math.round(style.boxAlpha * 100)}%`}
          />
          <RangeRow
            label="圓角"
            min={0}
            max={0.06}
            step={0.001}
            value={style.boxRadius}
            onChange={(v) => onChange({ boxRadius: v })}
            display={`${(style.boxRadius * vh).toFixed(0)}px`}
          />
          <RangeRow
            label="左右內距"
            min={0}
            max={0.12}
            step={0.001}
            value={style.padX}
            onChange={handlePadXChange}
            display={`${(style.padX * vh).toFixed(0)}px`}
          />
          <label className="style-checkbox pad-lock-checkbox" title="鎖定:拖曳任一滑桿,依目前比例同步變化另一個">
            <input
              type="checkbox"
              checked={padLocked}
              onChange={(e) => setPadLocked(e.target.checked)}
            />
            🔒 內距連動
          </label>
          <RangeRow
            label="上下內距"
            min={0}
            max={0.08}
            step={0.001}
            value={style.padY}
            onChange={handlePadYChange}
            display={`${(style.padY * vh).toFixed(0)}px`}
          />
          <p className="style-hint">圓角只影響預覽,燒錄成品為直角</p>
        </div>
      )}

      <label className="style-checkbox">
        <input type="checkbox" checked={style.shadow} onChange={(e) => onChange({ shadow: e.target.checked })} />
        陰影
      </label>

      <RangeRow
        label="描邊"
        min={0}
        max={0.012}
        step={0.0005}
        value={style.outline}
        onChange={(v) => onChange({ outline: v })}
        display={`${(style.outline * vh).toFixed(1)}px`}
        disabled={style.box}
        title={style.box ? "開啟底框時無法同時描邊" : undefined}
      />
      <div className="style-indent">
        <div className="style-field">
          <label>描邊顏色</label>
          <input
            type="color"
            value={style.outlineColor}
            onChange={(e) => onChange({ outlineColor: e.target.value })}
          />
          <input
            className="style-hex mono"
            value={style.outlineColor}
            onChange={(e) => onChange({ outlineColor: e.target.value })}
          />
        </div>
      </div>

      <RangeRow
        label="水平"
        min={0}
        max={1}
        step={0.001}
        value={style.x}
        onChange={(v) => onChange({ x: v })}
        display={(style.x * vw).toFixed(1)}
      />
      <RangeRow
        label="垂直"
        min={0}
        max={1}
        step={0.001}
        value={style.y}
        onChange={(v) => onChange({ y: v })}
        display={(style.y * vh).toFixed(1)}
      />

      <div className="style-field">
        <label>對齊</label>
        <select
          className="select"
          value={style.align}
          onChange={(e) => onChange({ align: e.target.value as SubStyle["align"] })}
        >
          <option value="center">置中</option>
          <option value="left">靠左</option>
          <option value="right">靠右</option>
        </select>
      </div>

      <label className="style-checkbox">
        <input type="checkbox" checked={style.italic} onChange={(e) => onChange({ italic: e.target.checked })} />
        斜體
      </label>
      <label className="style-checkbox">
        <input
          type="checkbox"
          checked={style.underline}
          onChange={(e) => onChange({ underline: e.target.checked })}
        />
        底線
      </label>

      <label className="style-checkbox">
        <input
          type="checkbox"
          checked={style.highlight}
          onChange={(e) => onChange({ highlight: e.target.checked })}
        />
        逐字高亮
      </label>
      {style.highlight && (
        <div className="style-indent">
          <div className="style-field">
            <label>高亮色</label>
            <input
              type="color"
              value={style.highlightColor}
              onChange={(e) => onChange({ highlightColor: e.target.value })}
            />
            <input
              className="style-hex mono"
              value={style.highlightColor}
              onChange={(e) => onChange({ highlightColor: e.target.value })}
            />
          </div>
        </div>
      )}
      </fieldset>

      {scope === "all" ? (
        <button className="btn small style-reset" onClick={onReset}>
          ↺ 還原
        </button>
      ) : (
        hasOverride && (
          <button className="btn small style-reset" onClick={onClearOverride}>
            清除這句樣式
          </button>
        )
      )}
    </div>
  );
}
