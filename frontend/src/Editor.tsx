import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import Brand from "./Brand";
import { useHistoryState } from "./history";
import {
  activeIndexAt,
  formatTime,
  formatTimeMs,
  mergeSegments,
  splitSegment,
  splitSegmentAtTime,
  uid,
} from "./segments";
import { diffParts } from "./diff";
import SafeFrame, { SAFE_FRAMES, matchPresetByRatio } from "./SafeFrame";
import { SubtitleOverlay, StylePanel } from "./StyleOverlay";
import {
  DEFAULT_STYLE,
  effectiveStyle,
  migrateStyle,
  RUNNING_STATUSES,
  statusLabel,
  type BurnJob,
  type DictEntry,
  type FixJob,
  type FixSuggestion,
  type Project,
  type Segment,
  type SubStyle,
} from "./types";
import Waveform from "./Waveform";

type SaveState = "saved" | "saving" | "dirty" | "error";

const SAVE_LABEL: Record<SaveState, string> = {
  saved: "已存本機",
  saving: "儲存中…",
  dirty: "編輯中…",
  error: "儲存失敗,稍後自動重試",
};

const EXPORT_FORMATS = [
  { format: "srt", label: "SRT 字幕檔" },
  { format: "vtt", label: "VTT 字幕檔" },
  { format: "txt", label: "逐字稿(純文字)" },
  { format: "txt-ts", label: "逐字稿(含時間)" },
];

const HOTKEYS: [string, string][] = [
  ["Enter", "在游標處斷句"],
  ["Backspace", "句首按下與上句合併"],
  ["Tab / Shift+Tab", "跳到下一句 / 上一句"],
  ["空白鍵", "播放 / 暫停"],
  ["↑ ↓", "選句並跳到該時間"],
  ["B", "在播放位置切開字幕"],
  ["Delete", "刪除選中的字幕"],
  ["雙擊波形", "新增 / 移除 Mark 點"],
  ["Ctrl+Z / Ctrl+Y", "復原 / 重做"],
  ["Alt", "顯示/隱藏逐字位置點(切換)"],
];

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** SRT/VTT 都用的時間碼:00:00:01,500 或 00:00:01.500 → 秒數。 */
function parseTimecode(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/**
 * 前端解析 SRT/VTT 字幕檔:只認時間碼列(逗號或句點都當毫秒分隔),
 * 忽略序號列與 WEBVTT 標頭,直到空行為止的內容當作該句文字。
 * 用來實作「匯入修正字幕」:取代目前 segments 的文字與時間,words 清空。
 */
function parseSubtitleText(content: string): Segment[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const timeRe =
    /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;
  const segs: Segment[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = timeRe.exec(lines[i]);
    if (m) {
      const start = parseTimecode(m[1], m[2], m[3], m[4]);
      const end = parseTimecode(m[5], m[6], m[7], m[8]);
      i++;
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        textLines.push(lines[i]);
        i++;
      }
      const text = textLines.join("\n").trim();
      if (text && end > start) {
        segs.push({ id: uid(), start: round3(start), end: round3(end), text, words: [] });
      }
    } else {
      i++;
    }
  }
  segs.sort((a, b) => a.start - b.start || a.end - b.end);
  return segs;
}

/** 把 text 內所有 query 出現處包成 <mark>,curPos 那一處多加 .cur。 */
function renderHighlighted(text: string, query: string, curPos: number) {
  if (!query) return text;
  const parts: React.ReactNode[] = [];
  let from = 0;
  while (true) {
    const pos = text.indexOf(query, from);
    if (pos < 0) break;
    if (pos > from) parts.push(text.slice(from, pos));
    parts.push(
      <mark key={pos} className={pos === curPos ? "cur" : undefined}>
        {text.slice(pos, pos + query.length)}
      </mark>
    );
    from = pos + query.length;
  }
  parts.push(text.slice(from));
  return parts;
}

interface EditingState {
  id: string;
  cursor: number;
}

