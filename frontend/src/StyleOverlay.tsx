import { useEffect, useRef, useState } from "react";
import type { SubStyle } from "./types";

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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
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
export function useVideoContentRect(videoRef: React.RefObject<HTMLVideoElement>) {
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
      let left = 0;
      let top = 0;
      if (A > a) {
        w = H * a;
        left = (W - w) / 2;
      } else {
        h = W / a;
        top = (H - h) / 2;
      }
      setRect({ left, top, width: w, height: h });
      setVideoW(vw);
      setVideoH(vh);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(v);
    v.addEventListener("loadedmetadata", update);
    return () => {
      ro.disconnect();
      v.removeEventListener("loadedmetadata", update);
    };
  }, [videoRef]);

  return { rect, videoW, videoH };
}

interface SubtitleOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  style: SubStyle;
  text: string;
  open: boolean;
  onOpen: () => void;
  onChange: (patch: Partial<SubStyle>) => void;
}

/** 疊在影片內容區上的字幕預覽,可直接拖曳改位置/大小,點一下開設定面板。 */
export function SubtitleOverlay({ videoRef, style, text, open, onOpen, onChange }: SubtitleOverlayProps) {
  const { rect, videoW, videoH } = useVideoContentRect(videoRef);

  if (!rect) return null;
  const displayText = text || (open ? "字幕樣式預覽" : "");
  if (!displayText) return null;

  const vh = videoH || 1080;
  const k = rect.height / vh; // 來源解析度 px → 預覽 px
  const s1080 = vh / 1080;
  const fs = style.size * vh; // 來源解析度字級(對齊後端燒錄用的基準)

  const fontSize = style.size * rect.height;
  const letterSpacing = style.spacing * rect.height;
  const color = hexToRgba(style.color, style.alpha);

  let background = "transparent";
  let borderRadius = 0;
  let padLR = 0;
  let padTB = 0;
  let webkitStroke: string | undefined;
  let textShadow: string | undefined;
  let boxShadow: string | undefined;
  const shadowOffset = 2 * s1080 * k;

  if (style.box) {
    background = hexToRgba(style.boxColor, style.boxAlpha);
    borderRadius = style.boxRadius * s1080 * k;
    padLR = Math.max(fs * 0.22 + style.boxPadX * s1080, 0) * k;
    padTB = Math.max(fs * 0.132 + style.boxPadY * s1080, 0) * k;
    if (style.shadow) {
      boxShadow = `${shadowOffset}px ${shadowOffset}px ${shadowOffset * 2}px rgba(0,0,0,.5)`;
    }
  } else {
    if (style.outline > 0) {
      webkitStroke = `${style.outline * s1080 * k}px black`;
    }
    if (style.shadow) {
      textShadow = `0 0 ${shadowOffset * 2}px rgba(0,0,0,.6), ${shadowOffset}px ${shadowOffset}px ${shadowOffset}px rgba(0,0,0,.55)`;
    }
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
          maxWidth: "92%",
          whiteSpace: "pre-wrap",
          textAlign: style.align,
          fontFamily: cssFontStack(style.font),
          fontSize,
          letterSpacing,
          color,
          fontWeight: style.bold ? 700 : 400,
          fontStyle: style.italic ? "italic" : "normal",
          textDecoration: style.underline ? "underline" : "none",
          background,
          borderRadius,
          padding: `${padTB}px ${padLR}px`,
          WebkitTextStroke: webkitStroke,
          paintOrder: webkitStroke ? "stroke" : undefined,
          textShadow,
          boxShadow,
        }}
        onPointerDown={(e) => beginDrag(e, "move")}
      >
        {displayText}
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

/** 浮動樣式面板,對應 SubtitleOverlay 的所有可調欄位。 */
export function StylePanel({ style, videoW, videoH, onChange, onReset, onClose }: StylePanelProps) {
  const vw = videoW || 1920;
  const vh = videoH || 1080;
  return (
    <div className="style-panel" role="dialog" aria-label="字幕樣式">
      <div className="style-panel-head">
        <div>
          <div className="style-panel-title">字幕樣式</div>
          <div className="style-panel-sub">位置與大小也可以直接在影片上拖曳。</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="關閉">
          ✕
        </button>
      </div>

      <div className="style-field">
        <label>動畫樣式</label>
        <select
          className="select"
          value={style.anim}
          onChange={(e) => onChange({ anim: e.target.value as SubStyle["anim"] })}
        >
          <option value="none">無</option>
          <option value="fade">淡入</option>
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
          value={style.bold ? "bold" : "normal"}
          onChange={(e) => onChange({ bold: e.target.value === "bold" })}
        >
          <option value="normal">標準</option>
          <option value="bold">粗體</option>
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
            max={40}
            step={1}
            value={style.boxRadius}
            onChange={(v) => onChange({ boxRadius: v })}
            display={style.boxRadius.toFixed(0)}
          />
          <RangeRow
            label="寬度"
            min={-30}
            max={60}
            step={1}
            value={style.boxPadX}
            onChange={(v) => onChange({ boxPadX: v })}
            display={style.boxPadX.toFixed(0)}
          />
          <RangeRow
            label="高度"
            min={-30}
            max={60}
            step={1}
            value={style.boxPadY}
            onChange={(v) => onChange({ boxPadY: v })}
            display={style.boxPadY.toFixed(0)}
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
        max={12}
        step={0.5}
        value={style.outline}
        onChange={(v) => onChange({ outline: v })}
        display={style.outline.toFixed(1)}
        disabled={style.box}
        title={style.box ? "開啟底框時無法同時描邊" : undefined}
      />

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

      <button className="btn small style-reset" onClick={onReset}>
        ↺ 還原
      </button>
    </div>
  );
}
