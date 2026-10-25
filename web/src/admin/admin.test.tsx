import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApp } from "./AdminApp";
import { DataTable } from "./DataTable";
import { FeaturesPage } from "./FeaturesPage";
import { ProvidersPage } from "./ProvidersPage";
import { SettingsPage } from "./SettingsPage";
import { UsersPage } from "./UsersPage";
import type { User } from "../api";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());
const calls = (method: string, prefix: string) => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === method && String(c[0]).startsWith(prefix));
const bodyOf = (c: unknown[]) => JSON.parse((c[1] as RequestInit).body as string);

describe("DataTable", () => {
  const base = { caption: "Tabel uji", columns: [{ key: "name", header: "Nama", sortable: true }, { key: "n", header: "Jumlah", align: "right" as const }], rowKey: (r: { name: string }) => r.name, limit: 10 };
  it("menampilkan caption, header ber-scope, aria-sort, ringkasan paginasi, dan memanggil handler", async () => {
    const onSort = vi.fn(), onPage = vi.fn();
    render(<DataTable {...base} rows={[{ name: "a", n: 1 }, { name: "b", n: 2 }]} total={25} page={2} pages={3} sort={{ key: "name", dir: "asc" }} onSort={onSort} onPage={onPage} actions={(r) => <button>Aksi {r.name}</button>} />);
    expect(screen.getByRole("table", { name: "Tabel uji" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Nama/ })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: "Jumlah" })).toHaveAttribute("aria-sort", "none");
    expect(screen.getByText("Menampilkan 11–20 dari 25")).toBeInTheDocument();
    expect(screen.getByText("Halaman 2 dari 3")).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "a" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Nama/ }));
    expect(onSort).toHaveBeenCalledWith("name");
    await userEvent.click(screen.getByRole("button", { name: /Berikutnya/ }));
    expect(onPage).toHaveBeenCalledWith(3);
    await userEvent.click(screen.getByRole("button", { name: /Sebelumnya/ }));
    expect(onPage).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "Aksi a" })).toBeInTheDocument();
  });
  it("status kosong, memuat, dan galat; tombol halaman nonaktif di ujung", () => {
    const { rerender } = render(<DataTable {...base} rows={[]} total={0} page={1} pages={1} onPage={() => undefined} empty="Kosong sekali" />);
    expect(screen.getByText("Kosong sekali")).toBeInTheDocument();
    expect(screen.getByText("Tidak ada data")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sebelumnya/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Berikutnya/ })).toBeDisabled();
    rerender(<DataTable {...base} rows={[]} total={0} page={1} pages={1} onPage={() => undefined} loading />);
    expect(screen.getByText("Memuat…")).toBeInTheDocument();
    rerender(<DataTable {...base} rows={[]} total={0} page={1} pages={1} onPage={() => undefined} error="Gagal memuat" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Gagal memuat");
  });
});

describe("FeaturesPage (kill switch)", () => {
  it("fitur yang mati di server tidak bisa dinyalakan; mematikan mengirim daftar killed", async () => {
    const flags = { effective: { voiceCalls: true, dataExport: false }, killed: [] as string[], names: ["voiceCalls", "dataExport"] };
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => (init?.method === "PATCH" ? json({ ...flags, effective: { voiceCalls: false, dataExport: false }, killed: JSON.parse(init.body as string).killed }) : json(flags)));
    render(<FeaturesPage />);
    expect(await screen.findByText("Mati di server")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nyalakan Ekspor data" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Matikan Panggilan suara" }));
    await waitFor(() => expect(screen.getByText("Dimatikan operator")).toBeInTheDocument());
    expect(bodyOf(calls("PATCH", "/api/admin/flags")[0]!)).toEqual({ killed: ["voiceCalls"] });
  });
});

const userRow = (over: object = {}) => ({ id: "u1", email: "budi@x.com", displayName: "Budi", role: "user", status: "active", deletionStatus: "none", createdAt: "2026-10-01T00:00:00Z", lastLoginAt: null, note: "", ageConfirmed: true, counts: { conversations: 2, messages: 10, memories: 3, tokens30d: 1234 }, ...over });

