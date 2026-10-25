import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

export interface Paged<T> { items: T[]; total: number; page: number; limit: number; pages: number }

/** Muat daftar berpaginasi dari server dengan filter/urutan; mengabaikan respons basi (balapan permintaan). */
export function usePagedList<T>(path: string, params: Record<string, string | number | undefined>) {
  const [data, setData] = useState<Paged<T>>({ items: [], total: 0, page: 1, limit: 20, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const seq = useRef(0);
  const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

  const reload = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const r = await api<Paged<T>>("GET", `${path}?${qs}`);
      if (id === seq.current) { setData(r); setError(""); }
    } catch (e) {
      if (id === seq.current) setError((e as Error).message);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path, qs]);

  useEffect(() => { void reload(); }, [reload]);
  return { data, loading, error, reload };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "-");
export const fmtNum = (n: number) => n.toLocaleString("id-ID");