export default function Editor({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const history = useHistoryState<Segment[]>([]);
  const segments = history.value;
  // 這些函式引用是穩定的,拿出來當 dependency 用
  const { set: setSegments, reset: resetSegments, undo: undoHistory, redo: redoHistory } = history;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  const [peaks, setPeaks] = useState<{ rate: number; peaks: number[] } | null>(null);
  const [marks, setMarks] = useState<number[]>([]);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const justLoadedMarksRef = useRef<number[] | null>(null);
  const [cuts, setCuts] = useState<number[]>([]);
  const [cutsStatus, setCutsStatus] = useState("idle");
  const [safeFrame, setSafeFrame] = useState("off");
  const [videoDims, setVideoDims] = useState({ w: 0, h: 0 });

  // ---- 版面調整(波形高度 / 左右欄寬 / 影片收合) ----
  const [waveHeight, setWaveHeight] = useState(190);
  const [leftPct, setLeftPct] = useState(47);
  const [videoCollapsed, setVideoCollapsed] = useState(false);
  const editorRef = useRef<HTMLElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const layoutLoadedRef = useRef(false);
  const [burnJob, setBurnJob] = useState<BurnJob | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const selectedIdxRef = useRef(selectedIdx);
  selectedIdxRef.current = selectedIdx;
  const [query, setQuery] = useState("");
  const [replaceValue, setReplaceValue] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const matchIdxRef = useRef(matchIdx);
  matchIdxRef.current = matchIdx;
  const followMatchRef = useRef(false);
  const [showDots, setShowDots] = useState(false);

  const [subStyle, setSubStyleState] = useState<SubStyle>(DEFAULT_STYLE);
  const styleRef = useRef(subStyle);
  styleRef.current = subStyle;
  const [styleOpen, setStyleOpen] = useState(false);
  const justLoadedStyleRef = useRef<SubStyle | null>(null);
  // "all"=面板改全域樣式(現行行為);"one"=面板只改目前選取那句的覆寫
  const [styleScope, setStyleScope] = useState<"all" | "one">("all");

  const [llmAvailable, setLlmAvailable] = useState(false);
  const [fixJob, setFixJob] = useState<FixJob | null>(null);
  const [reviewItems, setReviewItems] = useState<FixSuggestion[] | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const [dictOpen, setDictOpen] = useState(false);
  const [dictEntries, setDictEntries] = useState<DictEntry[]>([]);
  const [dictWrong, setDictWrong] = useState("");
  const [dictRight, setDictRight] = useState("");
  const [dictMsg, setDictMsg] = useState("");

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  const videoRef = useRef<HTMLVideoElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const loadedRef = useRef(false);
  const justLoadedRef = useRef<Segment[] | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);

  const running = project ? RUNNING_STATUSES.includes(project.status) : false;

  const loadSubtitles = useCallback(() => {
    api.getSubtitles(projectId).then((s) => {
      justLoadedRef.current = s.segments;
      loadedRef.current = true;
      resetSegments(s.segments);
      const m = s.marks ?? [];
      justLoadedMarksRef.current = m;
      setMarks(m);
      // migrateStyle 會補齊新欄位、換算舊單位並夾住範圍;它一律回傳新物件,
      // 所以也不會跟共用的 DEFAULT_STYLE 常數同一個參照(不然「還原」按鈕若
      // 剛好也還原成 DEFAULT_STYLE,dirty 判斷會誤判成沒變動而漏存)
      const st = migrateStyle(s.style);
      justLoadedStyleRef.current = st;
      setSubStyleState(st);
    });
  }, [projectId, resetSegments]);

  // 初次載入
  useEffect(() => {
    let alive = true;
    api
      .getProject(projectId)
      .then((p) => {
        if (!alive) return;
        setProject(p);
        if (p.status === "done") loadSubtitles();
      })
      .catch((e: Error) => setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [projectId, loadSubtitles]);

  // 辨識進行中輪詢進度
  useEffect(() => {
    if (!project || !RUNNING_STATUSES.includes(project.status)) return;
    const timer = setInterval(() => {
      api
        .getProject(projectId)
        .then((p) => {
          setProject(p);
          if (p.status === "done") loadSubtitles();
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [project?.status, projectId, loadSubtitles]); // eslint-disable-line react-hooks/exhaustive-deps

  // 重新整理頁面後,把進行中(或剛完成)的燒錄/AI 校正狀態接回來
  useEffect(() => {
    if (project?.status !== "done") return;
    let alive = true;
    api
      .getBurn(projectId)
      .then((j) => {
        if (alive && (j.status === "running" || j.status === "done")) setBurnJob(j);
      })
      .catch(() => {});
    api
      .getFix(projectId)
      .then((j) => {
        if (!alive) return;
        if (j.status === "running") {
          setFixJob(j);
        } else if (j.status === "done" && j.suggestions?.length) {
          setFixJob(j);
          setReviewItems(j.suggestions);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project?.status, projectId]);

  // 波形資料(完成後載入)
  useEffect(() => {
    if (project?.status !== "done") return;
    let alive = true;
    api
      .getWaveform(projectId)
      .then((w) => {
        if (alive) setPeaks(w);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project?.status, projectId]);

  // Claude Code CLI 可用性(不可用就整塊隱藏)
  useEffect(() => {
    api
      .getLlmStatus()
      .then((s) => setLlmAvailable(s.available))
      .catch(() => {});
  }, []);

  // AI 校正進行中輪詢進度;完成後打開審閱面板
  useEffect(() => {
    if (fixJob?.status !== "running") return;
    const timer = setInterval(() => {
      api
        .getFix(projectId)
        .then((j) => {
          setFixJob(j);
          if (j.status === "done") {
            const items = j.suggestions ?? [];
            if (items.length) {
              setReviewItems(items);
            } else {
              alert("AI 檢查完了,沒有找到需要修正的地方。");
              api.cancelFix(projectId).catch(() => {});
              setFixJob(null);
            }
          } else if (j.status === "error") {
            alert(`AI 校正失敗:${j.error ?? "未知錯誤"}`);
            api.cancelFix(projectId).catch(() => {});
            setFixJob(null);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [fixJob?.status, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // AI 校正時每秒跳動的計時器,讓使用者看得出工作還活著
  useEffect(() => {
    if (fixJob?.status !== "running") return;
    setNowTick(Date.now());
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixJob?.status]);

  // 播放中用 rAF 平滑更新時間(timeupdate 只有 4Hz,播放頭會頓)
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setCurrentTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  // 自動存檔(0.8 秒沒動作就送出;失敗 3 秒後重試)
  const doSave = useCallback(() => {
    setSaveState("saving");
    api
      .saveSubtitles(projectId, segmentsRef.current, marksRef.current, styleRef.current)
      .then(() => setSaveState("saved"))
      .catch(() => {
        setSaveState("error");
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(doSave, 3000);
      });
  }, [projectId]);

  useEffect(() => {
    if (!loadedRef.current) return;
    if (justLoadedRef.current === segments) return;
    setSaveState("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(doSave, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [segments, doSave]);

  // Mark 點變動也觸發自動存檔
  useEffect(() => {
    if (!loadedRef.current) return;
    if (justLoadedMarksRef.current === marks) return;
    setSaveState("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(doSave, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [marks, doSave]);

  // 字幕樣式變動也觸發自動存檔
  useEffect(() => {
    if (!loadedRef.current) return;
    if (justLoadedStyleRef.current === subStyle) return;
    setSaveState("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(doSave, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [subStyle, doSave]);

  // 切點:載入既有結果;偵測中每 2 秒輪詢
  useEffect(() => {
    if (project?.status !== "done") return;
    let alive = true;
    api
      .getCuts(projectId)
      .then((c) => {
        if (!alive) return;
        setCuts(c.cuts);
        setCutsStatus(c.status === "running" ? "running" : c.cuts.length ? "done" : "idle");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project?.status, projectId]);

  useEffect(() => {
    if (cutsStatus !== "running") return;
    const timer = setInterval(() => {
      api
        .getCuts(projectId)
        .then((c) => {
          if (c.status === "done") {
            setCuts(c.cuts);
            setCutsStatus("done");
          } else if (c.status === "error") {
            alert(`切點偵測失敗:${c.error ?? "未知錯誤"}`);
            setCutsStatus("idle");
          }
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [cutsStatus, projectId]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saveStateRef.current !== "saved") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // 版面尺寸(波形高度/左右欄寬):讀取 localStorage 還原,重開專案也記得
  useEffect(() => {
    layoutLoadedRef.current = false;
    try {
      const raw = localStorage.getItem(`vidscribe:layout:${projectId}`);
      if (raw) {
        const v = JSON.parse(raw) as { waveHeight?: number; leftPct?: number };
        if (typeof v.waveHeight === "number") setWaveHeight(v.waveHeight);
        if (typeof v.leftPct === "number") setLeftPct(v.leftPct);
      }
    } catch {
      // 壞掉的存檔就當沒有,用預設值
    }
    layoutLoadedRef.current = true;
  }, [projectId]);

  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    try {
      localStorage.setItem(
        `vidscribe:layout:${projectId}`,
        JSON.stringify({ waveHeight, leftPct })
      );
    } catch {
      // localStorage 滿了或被擋就略過,不影響編輯
    }
  }, [projectId, waveHeight, leftPct]);

  // 拖曳分隔線:波形區高度(上下拖,80px~40vh)
  const beginWaveResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = waveHeight;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      const onMove = (ev: PointerEvent) => {
        const maxH = window.innerHeight * 0.4;
        const next = Math.min(Math.max(startH + (ev.clientY - startY), 80), maxH);
        setWaveHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [waveHeight]
  );

  // 拖曳分隔線:影片區/字幕區寬度比例(左右拖,25%~75%)
  const beginColResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const el = editorRef.current;
    if (!el) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(Math.max(pct, 25), 75));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = videoWrapRef.current;
    if (!el) return;
    el.requestFullscreen?.().catch(() => {
      // 部分瀏覽器/情境會拒絕全螢幕請求,忽略即可,不需要彈錯誤
    });
  }, []);

  // ---- 匯入修正字幕(SRT/VTT,前端自行解析,取代目前 segments) ----
  const triggerImport = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // 重置,允許再次選同一個檔案
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = String(reader.result ?? "");
          const parsed = parseSubtitleText(text);
          if (!parsed.length) {
            throw new Error("沒有解析到任何字幕內容,請確認是有效的 SRT/VTT 檔案。");
          }
          setSegments(() => parsed);
          setSelectedIdx(-1);
          setEditing(null);
        } catch (err) {
          alert(`匯入失敗:${err instanceof Error ? err.message : String(err)}`);
        }
      };
      reader.onerror = () => alert("讀取檔案失敗,請重新選擇檔案。");
      reader.readAsText(file);
    },
    [setSegments]
  );

  // ---- 編輯操作 ----

  const commitText = useCallback(
    (id: string, draft: string) => {
      setSegments((prev) => {
        const i = prev.findIndex((s) => s.id === id);
        if (i < 0 || prev[i].text === draft) return prev;
        const next = [...prev];
        next[i] = { ...next[i], text: draft };
        return next;
      });
    },
    [setSegments]
  );

  const handleBlur = useCallback(
    (id: string, draft: string) => {
      commitText(id, draft);
      setEditing((e) => (e && e.id === id ? null : e));
    },
    [commitText]
  );

  const handleEsc = useCallback(
    (id: string, draft: string) => {
      commitText(id, draft);
      setEditing(null);
    },
    [commitText]
  );

  const handleSplit = useCallback(
    (id: string, draft: string, pos: number) => {
      const prev = segmentsRef.current;
      const i = prev.findIndex((s) => s.id === id);
      if (i < 0) return;
      const pair = splitSegment({ ...prev[i], text: draft }, pos);
      if (!pair) {
        commitText(id, draft);
        return;
      }
      setSegments(() => {
        const next = [...prev];
        next.splice(i, 1, pair[0], pair[1]);
        return next;
      });
      setEditing({ id: pair[1].id, cursor: 0 });
      setSelectedIdx(i + 1);
    },
    [commitText, setSegments]
  );

  const handleMergeUp = useCallback(
    (id: string, draft: string) => {
      const prev = segmentsRef.current;
      const i = prev.findIndex((s) => s.id === id);
      if (i <= 0) return;
      const merged = mergeSegments(prev[i - 1], { ...prev[i], text: draft });
      const cursor = prev[i - 1].text.length;
      setSegments(() => {
        const next = [...prev];
        next.splice(i - 1, 2, merged);
        return next;
      });
      setEditing({ id: merged.id, cursor });
      setSelectedIdx(i - 1);
    },
    [setSegments]
  );

  // 列底的合併箭頭:與下一句合併(選中停在原位)
  const handleMergeDown = useCallback(
    (idx: number) => {
      const prev = segmentsRef.current;
      if (idx < 0 || idx + 1 >= prev.length) return;
      const merged = mergeSegments(prev[idx], prev[idx + 1]);
      setSegments(() => {
        const next = [...prev];
        next.splice(idx, 2, merged);
        return next;
      });
      setSelectedIdx(idx);
    },
    [setSegments]
  );

  const handleTab = useCallback(
    (id: string, draft: string, dir: 1 | -1) => {
      commitText(id, draft);
      const prev = segmentsRef.current;
      const i = prev.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) {
        setEditing(null);
        return;
      }
      setEditing({ id: prev[j].id, cursor: prev[j].text.length });
      setSelectedIdx(j);
    },
    [commitText]
  );

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, t + 0.001);
    setCurrentTime(v.currentTime);
  }, []);

  const handleRowClick = useCallback(
    (index: number) => {
      const s = segmentsRef.current[index];
      if (!s) return;
      setSelectedIdx(index);
      if (editingRef.current?.id !== s.id) seekTo(s.start);
    },
    [seekTo]
  );

  const handleStartEdit = useCallback((id: string, cursor: number) => {
    setEditing({ id, cursor });
  }, []);

  // 波形區:拖完提交時間。拖過鄰句會改變順序,必須重排,
  // 不然「找播放中那句」的二分搜尋與磁吸鄰居都會抓錯。
  const handleCommitTimes = useCallback(
    (id: string, start: number, end: number) => {
      const prev = segmentsRef.current;
      const i = prev.findIndex((s) => s.id === id);
      if (i < 0) return;
      const next = [...prev];
      next[i] = { ...next[i], start: round3(start), end: round3(end) };
      next.sort((a, b) => a.start - b.start || a.end - b.end);
      setSegments(() => next);
      setSelectedIdx(next.findIndex((s) => s.id === id));
    },
    [setSegments]
  );

  // 波形區:空白處拖選新增字幕
  const handleCreate = useCallback(
    (start: number, end: number) => {
      const seg: Segment = { id: uid(), start: round3(start), end: round3(end), text: "", words: [] };
      const prev = segmentsRef.current;
      let i = prev.findIndex((s) => s.start > seg.start);
      if (i < 0) i = prev.length;
      setSegments(() => {
        const next = [...prev];
        next.splice(i, 0, seg);
        return next;
      });
      setSelectedIdx(i);
      setEditing({ id: seg.id, cursor: 0 });
    },
    [setSegments]
  );

  const addMark = useCallback((t: number) => {
    setMarks((prev) => (prev.includes(t) ? prev : [...prev, t].sort((a, b) => a - b)));
  }, []);

  const removeMark = useCallback((t: number) => {
    setMarks((prev) => prev.filter((m) => m !== t));
  }, []);

  const detectCuts = useCallback(() => {
    api
      .startCuts(projectId)
      .then(() => setCutsStatus("running"))
      .catch((e: Error) => alert(e.message));
  }, [projectId]);

  const deleteSegment = useCallback(
    (idx: number) => {
      const prev = segmentsRef.current;
      if (idx < 0 || idx >= prev.length) return;
      setSegments(() => {
        const next = [...prev];
        next.splice(idx, 1);
        return next;
      });
      setSelectedIdx(-1);
      setEditing(null);
    },
    [setSegments]
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const undo = useCallback(() => {
    setEditing(null);
    undoHistory();
  }, [undoHistory]);

  const redo = useCallback(() => {
    setEditing(null);
    redoHistory();
  }, [redoHistory]);

  // 全域快捷鍵(編輯框內不攔截)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (key === "b" && !ctrl) {
        e.preventDefault();
        const list = segmentsRef.current;
        const t = videoRef.current?.currentTime ?? 0;
        const i = activeIndexAt(list, t);
        if (i >= 0) {
          const pair = splitSegmentAtTime(list[i], t);
          if (pair) {
            setSegments(() => {
              const next = [...list];
              next.splice(i, 1, ...pair);
              return next;
            });
            setSelectedIdx(i + 1);
          }
        }
        return;
      }
      if (e.key === "Delete") {
        const i = selectedIdxRef.current;
        if (i >= 0) {
          e.preventDefault();
          deleteSegment(i);
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = segmentsRef.current;
        if (!list.length) return;
        const cur = selectedIdxRef.current;
        const next =
          e.key === "ArrowDown"
            ? Math.min(cur < 0 ? 0 : cur + 1, list.length - 1)
            : Math.max(cur < 0 ? 0 : cur - 1, 0);
        setSelectedIdx(next);
        seekTo(list[next].start);
        rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (e.key === "Enter") {
        const list = segmentsRef.current;
        const cur = selectedIdxRef.current;
        if (cur >= 0 && cur < list.length) {
          e.preventDefault();
          setEditing({ id: list[cur].id, cursor: list[cur].text.length });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, seekTo, togglePlay, setSegments, deleteSegment]);

  // 按 Alt 切換逐字位置點顯示(preventDefault 防瀏覽器搶去聚焦選單列;
  // e.repeat 擋住按住不放時 keydown 連發,不然每次連發都會再切一次)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        e.preventDefault();
        if (e.repeat) return;
        setShowDots((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // 版面尺寸一變就讓字幕/安全框疊層重新量測影片內容區。
  // 只靠 ResizeObserver 不夠:頁面沒有進行渲染步驟時它不會觸發。
  const layoutKey = `${leftPct}|${waveHeight}|${videoCollapsed}`;

  const activeIdx = useMemo(() => activeIndexAt(segments, currentTime), [segments, currentTime]);

  // 播放時讓目前那句自動捲進視野(搜尋導航中不捲)
  useEffect(() => {
    if (!isPlaying || editing || activeIdx < 0 || query.trim()) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rowRefs.current[activeIdx]?.scrollIntoView({
      block: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [activeIdx, isPlaying, editing, query]);

  // 列表永遠顯示全部句子(What'Sub 式:搜尋只導航,不過濾)
  const rows = useMemo(() => segments.map((seg, idx) => ({ seg, idx })), [segments]);

  // 搜尋:掃出所有符合處(case-sensitive),攤平成 {segIdx, pos}[]
  const q = query.trim();
  const matches = useMemo(() => {
    const result: { segIdx: number; pos: number }[] = [];
    if (!q) return result;
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const text = segments[segIdx].text;
      let from = 0;
      while (true) {
        const pos = text.indexOf(q, from);
        if (pos < 0) break;
        result.push({ segIdx, pos });
        from = pos + q.length;
      }
    }
    return result;
  }, [segments, q]);

  // matches 變動時 clamp 目前 match index;取代後(followMatchRef)順便導航過去
  useEffect(() => {
    if (matches.length === 0) {
      setMatchIdx(0);
      followMatchRef.current = false;
      return;
    }
    const clamped = Math.min(Math.max(matchIdxRef.current, 0), matches.length - 1);
    if (clamped !== matchIdxRef.current) setMatchIdx(clamped);
    if (followMatchRef.current) {
      followMatchRef.current = false;
      const m = matches[clamped];
      setSelectedIdx(m.segIdx);
      seekTo(segments[m.segIdx].start);
      rowRefs.current[m.segIdx]?.scrollIntoView({ block: "center" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  const gotoMatch = useCallback(
    (i: number) => {
      const m = matches[i];
      if (!m) return;
      setMatchIdx(i);
      setSelectedIdx(m.segIdx);
      seekTo(segments[m.segIdx].start);
      rowRefs.current[m.segIdx]?.scrollIntoView({ block: "center" });
    },
    [matches, segments, seekTo]
  );

  const nextMatch = useCallback(() => {
    if (!matches.length) return;
    gotoMatch((matchIdxRef.current + 1) % matches.length);
  }, [matches, gotoMatch]);

  const prevMatch = useCallback(() => {
    if (!matches.length) return;
    gotoMatch((matchIdxRef.current - 1 + matches.length) % matches.length);
  }, [matches, gotoMatch]);

  // 取代目前那一處,取代後跟著跳到下一個(同一 index 的下個 match 自然遞補)
  const replaceCurrent = useCallback(() => {
    const m = matches[matchIdxRef.current];
    if (!m || !q) return;
    followMatchRef.current = true;
    setSegments((prev) => {
      const next = [...prev];
      const seg = next[m.segIdx];
      if (!seg) return prev;
      next[m.segIdx] = {
        ...seg,
        text: seg.text.slice(0, m.pos) + replaceValue + seg.text.slice(m.pos + q.length),
      };
      return next;
    });
  }, [matches, q, replaceValue, setSegments]);

  // 一次取代全部,之後清空目前 match index
  const replaceAll = useCallback(() => {
    if (!q) return;
    setSegments((prev) =>
      prev.map((s) => (s.text.includes(q) ? { ...s, text: s.text.split(q).join(replaceValue) } : s))
    );
    setMatchIdx(0);
  }, [q, replaceValue, setSegments]);

  const curMatch = matches[matchIdx] ?? null;

  // 字幕樣式:局部更新(拖曳/面板調整共用)。scope="one" 時只寫進目前選取那句的
  // 覆寫欄位(seg.style),不動全域 subStyle;scope="all" 則是原本的全域行為。
  const patchStyle = useCallback(
    (patch: Partial<SubStyle>) => {
      if (styleScope === "one") {
        const idx = selectedIdxRef.current;
        if (idx < 0) return;
        setSegments((prev) => {
          const seg = prev[idx];
          if (!seg) return prev;
          const next = [...prev];
          next[idx] = { ...seg, style: { ...(seg.style ?? {}), ...patch } };
          return next;
        });
        return;
      }
      setSubStyleState((prev) => ({ ...prev, ...patch }));
    },
    [styleScope, setSegments]
  );

  // 清掉目前選取那句的樣式覆寫,恢復成完全跟著全域走
  const clearSegStyle = useCallback(() => {
    const idx = selectedIdxRef.current;
    if (idx < 0) return;
    setSegments((prev) => {
      const seg = prev[idx];
      if (!seg || !seg.style) return prev;
      const next = [...prev];
      const { style: _drop, ...rest } = seg;
      next[idx] = rest as Segment;
      return next;
    });
  }, [setSegments]);

  // 切到「這一句」時,若已有選取句子,順便 seek 過去,讓預覽顯示的就是那一句
  const handleStyleScopeChange = useCallback(
    (next: "all" | "one") => {
      setStyleScope(next);
      if (next === "one") {
        const idx = selectedIdxRef.current;
        if (idx >= 0 && segmentsRef.current[idx]) seekTo(segmentsRef.current[idx].start);
      }
    },
    [seekTo]
  );


  // 資訊列:選中句優先,沒有就用播放中那句
  const statIdx = selectedIdx >= 0 ? selectedIdx : activeIdx;
  const statSeg = statIdx >= 0 ? segments[statIdx] : null;

  const retranscribe = () => {
    if (
      segmentsRef.current.length > 0 &&
      !confirm(
        "重新辨識會覆蓋目前的字幕(舊字幕會備份成專案資料夾裡的 subtitles.bak.json)。確定繼續?"
      )
    ) {
      return;
    }
    api
      .retranscribe(projectId)
      .then(setProject)
      .catch((e: Error) => alert(e.message));
  };

  // ---- AI 校正 ----

  const startFix = () => {
    api
      .startFix(projectId)
      .then(setFixJob)
      .catch((e: Error) => alert(e.message));
  };

  const cancelFix = () => {
    if (!confirm("取消這次 AI 校正?")) return;
    api.cancelFix(projectId).catch(() => {});
    setFixJob(null);
  };

  const dismissReview = useCallback(() => {
    api.cancelFix(projectId).catch(() => {});
    setReviewItems(null);
    setFixJob(null);
  }, [projectId]);

  const acceptOne = useCallback(
    (s: FixSuggestion) => {
      setSegments((prev) => {
        const i = prev.findIndex((x) => x.id === s.id);
        if (i < 0 || prev[i].text !== s.old) return prev;
        const next = [...prev];
        next[i] = { ...next[i], text: s.new };
        return next;
      });
      const next = (reviewItems ?? []).filter((x) => x !== s);
      api.updateFix(projectId, next).catch(() => {}); // 剩餘清單落地,重開伺服器能接著審
      setReviewItems(next.length ? next : null);
    },
    [setSegments, reviewItems, projectId]
  );

  const skipOne = useCallback(
    (s: FixSuggestion) => {
      const next = (reviewItems ?? []).filter((x) => x !== s);
      api.updateFix(projectId, next).catch(() => {});
      setReviewItems(next.length ? next : null);
    },
    [reviewItems, projectId]
  );

  const acceptAll = useCallback(() => {
    const items = reviewItems ?? [];
    setSegments((prev) => {
      let changed = false;
      const next = [...prev];
      for (const s of items) {
        const i = next.findIndex((x) => x.id === s.id);
        if (i >= 0 && next[i].text === s.old) {
          next[i] = { ...next[i], text: s.new };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    dismissReview();
  }, [reviewItems, setSegments, dismissReview]);

  const seekToSuggestion = useCallback(
    (s: FixSuggestion) => {
      const i = segmentsRef.current.findIndex((x) => x.id === s.id);
      if (i >= 0) {
        setSelectedIdx(i);
        seekTo(segmentsRef.current[i].start);
        rowRefs.current[i]?.scrollIntoView({ block: "center" });
      }
    },
    [seekTo]
  );

  // ---- 成品影片匯出 ----

  const startBurn = useCallback(() => {
    // 先把未存的編輯沖掉,燒錄才會拿到最新字幕
    window.clearTimeout(saveTimer.current);
    api
      .saveSubtitles(projectId, segmentsRef.current, marksRef.current, styleRef.current)
      .then(() => {
        setSaveState("saved");
        return api.startBurn(projectId);
      })
      .then(setBurnJob)
      .catch((e: Error) => alert(e.message));
  }, [projectId]);

  const cancelBurn = useCallback(() => {
    api.cancelBurn(projectId).catch(() => {});
    setBurnJob(null);
  }, [projectId]);

  useEffect(() => {
    if (burnJob?.status !== "running") return;
    const timer = setInterval(() => {
      api
        .getBurn(projectId)
        .then((j) => {
          if (j.status === "error") {
            alert(`匯出失敗:${j.error ?? "未知錯誤"}`);
            api.cancelBurn(projectId).catch(() => {});
            setBurnJob(null);
          } else {
            setBurnJob(j);
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [burnJob?.status, projectId]);

  // ---- 詞庫 ----

  const openDict = () => {
    setDictOpen(true);
    setDictMsg("");
    api
      .getDictionary()
      .then((d) => setDictEntries(d.entries))
      .catch(() => {});
  };

  const addDictEntry = (e: React.FormEvent) => {
    e.preventDefault();
    api
      .addDictEntry(dictWrong, dictRight)
      .then((d) => {
        setDictEntries(d.entries);
        setDictWrong("");
        setDictRight("");
        setDictMsg("已加入,之後每次辨識完會自動取代。");
      })
      .catch((err: Error) => setDictMsg(err.message));
  };

  const removeDictEntry = (id: string) => {
    api
      .deleteDictEntry(id)
      .then((d) => setDictEntries(d.entries))
      .catch(() => {});
  };

  const applyDictNow = () => {
    const prev = segmentsRef.current;
    const sorted = [...dictEntries].sort((a, b) => b.wrong.length - a.wrong.length);
    let count = 0;
    const next = prev.map((s) => {
      let t = s.text;
      for (const e of sorted) {
        const parts = t.split(e.wrong);
        if (parts.length > 1) {
          count += parts.length - 1;
          t = parts.join(e.right);
        }
      }
      return t === s.text ? s : { ...s, text: t };
    });
    if (count === 0) {
      setDictMsg("目前字幕沒有符合詞庫的內容。");
      return;
    }
    setSegments(() => next);
    setDictMsg(`已取代 ${count} 處(可 Ctrl+Z 復原)。`);
  };

  // 審閱清單清空後,順手清掉後端的工作狀態
  useEffect(() => {
    if (reviewItems === null && fixJob?.status === "done") {
      api.cancelFix(projectId).catch(() => {});
      setFixJob(null);
    }
  }, [reviewItems, fixJob?.status, projectId]);

  // ---- 畫面 ----

  if (loadError || !project) {
    return (
      <div className="page">
        <EditorTopbar project={null} saveState="saved" projectId={projectId} />
        <main className="editor-message">
          <p>{loadError ?? "載入中…"}</p>
          {loadError && <a href="#/">回專案列表</a>}
        </main>
      </div>
    );
  }

  if (running || project.status !== "done") {
    return (
      <div className="page">
        <EditorTopbar project={project} saveState="saved" projectId={projectId} />
        <main className="editor-message">
          {running && <span className="spinner big" aria-hidden />}
          <p className="status-title">{statusLabel(project)}</p>
          {project.status === "transcribing" && (
            <span className="bar wide">
              <span className="bar-fill" style={{ width: `${project.progress * 100}%` }} />
            </span>
          )}
          {project.device === "cpu" && running && (
            <p className="hint">目前用 CPU 辨識(GPU 未啟用),速度會比較慢。</p>
          )}
          {project.error && <p className="error-text">{project.error}</p>}
          {(project.status === "error" || project.status === "interrupted") && (
            <button className="btn" onClick={retranscribe}>
              重新辨識
            </button>
          )}
        </main>
      </div>
    );
  }

  const activeText = activeIdx >= 0 ? segments[activeIdx].text : "";

  return (
    <div className="page">
      <EditorTopbar
        project={project}
        saveState={saveState}
        projectId={projectId}
        exportMenuRef={exportMenuRef}
        onBurn={startBurn}
      />

      <div className="wave-resizable" style={{ height: waveHeight }}>
        {peaks && project.duration ? (
          <Waveform
            peaks={peaks}
            height={waveHeight}
            duration={project.duration}
            segments={segments}
            currentTime={currentTime}
            activeIdx={activeIdx}
            selectedIdx={selectedIdx}
            isPlaying={isPlaying}
            cuts={cuts}
            marks={marks}
            cutsStatus={cutsStatus}
            onDetectCuts={detectCuts}
            onAddMark={addMark}
            onRemoveMark={removeMark}
            onSeek={seekTo}
            onSelect={setSelectedIdx}
            onCommitTimes={handleCommitTimes}
            onCreate={handleCreate}
          />
        ) : (
          <div className="wave-strip wave-loading">波形載入中…</div>
        )}
      </div>
      <div
        className="resize-handle resize-handle-h"
        onPointerDown={beginWaveResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖曳調整波形區高度"
      />

      <div className="toolbar">
        <button
          className="play-btn"
          onClick={togglePlay}
          aria-label={isPlaying ? "暫停" : "播放"}
        >
          {isPlaying ? (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <rect x="3" y="2" width="4" height="12" rx="1" fill="currentColor" />
              <rect x="9" y="2" width="4" height="12" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
            </svg>
          )}
        </button>
        <span className="time-display">
          {formatTimeMs(currentTime)}
          <span className="time-total">
            {" / "}
            {project.duration ? formatTime(project.duration) : "--:--"}
          </span>
        </span>
        <span className="toolbar-sep" aria-hidden />
        <button className="icon-btn" onClick={undo} title="復原 (Ctrl+Z)">
          ↺
        </button>
        <button className="icon-btn" onClick={redo} title="重做 (Ctrl+Y)">
          ↻
        </button>
        <span className="toolbar-spacer" />
        <button
          className="btn small"
          onClick={() => setVideoCollapsed((v) => !v)}
          title={videoCollapsed ? "展開影片區" : "收合影片區,字幕區佔滿寬度"}
        >
          {videoCollapsed ? "展開影片" : "收合影片"}
        </button>
        <button
          className="btn small"
          onClick={toggleFullscreen}
          disabled={videoCollapsed}
          title="影片全螢幕播放"
        >
          全螢幕
        </button>
        <button className="btn small" onClick={openDict} title="管理錯字自動取代清單">
          詞庫
        </button>
        <button
          className="btn small"
          onClick={() => setStyleOpen((v) => !v)}
          title="編輯影片內字幕樣式"
        >
          字幕樣式
        </button>
        <label className="toolbar-select" title="設定安全框預覽">
          <span>安全框</span>
          <select
            className="select"
            value={safeFrame}
            onChange={(e) => {
              setSafeFrame(e.target.value);
              localStorage.setItem(`vidscribe:safeframe:${projectId}`, e.target.value);
            }}
          >
            {SAFE_FRAMES.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={importInputRef}
          type="file"
          accept=".srt,.vtt"
          style={{ display: "none" }}
          onChange={handleImportFile}
        />
        <button
          className="btn small"
          onClick={triggerImport}
          title="用 SRT/VTT 檔取代目前字幕的文字與時間(可 Ctrl+Z 復原)"
        >
          匯入修正字幕
        </button>
        {llmAvailable &&
          (fixJob?.status === "running" ? (
            <button className="btn small" onClick={cancelFix} title="點擊取消">
              <span className="spinner" aria-hidden /> AI 校正中 {fixJob.done ?? 0}/
              {fixJob.total ?? "?"}
            </button>
          ) : (
            <button className="btn small" onClick={startFix} title="用 Claude 檢查錯字與用語">
              AI 校正
            </button>
          ))}
        <details className="hotkey-menu">
          <summary className="btn small">快捷鍵</summary>
          <div className="hotkey-panel">
            {HOTKEYS.map(([key, desc]) => (
              <div key={key} className="hotkey-row">
                <kbd>{key}</kbd>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </details>
      </div>

      <main
        className="editor"
        ref={editorRef}
        style={{ gridTemplateColumns: videoCollapsed ? "1fr" : `${leftPct}% 6px 1fr` }}
      >
        {/* 收合影片用 display:none 而非不 render,video 元素才不會被卸載重載,
            播放進度/暫停狀態才能在展開回來時保留。 */}
        <section className="player-pane" style={{ display: videoCollapsed ? "none" : undefined }}>
          <div
            ref={videoWrapRef}
            className={"video-wrap" + (project.has_video === false ? " audio-only" : "")}
          >
            <video
              ref={videoRef}
              src={api.mediaUrl(projectId)}
              controls
              preload="metadata"
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onLoadedMetadata={(e) => {
                setVideoDims({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
                const stored = localStorage.getItem(`vidscribe:safeframe:${projectId}`);
                setSafeFrame(
                  stored ??
                    matchPresetByRatio(
                      e.currentTarget.videoWidth,
                      e.currentTarget.videoHeight
                    )
                );
              }}
            />
            <SafeFrame videoRef={videoRef} frameKey={safeFrame} layoutKey={layoutKey} />
            <SubtitleOverlay
              videoRef={videoRef}
              layoutKey={layoutKey}
              style={effectiveStyle(subStyle, activeIdx >= 0 ? segments[activeIdx] : null)}
              text={activeText}
              words={activeIdx >= 0 ? segments[activeIdx].words : undefined}
              currentTime={currentTime}
              open={styleOpen}
              onOpen={() => setStyleOpen(true)}
              onChange={patchStyle}
            />
          </div>
          <div className="player-controls">
            <span className="hint">紅色斜紋是平台 UI 會遮住的區域,字幕壓到就該換行(安全框選單已移到上方工具列)</span>
          </div>
        </section>

        <div
          className="resize-handle resize-handle-v"
          style={{ display: videoCollapsed ? "none" : undefined }}
          onPointerDown={beginColResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖曳調整影片區/字幕區寬度"
        />

        <section className={"subtitle-pane" + (styleOpen ? " style-open" : "")}>
          {styleOpen && (
            <StylePanel
              style={
                styleScope === "one"
                  ? effectiveStyle(subStyle, selectedIdx >= 0 ? segments[selectedIdx] : null)
                  : subStyle
              }
              videoW={videoDims.w}
              videoH={videoDims.h}
              onChange={patchStyle}
              onReset={() => setSubStyleState({ ...DEFAULT_STYLE })}
              onClose={() => setStyleOpen(false)}
              scope={styleScope}
              onScopeChange={handleStyleScopeChange}
              selectedIndex={selectedIdx}
              selectedText={selectedIdx >= 0 ? segments[selectedIdx].text : null}
              hasOverride={
                selectedIdx >= 0 && !!segments[selectedIdx].style &&
                Object.keys(segments[selectedIdx].style as object).length > 0
              }
              onClearOverride={clearSegStyle}
            />
          )}
          <div className="search-bar">
            <svg className="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  nextMatch();
                }
              }}
              placeholder="搜尋字幕"
              aria-label="搜尋字幕"
            />
            {q && (
              <span className="search-count mono">
                {matches.length ? matchIdx + 1 : 0}/{matches.length} 處
              </span>
            )}
            {q && (
              <div className="search-nav">
                <button
                  className="icon-btn small"
                  onClick={prevMatch}
                  disabled={!matches.length}
                  title="上一個"
                  aria-label="上一個"
                >
                  ‹
                </button>
                <button
                  className="icon-btn small"
                  onClick={nextMatch}
                  disabled={!matches.length}
                  title="下一個"
                  aria-label="下一個"
                >
                  ›
                </button>
              </div>
            )}
            {query && (
              <button className="link-btn" onClick={() => setQuery("")}>
                清除
              </button>
            )}
          </div>

          {q && (
            <div className="replace-row">
              <span className="replace-arrow" aria-hidden>
                →
              </span>
              <input
                value={replaceValue}
                onChange={(e) => setReplaceValue(e.target.value)}
                placeholder="取代為…"
                aria-label="取代為"
              />
              <button className="btn small" onClick={replaceCurrent} disabled={!matches.length}>
                取代
              </button>
              <button className="btn small" onClick={replaceAll} disabled={!matches.length}>
                全部
              </button>
            </div>
          )}

          <div className="sub-list">
            {segments.length === 0 ? (
              <div className="editor-message">
                <p>沒有辨識到任何語音。</p>
                <button className="btn" onClick={retranscribe}>
                  重新辨識
                </button>
              </div>
            ) : (
              rows.map(({ seg, idx }) => (
                <Row
                  key={seg.id}
                  seg={seg}
                  index={idx}
                  isActive={idx === activeIdx}
                  isSelected={idx === selectedIdx}
                  isLast={idx === segments.length - 1}
                  hasStyle={!!seg.style && Object.keys(seg.style).length > 0}
                  editingCursor={editing?.id === seg.id ? editing.cursor : null}
                  query={q}
                  curPos={curMatch && curMatch.segIdx === idx ? curMatch.pos : -1}
                  showDots={showDots}
                  rowRef={(el) => (rowRefs.current[idx] = el)}
                  onRowClick={handleRowClick}
                  onStartEdit={handleStartEdit}
                  onBlurCommit={handleBlur}
                  onEsc={handleEsc}
                  onSplit={handleSplit}
                  onMergeUp={handleMergeUp}
                  onMergeDown={handleMergeDown}
                  onTab={handleTab}
                  onDelete={deleteSegment}
                  onWordSeek={seekTo}
                />
              ))
            )}
          </div>

          {statSeg && (
            <div className="stats-bar">
              <span className="mono">{formatTimeMs(statSeg.start)}</span>
              <span>{(statSeg.end - statSeg.start).toFixed(2)} 秒</span>
              <span>{statSeg.text.replace(/\s/g, "").length} 字</span>
              <span>
                {(
                  statSeg.text.replace(/\s/g, "").length /
                  Math.max(statSeg.end - statSeg.start, 0.01)
                ).toFixed(1)}{" "}
                字/秒
              </span>
              {statIdx > 0 && (
                <span>
                  與前句間隔 {(statSeg.start - segments[statIdx - 1].end).toFixed(2)} 秒
                </span>
              )}
            </div>
          )}
        </section>
      </main>

      {dictOpen && (
        <div className="fix-panel" role="dialog" aria-label="詞庫">
          <div className="fix-head">
            <span className="fix-title">詞庫({dictEntries.length})</span>
            <span className="toolbar-spacer" />
            <button
              className="btn small"
              onClick={applyDictNow}
              disabled={!dictEntries.length}
            >
              套用到目前字幕
            </button>
            <button className="btn small" onClick={() => setDictOpen(false)}>
              關閉
            </button>
          </div>
          <form className="dict-form" onSubmit={addDictEntry}>
            <input
              value={dictWrong}
              onChange={(e) => setDictWrong(e.target.value)}
              placeholder="錯誤寫法(例:一加一)"
              aria-label="錯誤寫法"
            />
            <span className="dict-arrow">→</span>
            <input
              value={dictRight}
              onChange={(e) => setDictRight(e.target.value)}
              placeholder="正確寫法(例:壹加壹)"
              aria-label="正確寫法"
            />
            <button
              className="btn small primary"
              type="submit"
              disabled={!dictWrong.trim() || !dictRight.trim()}
            >
              加入
            </button>
          </form>
          {dictMsg && <div className="dict-msg">{dictMsg}</div>}
          <div className="fix-list">
            {dictEntries.length === 0 ? (
              <p className="hint">
                還沒有詞。加入「錯誤寫法 → 正確寫法」,之後每次辨識完會自動取代;
                也可以按上面的按鈕套用到目前字幕。
              </p>
            ) : (
              dictEntries.map((e) => (
                <div key={e.id} className="dict-item">
                  <span className="dict-wrong">{e.wrong}</span>
                  <span className="dict-arrow">→</span>
                  <span className="dict-right">{e.right}</span>
                  <span className="toolbar-spacer" />
                  <button
                    className="row-delete visible"
                    onClick={() => removeDictEntry(e.id)}
                    title="從詞庫刪除"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {fixJob?.status === "running" && (
        <div className="fix-status" role="status">
          <div className="fix-status-head">
            <span className="spinner" aria-hidden />
            <span className="fix-title">AI 校正中</span>
            <span className="toolbar-spacer" />
            <button className="btn small" onClick={cancelFix}>
              取消
            </button>
          </div>
          <span className="bar fix-status-bar">
            <span
              className="bar-fill pulsing"
              style={{
                width: `${Math.max(
                  ((fixJob.done ?? 0) / Math.max(fixJob.total ?? 1, 1)) * 100,
                  5
                )}%`,
              }}
            />
          </span>
          <div className="fix-status-info">
            第 {Math.min((fixJob.done ?? 0) + 1, fixJob.total ?? 1)}/{fixJob.total ?? 1} 批 ·
            已找到 {fixJob.suggestions?.length ?? 0} 個建議 · 已執行{" "}
            {fixJob.started_at
              ? Math.max(0, Math.floor(nowTick / 1000 - fixJob.started_at))
              : 0}{" "}
            秒
          </div>
        </div>
      )}

      {burnJob && (burnJob.status === "running" || burnJob.status === "done") && (
        <div
          className="fix-status"
          role="status"
          style={{ bottom: fixJob?.status === "running" ? 150 : 16 }}
        >
          <div className="fix-status-head">
            {burnJob.status === "running" && <span className="spinner" aria-hidden />}
            <span className="fix-title">
              {burnJob.status === "running" ? "匯出影片中" : "影片匯出完成"}
            </span>
            <span className="toolbar-spacer" />
            {burnJob.status === "running" ? (
              <button className="btn small" onClick={cancelBurn}>
                取消
              </button>
            ) : (
              <>
                <a className="btn small primary" href={api.burnFileUrl(projectId)}>
                  下載影片
                </a>
                <button className="btn small" onClick={() => setBurnJob(null)}>
                  關閉
                </button>
              </>
            )}
          </div>
          <span className="bar fix-status-bar">
            <span
              className={"bar-fill" + (burnJob.status === "running" ? " pulsing" : "")}
              style={{ width: `${Math.max(burnJob.progress * 100, 3)}%` }}
            />
          </span>
          {burnJob.status === "running" && (
            <div className="fix-status-info">
              {Math.round(burnJob.progress * 100)}% · NVENC 硬體編碼(失敗自動改用 CPU)
            </div>
          )}
        </div>
      )}

      {reviewItems && (
        <div className="fix-panel" role="dialog" aria-label="AI 校正建議">
          <div className="fix-head">
            <span className="fix-title">AI 校正建議({reviewItems.length})</span>
            <span className="toolbar-spacer" />
            <button className="btn small primary" onClick={acceptAll}>
              全部接受
            </button>
            <button className="btn small" onClick={dismissReview}>
              關閉
            </button>
          </div>
          <div className="fix-list">
            {reviewItems.map((s) => {
              const d = diffParts(s.old, s.new);
              return (
                <div key={s.id + s.old} className="fix-item">
                  <button className="fix-text" onClick={() => seekToSuggestion(s)}>
                    <span>{d.pre}</span>
                    {d.aMid && <del>{d.aMid}</del>}
                    {d.bMid && <ins>{d.bMid}</ins>}
                    <span>{d.post}</span>
                  </button>
                  <div className="fix-actions">
                    <button className="btn small primary" onClick={() => acceptOne(s)}>
                      接受
                    </button>
                    <button className="btn small" onClick={() => skipOne(s)}>
                      略過
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function EditorTopbar({
  project,
  saveState,
  projectId,
  exportMenuRef,
  onBurn,
}: {
  project: Project | null;
  saveState: SaveState;
  projectId: string;
  exportMenuRef?: React.RefObject<HTMLDetailsElement>;
  onBurn?: () => void;
}) {
  const done = project?.status === "done";
  return (
    <header className="topbar">
      <a className="brand-link" href="#/" title="回專案列表">
        <Brand />
      </a>
      <span className="topbar-name">{project?.name ?? ""}</span>
      <span className="topbar-right">
        {done && (
          <span className={"save-state save-" + saveState}>{SAVE_LABEL[saveState]}</span>
        )}
        {done && (
          <details className="export-menu" ref={exportMenuRef}>
            <summary className="btn primary">匯出</summary>
            <div className="export-items">
              {EXPORT_FORMATS.map((f) => (
                <a
                  key={f.format}
                  href={api.exportUrl(projectId, f.format)}
                  onClick={() => {
                    if (exportMenuRef?.current) exportMenuRef.current.open = false;
                  }}
                >
                  {f.label}
                </a>
              ))}
              {onBurn && project?.has_video !== false && (
                <button
                  onClick={() => {
                    if (exportMenuRef?.current) exportMenuRef.current.open = false;
                    onBurn();
                  }}
                >
                  成品影片(燒錄字幕)
                </button>
              )}
            </div>
          </details>
        )}
      </span>
    </header>
  );
}

interface RowProps {
  seg: Segment;
  index: number;
  isActive: boolean;
  isSelected: boolean;
  isLast: boolean;
  hasStyle: boolean;
  editingCursor: number | null;
  query: string;
  curPos: number;
  showDots: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
  onRowClick: (index: number) => void;
  onStartEdit: (id: string, cursor: number) => void;
  onBlurCommit: (id: string, draft: string) => void;
  onEsc: (id: string, draft: string) => void;
  onSplit: (id: string, draft: string, pos: number) => void;
  onMergeUp: (id: string, draft: string) => void;
  onMergeDown: (index: number) => void;
  onTab: (id: string, draft: string, dir: 1 | -1) => void;
  onDelete: (index: number) => void;
  onWordSeek: (t: number) => void;
}

const Row = memo(function Row({
  seg,
  index,
  isActive,
  isSelected,
  isLast,
  hasStyle,
  editingCursor,
  query,
  curPos,
  showDots,
  rowRef,
  onRowClick,
  onStartEdit,
  onBlurCommit,
  onEsc,
  onSplit,
  onMergeUp,
  onMergeDown,
  onTab,
  onDelete,
  onWordSeek,
}: RowProps) {
  const cls =
    "sub-row" + (isActive ? " active" : "") + (isSelected ? " selected" : "");
  // 逐字模式(showDots)要有 words 才切成逐字欄位;沒有 words 的句子維持原樣顯示,不塞空列
  const wordMode = showDots && editingCursor === null && !!seg.words && seg.words.length > 0;
  return (
    <div
      ref={rowRef}
      className={cls}
      onClick={() => onRowClick(index)}
      onDoubleClick={() => onStartEdit(seg.id, seg.text.length)}
    >
      <span
        className="row-time"
        title={`${formatTime(seg.start)} → ${formatTime(seg.end)}`}
      >
        {hasStyle && (
          <span className="row-style-mark" title="這句有自訂樣式">
            ◆
          </span>
        )}
        {formatTime(seg.start)}
      </span>
      <div className="row-text-col">
        {editingCursor !== null ? (
          <RowTextarea
            segId={seg.id}
            initial={seg.text}
            cursor={editingCursor}
            onBlurCommit={onBlurCommit}
            onEsc={onEsc}
            onSplit={onSplit}
            onMergeUp={onMergeUp}
            onTab={onTab}
          />
        ) : wordMode ? (
          // 逐字模式:點與字放進同一欄(.word-col 內 dot 在上、字在下),
          // 不論字寬如何,點一定對齊在它對應的字正上方。
          // ⚠️ 這個模式下不走 renderHighlighted,搜尋高亮暫時失效。
          <div className="row-words">
            {seg.words!.map((w, i) => (
              <span
                key={i}
                className="word-col"
                title={w.word}
                onClick={(e) => {
                  e.stopPropagation();
                  onWordSeek(w.start);
                }}
              >
                <i className="dot" aria-hidden />
                <span className="ch">{w.word}</span>
              </span>
            ))}
          </div>
        ) : (
          <span className="row-text">
            {query ? renderHighlighted(seg.text, query, curPos) : seg.text}
          </span>
        )}
      </div>
      <span className="row-count">{seg.text.replace(/\s/g, "").length}</span>
      <button
        className="row-delete"
        title="刪除這句字幕"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(index);
        }}
      >
        ✕
      </button>
      {!isLast && (
        <button
          className="merge-btn"
          title="與下一句合併"
          onClick={(e) => {
            e.stopPropagation();
            onMergeDown(index);
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
            <path
              d="M3 3 L8 7 L13 3"
              stroke="currentColor"
              strokeWidth="1.8"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M3 13 L8 9 L13 13"
              stroke="currentColor"
              strokeWidth="1.8"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
});

function RowTextarea({
  segId,
  initial,
  cursor,
  onBlurCommit,
  onEsc,
  onSplit,
  onMergeUp,
  onTab,
}: {
  segId: string;
  initial: string;
  cursor: number;
  onBlurCommit: (id: string, draft: string) => void;
  onEsc: (id: string, draft: string) => void;
  onSplit: (id: string, draft: string, pos: number) => void;
  onMergeUp: (id: string, draft: string) => void;
  onTab: (id: string, draft: string, dir: 1 | -1) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  const autoSize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const pos = Math.min(cursor, el.value.length);
    el.setSelectionRange(pos, pos);
    autoSize(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <textarea
      ref={ref}
      className="row-editor"
      value={draft}
      rows={1}
      onChange={(e) => {
        setDraft(e.target.value);
        autoSize(e.target);
      }}
      onBlur={() => onBlurCommit(segId, draft)}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSplit(segId, draft, el.selectionStart);
        } else if (
          e.key === "Backspace" &&
          el.selectionStart === 0 &&
          el.selectionEnd === 0
        ) {
          e.preventDefault();
          onMergeUp(segId, draft);
        } else if (e.key === "Tab") {
          e.preventDefault();
          onTab(segId, draft, e.shiftKey ? -1 : 1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onEsc(segId, draft);
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