describe("UsersPage", () => {
  it("menampilkan tabel, memfilter lewat server, dan menangguhkan dari panel Kelola", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/admin/users?")) return json({ items: [userRow()], total: 1, page: 1, limit: 20, pages: 1 });
      if (url === "/api/admin/users/u1" && init?.method !== "PATCH") return json({ ...userRow(), activeSessions: 2, calls: 1, lastDeletionJob: null });
      if (url === "/api/admin/users/u1" && init?.method === "PATCH") return json(userRow({ status: "suspended" }));
      return json({}, 404);
    });
    render(<UsersPage actorRole="admin" selfId="me" />);
    expect(await screen.findByText("budi@x.com")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1.234" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "suspended");
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("status=suspended"))).toBe(true));
    await userEvent.click(await screen.findByRole("button", { name: "Kelola budi@x.com" }));
    const dlg = await screen.findByRole("dialog", { name: /Kelola budi@x.com/ });
    expect(await within(dlg).findByText("Sesi aktif")).toBeInTheDocument();
    expect(within(dlg).queryByLabelText("Peran")).toBeNull(); // pengubah peran hanya untuk pemilik
    await userEvent.click(within(dlg).getByRole("button", { name: "Tangguhkan" }));
    await waitFor(() => expect(calls("PATCH", "/api/admin/users/u1")).toHaveLength(1));
    expect(bodyOf(calls("PATCH", "/api/admin/users/u1")[0]!)).toEqual({ status: "suspended" });
  });

  it("akun sendiri dan pemilik dikunci; hapus butuh mengetik email", async () => {
    fetchMock.mockImplementation(async (url: string) => (url.startsWith("/api/admin/users?") ? json({ items: [userRow({ id: "me", email: "me@x.com", role: "owner" })], total: 1, page: 1, limit: 20, pages: 1 }) : json({ ...userRow({ id: "me", email: "me@x.com", role: "owner" }), activeSessions: 1, calls: 0, lastDeletionJob: null })));
    render(<UsersPage actorRole="owner" selfId="me" />);
    await userEvent.click(await screen.findByRole("button", { name: "Kelola me@x.com" }));
    const dlg = await screen.findByRole("dialog", { name: /Kelola me@x.com/ });
    expect(await within(dlg).findByText(/akunmu sendiri/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Tangguhkan" })).toBeDisabled();
    expect(within(dlg).getByRole("button", { name: "Hapus pengguna…" })).toBeDisabled();
  });
});

const siteView = () => ({
  value: { name: "Sawala", tagline: "t", supportEmail: "", defaultTheme: "terang", ui: { emptyLines: ["a", "b", "c"], disclaimer: "d" }, legal: { privacy: "", terms: "" }, safety: { crisisResourcesText: "" }, persona: { extraInstructions: "" },
    limits: { dailyMessageLimit: null, maxMessageChars: null, maxOutputTokens: null, callMaxMinutes: null, chatRetentionDays: null, dailyTokenBudgetGlobal: null, dailyTokenBudgetPerUser: null },
    costs: { inputPer1M: null, outputPer1M: null, currency: null }, alerts: { webhookUrl: "", minIntervalMinutes: null, errorRateThreshold: null }, voice: { safetyHoldMs: null },
    access: { registrationOpen: true, allowedEmailDomains: [], maintenance: { enabled: false, message: "pemeliharaan" } } },
  defaults: {}, meta: { updatedAt: null, updatedBy: null }, alertWebhookConfigured: false, crisisTextConfigured: false,
  effective: { "limits.dailyMessageLimit": { value: 200, envDefault: 200, source: "env" } },
});

describe("SettingsPage", () => {
  it("mengetik tidak kehilangan fokus, tombol simpan hanya aktif saat ada perubahan, dan mengirim nilai baru", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => (init?.method === "PUT" ? json({ ...siteView(), value: { ...siteView().value, name: JSON.parse(init.body as string).value.name } }) : json(siteView())));
    render(<SettingsPage />);
    const save = await screen.findByRole("button", { name: "Simpan pengaturan" });
    expect(save).toBeDisabled();
    const name = screen.getByLabelText("Nama situs") as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.type(name, "Teman Cerita");
    expect(name).toHaveFocus(); // tidak di-remount per ketukan
    expect(name.value).toBe("Teman Cerita");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(calls("PUT", "/api/admin/settings")).toHaveLength(1));
    expect(bodyOf(calls("PUT", "/api/admin/settings")[0]!).value.name).toBe("Teman Cerita");
    expect(await screen.findByText(/langsung berlaku/)).toBeInTheDocument();
  });

  it("galat validasi dari server ditandai pada kolom yang tepat", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => (init?.method === "PUT"
      ? json({ error: { code: "INVALID_SETTINGS", message: "Ada isian yang tidak valid.", retryable: false, fields: [{ path: "supportEmail", message: "Email tidak valid" }] } }, 400)
      : json(siteView())));
    render(<SettingsPage />);
    await userEvent.type(await screen.findByLabelText("Email dukungan"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Simpan pengaturan" }));
    expect(await screen.findAllByText("Email tidak valid")).not.toHaveLength(0);
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });
});

const provView = (over: object = {}) => ({
  capabilities: [
    { capability: "llm", provider: "openai", model: "m-1", source: "db", envProvider: "mock" },
    { capability: "embedding", provider: "mock", model: "", dimensions: 256, source: "env", envProvider: "mock" },
  ],
  keys: { gemini: { source: "none", masked: "" }, openai: { source: "db", masked: "••••9876" }, anthropic: { source: "env", masked: "••••abcd" } },
  encryptionConfigured: true, mockAllowed: true, options: { llm: ["gemini", "openai", "anthropic"], embedding: ["gemini", "openai"], stt: ["none"], tts: ["none"], realtime: ["none"] },
  meta: { updatedAt: null, updatedBy: null }, embeddingTag: "mock/mock/256", stale: { memories: 0, summaries: 0 }, reembed: { status: "idle", total: 0, done: 0, startedAt: null, finishedAt: null, startedBy: null }, ...over,
});

