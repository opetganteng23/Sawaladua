import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  align?: "left" | "right";
  render?: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  total: number;
  page: number;
  pages: number;
  limit: number;
  loading?: boolean;
  error?: string;
  sort?: { key: string; dir: "asc" | "desc" };
  onSort?: (key: string) => void;
  onPage: (page: number) => void;
  empty?: string;
  actions?: (row: T) => ReactNode;
  actionsHeader?: string;
}

/**
 * Tabel data admin yang aksesibel: caption, header ber-scope, urutan (aria-sort), paginasi dengan ringkasan,
 * status memuat/kosong/galat. Urutan dan halaman dikendalikan induk (server-side).
 */
export function DataTable<T>(p: DataTableProps<T>) {
  const from = p.total === 0 ? 0 : (p.page - 1) * p.limit + 1;
  const to = Math.min(p.total, p.page * p.limit);
  const ariaSort = (c: Column<T>) => (!c.sortable || p.sort?.key !== c.key ? "none" : p.sort.dir === "asc" ? "ascending" : "descending");
  const colCount = p.columns.length + (p.actions ? 1 : 0);

  return (
    <div className="dt">
      <div className="dt-scroll" tabIndex={0} role="region" aria-label={`${p.caption} (dapat digulir)`} aria-busy={p.loading ? "true" : "false"}>
        <table>
          <caption className="sr-only">{p.caption}</caption>
          <thead>
            <tr>
              {p.columns.map((c) => (
                <th key={c.key} scope="col" aria-sort={ariaSort(c)} className={c.align === "right" ? "num" : undefined}>
                  {c.sortable && p.onSort ? (
                    <button type="button" className="dt-sort" onClick={() => p.onSort!(c.key)}>
                      {c.header}
                      <span aria-hidden="true" className="sortmark">{p.sort?.key === c.key ? (p.sort.dir === "asc" ? " ▲" : " ▼") : " ↕︎"}</span>
                    </button>
                  ) : c.header}
                </th>
              ))}
              {p.actions && <th scope="col">{p.actionsHeader ?? "Aksi"}</th>}
            </tr>
          </thead>
          <tbody>
            {p.error && <tr><td colSpan={colCount} role="alert" className="dt-msg dt-err">{p.error}</td></tr>}
            {!p.error && p.loading && p.rows.length === 0 && <tr><td colSpan={colCount} className="dt-msg">Memuat…</td></tr>}
            {!p.error && !p.loading && p.rows.length === 0 && <tr><td colSpan={colCount} className="dt-msg">{p.empty ?? "Belum ada data."}</td></tr>}
            {p.rows.map((row) => (
              <tr key={p.rowKey(row)}>
                {p.columns.map((c, i) => {
                  const content = c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "");
                  return i === 0
                    ? <th key={c.key} scope="row" className="dt-first">{content}</th>
                    : <td key={c.key} className={c.align === "right" ? "num" : undefined}>{content}</td>;
                })}
                {p.actions && <td className="dt-actions">{p.actions(row)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="dt-pager" aria-label={`Paginasi ${p.caption}`}>
        <span role="status" aria-live="polite">{p.total === 0 ? "Tidak ada data" : `Menampilkan ${from}–${to} dari ${p.total}`}</span>
        <span className="spacer" />
        <button type="button" className="btn" disabled={p.page <= 1 || p.loading} onClick={() => p.onPage(p.page - 1)}>‹ Sebelumnya</button>
        <span>Halaman {p.page} dari {p.pages}</span>
        <button type="button" className="btn" disabled={p.page >= p.pages || p.loading} onClick={() => p.onPage(p.page + 1)}>Berikutnya ›</button>
      </nav>
    </div>
  );
}
