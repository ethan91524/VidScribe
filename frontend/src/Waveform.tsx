import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatTime, formatTimeMs } from "./segments";
import type { Segment } from "./types";

const RULER_H = 22;
const DEFAULT_STRIP_H = 150; // 沒有指定高度時的波形高度
const MIN_LEN = 0.05;

interface WaveformProps {
  peaks: { rate: number; peaks: number[] };
  duration: number;
  segments: Segment[];
  currentTime: number;
  activeIdx: number;
  selectedIdx: number;
  isPlaying: boolean;
  cuts: number[];
  marks: number[];
  cutsStatus: string;
  onDetectCuts: () => void;
  onAddMark: (t: number) => void;
  onRemoveMark: (t: number) => void;
  onSeek: (t: number) => void;
  onSelect: (idx: number) => void;
  onCommitTimes: (id: string, start: number, end: number) => void;
  onCreate: (start: number, end: number) => void;
  /** 波形區可用總高(含底部資訊列);拖曳分隔線時由 Editor 傳入 */
  height?: number;
}

interface DragState {
  type: "move" | "l" | "r";
  id: string;
  idx: number;
  origStart: number;
  origEnd: number;
  startX: number;
  moved: boolean;
  cur: { start: number; end: number };
}

function rulerStep(pps: number): number {
  if (pps >= 160) return 1;
  if (pps >= 70) return 2;
  if (pps >= 35) return 5;
  if (pps >= 18) return 10;
  if (pps >= 8) return 30;
  return 60;
}