describe("ProvidersPage", () => {
  it("kunci hanya tampil dimask; admin non-pemilik tidak melihat tombol ubah", async () => {
    fetchMock.mockResolvedValue(json(provView()));
    const { unmount } = render(<ProvidersPage isOwner={false} />);
    expect(await screen.findByText("••••9876")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sk-/);
    expect(screen.queryByRole("button", { name: /Ubah/ })).toBeNull();
    expect(screen.getByText(/hanya pemilik yang boleh mengubahnya/)).toBeInTheDocument();
    unmount();
    fetchMock.mockResolvedValue(json(provView()));
    render(<ProvidersPage isOwner />);
    expect(await screen.findByRole("button", { name: "Ubah Model bahasa (chat)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hapus kunci OpenAI dari dasbor/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Hapus kunci Anthropic/ })).toBeNull(); // kunci dari env tidak bisa dihapus dari dasbor
  });

  it("mengganti embedding meminta konfirmasi eksplisit sebelum mengirim ulang dengan confirmEmbeddingChange", async () => {
    let first = true;
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const b = JSON.parse(init.body as string);
        if (!b.confirmEmbeddingChange && first) { first = false; return json({ error: { code: "EMBEDDING_CHANGE_NEEDS_CONFIRM", message: "konfirmasi", retryable: false } }, 409); }
        return json(provView({ embeddingTag: "openai/emb/256" }));
      }
      return json(provView());
    });
    render(<ProvidersPage isOwner />);
    await userEvent.click(await screen.findByRole("button", { name: "Ubah Embedding (memori & pencarian makna)" }));
    const dlg = await screen.findByRole("dialog", { name: /Ubah Embedding/ });
    await userEvent.selectOptions(within(dlg).getByLabelText("Provider"), "openai");
    await userEvent.type(within(dlg).getByLabelText(/Nama model/), "emb-uji");
    await userEvent.click(within(dlg).getByRole("button", { name: "Simpan" }));
    const confirm = await screen.findByRole("dialog", { name: "Ganti model embedding?" });
    expect(calls("PUT", "/api/admin/providers")).toHaveLength(1);
    await userEvent.click(within(confirm).getByRole("button", { name: "Ganti embedding" }));
    await waitFor(() => expect(calls("PUT", "/api/admin/providers")).toHaveLength(2));
    expect(bodyOf(calls("PUT", "/api/admin/providers")[1]!)).toMatchObject({ confirmEmbeddingChange: true, providers: { embedding: { provider: "openai", model: "emb-uji" } } });
  });

  it("menyimpan kunci: input bertipe password dan nilai dikirim sekali", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => json(provView()));
    render(<ProvidersPage isOwner />);
    await userEvent.click(await screen.findByRole("button", { name: "Isi kunci Google Gemini" }));
    const input = await screen.findByLabelText("Kunci API baru");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.type(input, "kunci-rahasia-123");
    await userEvent.click(screen.getByRole("button", { name: "Simpan kunci" }));
    await waitFor(() => expect(calls("PUT", "/api/admin/providers")).toHaveLength(1));
    expect(bodyOf(calls("PUT", "/api/admin/providers")[0]!)).toEqual({ keys: { gemini: "kunci-rahasia-123" } });
  });
});

describe("AdminApp (shell)", () => {
  it("navigasi antar bagian mengubah URL dan menandai halaman aktif; non-pemilik tetap bisa membuka semua tampilan", async () => {
    fetchMock.mockImplementation(async (url: string) => (url.startsWith("/api/admin/users") || url.startsWith("/api/admin/invites") ? json({ items: [], total: 0, page: 1, limit: 20, pages: 1 }) : url.startsWith("/api/admin/usage") ? json({ days: 1, currency: "USD", costNote: "", budget: {}, daily: [], models: [] }) : url.startsWith("/api/admin/flags") ? json({ effective: {}, killed: [], names: [] }) : json({})));
    window.history.pushState(null, "", "/admin");
    const user = { id: "me", email: "a@x.com", adminRole: "admin" } as unknown as User;
    render(<AdminApp user={user} siteName="Sawala" />);
    expect(await screen.findByRole("heading", { name: "Ringkasan" })).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Pengguna" }));
    expect(await screen.findByRole("heading", { name: "Pengguna" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/admin/users");
    expect(screen.getByRole("link", { name: "Pengguna" })).toHaveAttribute("aria-current", "page");
    await userEvent.click(screen.getByRole("link", { name: "Undangan" }));
    expect(await screen.findByRole("heading", { name: "Undangan" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/admin/invites");
    expect(screen.getByRole("link", { name: "Kembali ke aplikasi" })).toHaveAttribute("href", "/");
  });
});
