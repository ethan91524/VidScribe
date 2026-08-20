export interface Word {
  start: number;
  end: number;
  word: string;
  /** 辨識信心(0~1)。舊專案沒有這個欄位,缺值就不顯示。 */
  p?: number;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
  words?: Word[];
  /** 整句辨識信心(0~1)。舊專案沒有這個欄位,缺值就不顯示。 */
  conf?: number;
  /** 單句樣式覆寫,只存有改動的欄位;沒設的欄位跟著全域 SubStyle 走(見 effectiveStyle)。 */
  style?: Partial<SubStyle>;
}

export interface Project {
  id: string;
  name: string;
  created_at: number;
  media_file: string;
  status:
    | "uploaded"
    | "extracting"
    | "loading_model"
    | "transcribing"
    | "converting"
    | "done"
    | "error"
    | "interrupted";
  progress: number;
  error: string | null;
  duration: number | null;
  language: string | null;
  has_video: boolean | null;
  model: string;
  device: string | null;
}

export type SubAlign = "left" | "center" | "right";
export type SubAnim = "none" | "fade" | "pop";

/** 字幕樣式,鍵名/預設值需與 backend/exporter.py 的 STYLE_DEFAULTS 完全一致。 */
export interface SubStyle {
  anim: SubAnim;
  font: string;
  weight: number; // 400/700/800/900,取代原本的 bold 布林
  italic: boolean;
  underline: boolean;
  size: number;
  lineHeight: number;
  spacing: number;
  color: string;
  alpha: number;
  box: boolean;
  boxColor: string;
  boxAlpha: number;
  boxRadius: number; // 佔影片高度比例
  padX: number; // 佔影片高度比例,取代原本的 boxPadX(px)
  padY: number; // 佔影片高度比例,取代原本的 boxPadY(px)
  maxWidth: number; // 佔影片寬度比例
  outline: number;
  outlineColor: string;
  shadow: boolean;
  x: number;
  y: number;
  align: SubAlign;
  highlight: boolean; // 逐字高亮開關
  highlightColor: string;
}

export const DEFAULT_STYLE: SubStyle = {
  anim: "none",
  font: "Microsoft JhengHei",
  weight: 800,
  italic: false,
  underline: false,
  size: 0.0909,
  lineHeight: 1.25,
  spacing: 0.0,
  color: "#FFFFFF",
  alpha: 1.0,
  box: true,
  boxColor: "#111111",
  boxAlpha: 0.78,
  boxRadius: 0.0214,
  padX: 0.0374,
  padY: 0.0187,
  maxWidth: 0.86,
  outline: 0,
  outlineColor: "#000000",
  shadow: false,
  x: 0.5,
  y: 0.84,
  align: "center",
  highlight: false,
  highlightColor: "#C9FF38",
};

/** 各數值欄位的合法範圍,與面板滑桿一致。載入時一律夾住,
 *  避免舊存檔或手改的 JSON 讓字幕爆成整片畫面。 */