export default function Waveform({
  peaks,
  duration,
  segments,
  currentTime,
  activeIdx,
  selectedIdx,
  isPlaying,
  cuts,
  marks,
  cutsStatus,
  onDetectCuts,
  onAddMark,
  onRemoveMark,
  onSeek,
  onSelect,
  onCommitTimes,
  onCreate,
  height,
}: WaveformProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pps, setPps] = useState(60);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewW, setViewW] = useState(800);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [createGhost, setCreateGhost] = useState<{ a: number; b: number } | null>(null);
  const createRef = useRef<{ t0: number; x0: number; active: boolean } | null>(null);
  const hoverRaf = useRef(0);

  const maxPeak = useMemo(() => {
    let m = 0;
    for (const v of peaks.peaks) if (v > m) m = v;
    return m || 1;
  }, [peaks]);

  // 觀察容器寬度
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrollLeft(el.scrollLeft);
  }, []);

  // 播放時讓播放頭保持在視野內
  useEffect(() => {
    if (!isPlaying) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = currentTime * pps;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + viewW - 80) {
      el.scrollLeft = Math.max(0, x - viewW * 0.3);
    }
  }, [currentTime, isPlaying, pps, viewW]);

  // 縮放時以視野中心為錨點
  const setZoom = useCallback(
    (next: number) => {
      const el = scrollRef.current;
      if (!el) {
        setPps(next);
        return;
      }
      const centerT = (el.scrollLeft + viewW / 2) / pps;
      setPps(next);
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, centerT * next - viewW / 2);
      });
    },
    [pps, viewW]
  );

  // 波形高度要跟著容器長,不然拖大分隔線只會多出一片空白。
  // 底部資訊列高度用量的,不寫死。
  const footerRef = useRef<HTMLDivElement>(null);
  const [stripH, setStripH] = useState(DEFAULT_STRIP_H);
  useEffect(() => {
    if (!height) {
      setStripH(DEFAULT_STRIP_H);
      return;
    }
    const fh = footerRef.current?.offsetHeight ?? 40;
    setStripH(Math.max(height - fh, 60));
  }, [height]);

  // ---- 畫波形與尺標 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = viewW;
    const h = stripH;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 尺標
    ctx.fillStyle = "#898f97";
    ctx.strokeStyle = "#e4e4de";
    ctx.font = "10.5px Cascadia Mono, Consolas, monospace";
    ctx.textBaseline = "top";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(w, RULER_H - 0.5);
    ctx.stroke();
    const step = rulerStep(pps);
    const t0 = Math.floor(scrollLeft / pps / step) * step;
    for (let t = t0; t * pps < scrollLeft + w; t += step) {
      const x = t * pps - scrollLeft;
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillText(formatTime(t).replace(/\.\d$/, ""), x + 4, 4);
    }

    // 波形(以播放位置分色)
    const waveH = h - RULER_H - 8;
    const midY = RULER_H + 4 + waveH / 2;
    const { rate, peaks: data } = peaks;
    const playedX = currentTime * pps - scrollLeft;
    for (let x = 0; x < w; x += 2) {
      const t = (scrollLeft + x) / pps;
      if (t > duration) break;
      const i0 = Math.floor(t * rate);
      const i1 = Math.max(i0 + 1, Math.floor(((scrollLeft + x + 2) / pps) * rate));
      let v = 0;
      for (let i = i0; i < i1 && i < data.length; i++) if (data[i] > v) v = data[i];
      const bh = Math.max((v / maxPeak) * waveH * 0.92, 1.5);
      ctx.fillStyle = x < playedX ? "#38d321" : "#cfcfc8";
      ctx.fillRect(x, midY - bh / 2, 1.4, bh);
    }

    // 切點(畫面剪接點):藍點+淡藍細線
    ctx.fillStyle = "#2563eb";
    for (const t of cuts) {
      const x = t * pps - scrollLeft;
      if (x < -4 || x > w + 4) continue;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x - 0.5, RULER_H, 1, h - RULER_H);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, RULER_H + 7, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [peaks, maxPeak, pps, scrollLeft, viewW, currentTime, duration, cuts, stripH]);

  // ---- 字幕方塊拖拉 ----

  const applyDrag = useCallback(
    (d: DragState, clientX: number): DragState => {
      const dt = (clientX - d.startX) / pps;
      let start = d.origStart;
      let end = d.origEnd;
      if (d.type === "move") {
        const len = d.origEnd - d.origStart;
        start = Math.min(Math.max(d.origStart + dt, 0), duration - len);
        end = start + len;
      } else if (d.type === "l") {
        start = Math.min(Math.max(d.origStart + dt, 0), d.origEnd - MIN_LEN);
      } else {
        end = Math.max(Math.min(d.origEnd + dt, duration), d.origStart + MIN_LEN);
      }
      // 磁吸:貼齊相鄰字幕邊緣、Mark 點、切點(8px 內取最近的)
      const snapT = 8 / pps;
      const prev = segments[d.idx - 1];
      const next = segments[d.idx + 1];
      const candidates: number[] = [...marks, ...cuts];
      if (prev) candidates.push(prev.end);
      if (next) candidates.push(next.start);
      const snapTo = (v: number): number | null => {
        let best: number | null = null;
        let bestDist = snapT;
        for (const c of candidates) {
          const dist = Math.abs(v - c);
          if (dist < bestDist) {
            bestDist = dist;
            best = c;
          }
        }
        return best;
      };
      if (d.type === "l") {
        const s = snapTo(start);
        if (s !== null) start = Math.min(s, end - MIN_LEN);
      } else if (d.type === "r") {
        const e2 = snapTo(end);
        if (e2 !== null) end = Math.max(e2, start + MIN_LEN);
      } else {
        const s = snapTo(start);
        const e2 = snapTo(end);
        const sd = s !== null ? Math.abs(start - s) : Infinity;
        const ed = e2 !== null ? Math.abs(end - e2) : Infinity;
        if (s !== null && sd <= ed) {
          end += s - start;
          start = s;
        } else if (e2 !== null) {
          start += e2 - end;
          end = e2;
        }
      }
      return {
        ...d,
        moved: d.moved || Math.abs(clientX - d.startX) > 3,
        cur: { start, end },
      };
    },
    [pps, duration, segments, cuts, marks]
  );

  const onBlockPointerDown = useCallback(
    (e: React.PointerEvent, seg: Segment, idx: number, type: DragState["type"]) => {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const d: DragState = {
        type,
        id: seg.id,
        idx,
        origStart: seg.start,
        origEnd: seg.end,
        startX: e.clientX,
        moved: false,
        cur: { start: seg.start, end: seg.end },
      };
      dragRef.current = d;
      setDrag(d);
    },
    []
  );

  const onBlockPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = applyDrag(d, e.clientX);
      dragRef.current = next;
      setDrag(next);
    },
    [applyDrag]
  );

  const onBlockPointerUp = useCallback(
    (e: React.PointerEvent, seg: Segment, idx: number) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      if (d.moved) {
        onCommitTimes(d.id, d.cur.start, d.cur.end);
      } else {
        onSelect(idx);
        onSeek(seg.start);
      }
      e.stopPropagation();
    },
    [onCommitTimes, onSelect, onSeek]
  );

  // ---- 空白區:點=跳播、拖=新增、hover=跟播 ----

  const timeAt = useCallback(
    (clientX: number): number => {
      const inner = innerRef.current;
      if (!inner) return 0;
      const rect = inner.getBoundingClientRect();
      return Math.min(Math.max((clientX - rect.left) / pps, 0), duration);
    },
    [pps, duration]
  );

  const onInnerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      createRef.current = { t0: timeAt(e.clientX), x0: e.clientX, active: false };
    },
    [timeAt]
  );

  const onInnerPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const c = createRef.current;
      if (c) {
        if (!c.active && Math.abs(e.clientX - c.x0) > 5) c.active = true;
        if (c.active) {
          setCreateGhost({ a: c.t0, b: timeAt(e.clientX) });
          return;
        }
      }
      // hover 跟播:暫停時滑鼠掃過波形,影片跟著移動
      if (!isPlaying && !dragRef.current && !c) {
        const t = timeAt(e.clientX);
        cancelAnimationFrame(hoverRaf.current);
        hoverRaf.current = requestAnimationFrame(() => onSeek(t));
      }
    },
    [timeAt, isPlaying, onSeek]
  );

  const onInnerPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const c = createRef.current;
      createRef.current = null;
      setCreateGhost(null);
      if (!c) return;
      if (c.active) {
        const t1 = timeAt(e.clientX);
        const a = Math.min(c.t0, t1);
        const b = Math.max(c.t0, t1);
        if (b - a >= 0.2) onCreate(a, b);
      } else {
        onSeek(timeAt(e.clientX));
      }
    },
    [timeAt, onCreate, onSeek]
  );

  // 雙擊波形任一處新增 Mark 點(雙擊 Mark 點本身則是移除,在該元素上 stopPropagation)。
  // 這裡不能限定 e.target 必須是 canvas:字幕卡是絕對定位疊在 canvas 上的,
  // 波形排滿字幕時幾乎點不到 canvas,會讓人以為沒有這個功能。
  const onInnerDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      onAddMark(Math.round(timeAt(e.clientX) * 1000) / 1000);
    },
    [timeAt, onAddMark]
  );

  const innerW = Math.max(duration * pps, viewW);
  const sel =
    selectedIdx >= 0 && selectedIdx < segments.length
      ? segments[selectedIdx]
      : activeIdx >= 0 && activeIdx < segments.length
        ? segments[activeIdx]
        : null;

  return (
    <div className="wave-strip">
      <div
        className="wave-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        <div
          className="wave-inner"
          ref={innerRef}
          style={{ width: innerW, height: stripH }}
          onPointerDown={onInnerPointerDown}
          onPointerMove={onInnerPointerMove}
          onPointerUp={onInnerPointerUp}
          onDoubleClick={onInnerDoubleClick}
        >
          <canvas className="wave-canvas" ref={canvasRef} />
          {marks.map((t) => (
            <div
              key={t}
              className="wave-mark"
              style={{ left: t * pps }}
              title="雙擊移除這個 Mark 點"
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onRemoveMark(t);
              }}
            >
              <span className="wave-mark-dot" />
            </div>
          ))}
          {segments.map((seg, idx) => {
            const times =
              drag && drag.id === seg.id ? drag.cur : { start: seg.start, end: seg.end };
            const cls =
              "wave-block" +
              (idx === activeIdx ? " active" : "") +
              (idx === selectedIdx ? " selected" : "");
            return (
              <div
                key={seg.id}
                className={cls}
                style={{
                  left: times.start * pps,
                  width: Math.max((times.end - times.start) * pps, 6),
                }}
                onPointerDown={(e) => onBlockPointerDown(e, seg, idx, "move")}
                onPointerMove={onBlockPointerMove}
                onPointerUp={(e) => onBlockPointerUp(e, seg, idx)}
              >
                <span className="wave-block-label">{seg.text || "(空白)"}</span>
                <span
                  className="wave-edge l"
                  onPointerDown={(e) => onBlockPointerDown(e, seg, idx, "l")}
                  onPointerMove={onBlockPointerMove}
                  onPointerUp={(e) => onBlockPointerUp(e, seg, idx)}
                />
                <span
                  className="wave-edge r"
                  onPointerDown={(e) => onBlockPointerDown(e, seg, idx, "r")}
                  onPointerMove={onBlockPointerMove}
                  onPointerUp={(e) => onBlockPointerUp(e, seg, idx)}
                />
              </div>
            );
          })}
          {createGhost && (
            <div
              className="wave-ghost"
              style={{
                left: Math.min(createGhost.a, createGhost.b) * pps,
                width: Math.abs(createGhost.b - createGhost.a) * pps,
              }}
            />
          )}
          <div className="wave-playhead" style={{ left: currentTime * pps }} />
        </div>
      </div>
      <div className="wave-footer" ref={footerRef}>
        <span className="wave-seg-info">
          {sel ? (
            <>
              這句&nbsp;&nbsp;開始 <b className="mono">{formatTimeMs(sel.start)}</b>
              &nbsp;&nbsp;結束 <b className="mono">{formatTimeMs(sel.end)}</b>
              &nbsp;&nbsp;<b className="mono">{(sel.end - sel.start).toFixed(3)}</b> 秒
            </>
          ) : (
            "點字幕方塊或列表可選取句子"
          )}
        </span>
        <button
          className="btn small"
          onClick={onDetectCuts}
          disabled={cutsStatus === "running"}
          title="掃描影片畫面的剪接點,拖字幕邊緣會磁吸過去"
        >
          {cutsStatus === "running"
            ? "偵測切點中…"
            : cuts.length
              ? `切點 ${cuts.length}`
              : "切點偵測"}
        </button>
        <span className="toolbar-spacer" />
        <span className="wave-zoom-label">縮放</span>
        <input
          type="range"
          min={8}
          max={300}
          value={pps}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label="波形縮放"
        />
        <span className="wave-zoom-pct mono">{Math.round((pps / 300) * 100)}%</span>
      </div>
    </div>
  );
}
