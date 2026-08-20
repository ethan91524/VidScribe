export interface Word {
  start: number;
  end: number;
  word: string;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
  words?: Word[];
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
