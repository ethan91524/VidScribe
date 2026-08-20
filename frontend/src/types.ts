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
export type SubAnim = "none" | "fade";

/** 字幕樣式,鍵名/預設值需與 backend/exporter.py 的 STYLE_DEFAULTS 完全一致。 */
export interface SubStyle {
  anim: SubAnim;
  font: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  size: number;
  spacing: number;
  color: string;
  alpha: number;
  box: boolean;
  boxColor: string;
  boxAlpha: number;
  boxRadius: number;
  boxPadX: number;
  boxPadY: number;
  outline: number;
  shadow: boolean;
  x: number;
  y: number;
  align: SubAlign;
}

export const DEFAULT_STYLE: SubStyle = {
  anim: "none",
  font: "Microsoft JhengHei",
  bold: true,
  italic: false,
  underline: false,
  size: 0.055,
  spacing: 0.0,
  color: "#FFFFFF",
  alpha: 1.0,
  box: false,
  boxColor: "#080808",
  boxAlpha: 0.88,
  boxRadius: 6,
  boxPadX: 0,
  boxPadY: 0,
  outline: 4,
  shadow: true,
  x: 0.5,
  y: 0.9,
  align: "center",
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
