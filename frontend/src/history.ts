import { useCallback, useRef, useState } from "react";

const LIMIT = 100;

/** 帶復原/重做的狀態:每次 set 都是一個可復原的步驟。 */
export function useHistoryState<T>(initial: T) {
  const [present, setPresent] = useState<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const presentRef = useRef<T>(initial);
  presentRef.current = present;

  const set = useCallback((updater: (prev: T) => T) => {
    const next = updater(presentRef.current);
    if (next === presentRef.current) return;
    past.current.push(presentRef.current);
    if (past.current.length > LIMIT) past.current.shift();
    future.current = [];
    setPresent(next);
  }, []);

  /** 重設狀態並清空歷史(載入資料用,不產生復原步驟)。 */
  const reset = useCallback((value: T) => {
    past.current = [];
    future.current = [];
    setPresent(value);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(presentRef.current);
    setPresent(prev);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(presentRef.current);
    setPresent(next);
  }, []);

  // past/future 是 ref,不會自己觸發渲染,但每次 set/undo/redo 都會連帶 setPresent
  // 造成重渲染,所以在渲染當下讀取的長度一定是最新的,不需要額外狀態同步。
  return {
    value: present,
    set,
    reset,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
