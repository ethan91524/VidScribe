import { useEffect, useState } from "react";

interface SafeZone {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface SafeFramePreset {
  key: string;
  label: string;
  ratio: number | null;
  margin?: number;
  zones: SafeZone[];
}

// 危險區數值是各平台常見的 UI 遮擋範圍(比例),要微調直接改這裡
export const SAFE_FRAMES: SafeFramePreset[] = [
  { key: "off", label: "關閉", ratio: null, zones: [] },
  {
    key: "yt169",
    label: "16:9 YouTube",
    ratio: 16 / 9,
    margin: 0.05,
    zones: [{ x: 0, y: 0.88, w: 1, h: 0.12, label: "播放器控制列" }],
  },
  {
    key: "vert916",
    label: "9:16 Shorts / Reels",
    ratio: 9 / 16,
    margin: 0.04,
    zones: [
      { x: 0, y: 0, w: 1, h: 0.08, label: "頂部 UI" },
      { x: 0.86, y: 0.3, w: 0.14, h: 0.45, label: "按鈕" },
      { x: 0, y: 0.78, w: 1, h: 0.22, label: "說明文字與底部 UI" },
    ],
  },
  { key: "std43", label: "4:3", ratio: 4 / 3, margin: 0.05, zones: [] },
  {
    key: "vert34",
    label: "3:4 直式貼文",
    ratio: 3 / 4,
    margin: 0.05,
    zones: [{ x: 0, y: 0.86, w: 1, h: 0.14, label: "底部 UI" }],
  },
];

/** 依影片長寬自動挑最接近的安全框(差 6% 內才算),不然回傳 off。 */
export function matchPresetByRatio(vw: number, vh: number): string {
  if (!vw || !vh) return "off";
  const a = vw / vh;
  let best = "off";
  let bestDiff = 0.06;
  for (const p of SAFE_FRAMES) {
    if (!p.ratio) continue;
    const diff = Math.abs(a - p.ratio) / p.ratio;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p.key;
    }
  }
  return best;
}

/** 疊在影片實際內容區上(自動扣掉上下/左右黑邊)。 */
export default function SafeFrame({
  videoRef,
  frameKey,
  layoutKey,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
  frameKey: string;
  /** 版面尺寸識別字串,改變時重新量測(不能只靠 ResizeObserver) */
  layoutKey?: string;
}) {
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const preset = SAFE_FRAMES.find((p) => p.key === frameKey);

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
      // 同 StyleOverlay:video 用 object-fit:contain 後會在容器內置中留邊,
      // 安全框絕對定位在容器上,必須加上 video 自身的位移才對得準。
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
  }, [videoRef, frameKey, layoutKey]);

  if (!preset || !preset.ratio || !rect) return null;
  return (
    <div className="safe-frame" style={rect}>
      {preset.margin && (
        <div className="safe-margin" style={{ inset: `${preset.margin * 100}%` }} />
      )}
      {preset.zones.map((z, i) => (
        <div
          key={i}
          className="safe-zone"
          style={{
            left: `${z.x * 100}%`,
            top: `${z.y * 100}%`,
            width: `${z.w * 100}%`,
            height: `${z.h * 100}%`,
          }}
        >
          {z.label}
        </div>
      ))}
    </div>
  );
}
