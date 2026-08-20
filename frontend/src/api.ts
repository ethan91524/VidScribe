import type { BurnJob, DictEntry, FixJob, Project, Segment, SubStyle } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* keep statusText */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  getHealth: () =>
    fetch("/api/health").then((r) => json<{ ffmpeg: boolean; claude: boolean }>(r)),

  listProjects: () => fetch("/api/projects").then((r) => json<Project[]>(r)),

  getProject: (id: string) => fetch(`/api/projects/${id}`).then((r) => json<Project>(r)),

  deleteProject: (id: string) =>
    fetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  retranscribe: (id: string) =>
    fetch(`/api/projects/${id}/transcribe`, { method: "POST" }).then((r) => json<Project>(r)),

  getSubtitles: (id: string) =>
    fetch(`/api/projects/${id}/subtitles`).then((r) =>
      json<{ version: number; segments: Segment[]; marks?: number[]; style?: SubStyle | null }>(r)
    ),

  saveSubtitles: (id: string, segments: Segment[], marks: number[], style: SubStyle) =>
    fetch(`/api/projects/${id}/subtitles`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments, marks, style }),
    }).then((r) => json<{ ok: boolean }>(r)),

  getCuts: (id: string) =>
    fetch(`/api/projects/${id}/cuts`).then((r) =>
      json<{ status: string; cuts: number[]; error: string | null }>(r)
    ),

  startCuts: (id: string) =>
    fetch(`/api/projects/${id}/cuts`, { method: "POST" }).then((r) =>
      json<{ status: string; cuts: number[]; error: string | null }>(r)
    ),

  getDictionary: () =>
    fetch("/api/dictionary").then((r) => json<{ entries: DictEntry[] }>(r)),

  addDictEntry: (wrong: string, right: string) =>
    fetch("/api/dictionary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong, right }),
    }).then((r) => json<{ entries: DictEntry[] }>(r)),

  deleteDictEntry: (id: string) =>
    fetch(`/api/dictionary/${id}`, { method: "DELETE" }).then((r) =>
      json<{ entries: DictEntry[] }>(r)
    ),

  /** 改詞後問要不要把這組「錯誤→正確」加進詞庫;有 Claude Code CLI 就交給它判斷,沒有就退回保守規則。 */
  suggestDictEntry: (wrong: string, right: string) =>
    fetch("/api/dictionary/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong, right }),
    }).then((r) => json<{ add: boolean; reason: string; by: "ai" | "rule" }>(r)),

  getLlmStatus: () =>
    fetch("/api/llm/status").then((r) => json<{ available: boolean }>(r)),

  startFix: (id: string) =>
    fetch(`/api/projects/${id}/fix`, { method: "POST" }).then((r) => json<FixJob>(r)),

  getFix: (id: string) =>
    fetch(`/api/projects/${id}/fix`).then((r) => json<FixJob>(r)),

  updateFix: (id: string, suggestions: { id: string; old: string; new: string }[]) =>
    fetch(`/api/projects/${id}/fix`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestions }),
    }).then((r) => json<{ ok: boolean }>(r)),

  cancelFix: (id: string) =>
    fetch(`/api/projects/${id}/fix`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  getWaveform: (id: string) =>
    fetch(`/api/projects/${id}/waveform`).then((r) =>
      json<{ rate: number; peaks: number[] }>(r)
    ),

  startBurn: (id: string) =>
    fetch(`/api/projects/${id}/burn`, { method: "POST" }).then((r) => json<BurnJob>(r)),

  getBurn: (id: string) =>
    fetch(`/api/projects/${id}/burn`).then((r) => json<BurnJob>(r)),

  cancelBurn: (id: string) =>
    fetch(`/api/projects/${id}/burn`, { method: "DELETE" }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  burnFileUrl: (id: string) => `/api/projects/${id}/burn/file`,

  mediaUrl: (id: string) => `/api/projects/${id}/media`,
  exportUrl: (id: string, format: string) => `/api/projects/${id}/export?format=${format}`,
};

/** 用 XHR 上傳才拿得到進度。 */
export function uploadMedia(
  file: File,
  onProgress: (ratio: number) => void
): Promise<Project> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/projects");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let msg = `上傳失敗(${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).detail ?? msg;
        } catch {
          /* keep default */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("連不上伺服器"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