const STYLE_RANGE: Record<string, [number, number]> = {
  weight: [400, 900],
  size: [0.02, 0.2],
  lineHeight: [1, 2],
  spacing: [0, 0.05],
  alpha: [0, 1],
  boxAlpha: [0, 1],
  boxRadius: [0, 0.06],
  padX: [0, 0.12],
  padY: [0, 0.08],
  maxWidth: [0.3, 0.96],
  outline: [0, 0.012],
  x: [0.02, 0.98],
  y: [0.02, 0.98],
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** 依 STYLE_RANGE 夾住所有數值欄位、把 weight 正規化成合法四值之一。
 *  migrateStyle(舊存檔)與 effectiveStyle(全域疊單句覆寫)共用同一份範圍表,
 *  避免兩處各存一份容易漏改不同步。 */
function clampStyleRanges(s: SubStyle): SubStyle {
  const out: SubStyle = { ...s };
  for (const [key, [lo, hi]] of Object.entries(STYLE_RANGE)) {
    const v = (out as unknown as Record<string, unknown>)[key];
    (out as unknown as Record<string, number>)[key] =
      typeof v === "number" && Number.isFinite(v)
        ? clamp(v, lo, hi)
        : (DEFAULT_STYLE[key as keyof SubStyle] as number);
  }
  if (![400, 700, 800, 900].includes(out.weight)) {
    out.weight = out.weight >= 850 ? 900 : out.weight >= 750 ? 800 : out.weight >= 550 ? 700 : 400;
  }
  return out;
}

/** 全域樣式疊上單句覆寫(若有),沒設定的欄位跟著全域走,並夾一次範圍。
 *  預覽(SubtitleOverlay)與樣式面板(StylePanel)在 scope="one" 時都用這個算要顯示/套用的值。 */
export function effectiveStyle(
  global: SubStyle,
  seg?: { style?: Partial<SubStyle> } | null
): SubStyle {
  return clampStyleRanges({ ...global, ...(seg?.style ?? {}) });
}

/**
 * 把存檔的樣式轉成目前版本的格式。
 *
 * 舊版有兩類不相容:bold 布林(→weight)、以及 outline/boxRadius/boxPadX/boxPadY
 * 當年存的是「1080p 基準 px」,現在是「佔影片高度比例」。單純展開合併會讓
 * outline:4 被當成 4 倍畫面高度,字幕直接爆掉,所以要換算再夾範圍。
 */
export function migrateStyle(raw: unknown): SubStyle {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_STYLE };
  const old = raw as Record<string, unknown>;
  const s: SubStyle = { ...DEFAULT_STYLE, ...(raw as Partial<SubStyle>) };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  // bold 布林 → weight
  if (old.weight === undefined && typeof old.bold === "boolean") {
    s.weight = old.bold ? 700 : 400;
  }
  // 舊的 1080p px → 比例(用當年的基準 1080 換算)
  const outline = num(old.outline);
  if (outline !== undefined && outline > STYLE_RANGE.outline[1]) s.outline = outline / 1080;
  const radius = num(old.boxRadius);
  if (radius !== undefined && radius > STYLE_RANGE.boxRadius[1]) s.boxRadius = radius / 1080;
  // 舊的 boxPadX/Y 是「在自動內距之上的增量 px」,換算成比例後疊回預設內距
  if (old.padX === undefined && num(old.boxPadX) !== undefined) {
    s.padX = DEFAULT_STYLE.padX + (num(old.boxPadX) as number) / 1080;
  }
  if (old.padY === undefined && num(old.boxPadY) !== undefined) {
    s.padY = DEFAULT_STYLE.padY + (num(old.boxPadY) as number) / 1080;
  }

  // 丟掉已淘汰的鍵,免得存回去又被下次載入讀到
  delete (s as unknown as Record<string, unknown>).bold;
  delete (s as unknown as Record<string, unknown>).boxPadX;
  delete (s as unknown as Record<string, unknown>).boxPadY;
  return clampStyleRanges(s);
}

export interface DictEntry {
  id: string;
  wrong: string;
  right: string;
}

export interface FixSuggestion {
  id: string;
  old: string;
  new: string;
}

export interface FixJob {
  status: "idle" | "running" | "done" | "error" | "canceled";
  total?: number;
  done?: number;
  suggestions?: FixSuggestion[];
  error?: string | null;
  started_at?: number;
}

export interface BurnJob {
  status: "idle" | "running" | "done" | "error" | "canceled";
  progress: number;
  error: string | null;
  has_file: boolean;
}

export const RUNNING_STATUSES: Project["status"][] = [
  "uploaded",
  "extracting",
  "loading_model",
  "transcribing",
  "converting",
];

export function statusLabel(p: Project): string {
  switch (p.status) {
    case "uploaded":
      return "等待辨識";
    case "extracting":
      return "抽取音軌中";
    case "loading_model":
      return "載入模型中(首次會下載,需要幾分鐘)";
    case "transcribing":
      return `辨識中 ${Math.round(p.progress * 100)}%`;
    case "converting":
      return "轉換繁體中";
    case "done":
      return "完成";
    case "error":
      return "辨識失敗";
    case "interrupted":
      return "辨識中斷";
  }
}
