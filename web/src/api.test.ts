import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiFail, streamChat, type StreamHandlers } from "./api";

const enc = new TextEncoder();
const streamOf = (chunks: string[]) =>
  new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });

const handlers = () => {
  const calls: string[] = [];
  const h: StreamHandlers = {
    onStarted: (d) => calls.push(`started:${d.conversationId}`),
    onBubbleStart: (i) => calls.push(`bs:${i}`),
    onBubbleEnd: (i) => calls.push(`be:${i}`),
    onDelta: (i, t) => calls.push(`d:${i}:${t}`),
    onMood: (m) => calls.push(`mood:${m}`),
    onError: (m, r) => calls.push(`err:${m}:${r}`),
    onDone: () => calls.push("done"),
  };
  return { h, calls };
};
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const body = { clientMessageId: "abcdefgh", text: "halo" };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("streamChat (parser SSE)", () => {
  it("mengurai event berurutan, termasuk event yang terpotong di tengah chunk", async () => {
    const full = [
      ev("message_started", { conversationId: "c1" }), ev("bubble_started", { bubbleIndex: 0 }),
      ev("bubble_delta", { bubbleIndex: 0, text: "Hai" }), ev("bubble_completed", { bubbleIndex: 0 }),
      ev("mood_updated", { mood: "hangat" }), ev("message_completed", { messageId: "m1" }),
    ].join("");
    const cut = Math.floor(full.length / 2) + 3; // potong di tengah event
    fetchMock.mockResolvedValue(streamOf([full.slice(0, cut), full.slice(cut)]));
    const { h, calls } = handlers();
    await streamChat(body, h, new AbortController().signal);
    expect(calls).toEqual(["started:c1", "bs:0", "d:0:Hai", "be:0", "mood:hangat", "done"]);
  });

  it("event error dari server diteruskan dengan flag retryable", async () => {
    fetchMock.mockResolvedValue(streamOf([ev("message_started", { conversationId: "c" }), ev("error", { userMessage: "Coba lagi", retryable: true })]));
    const { h, calls } = handlers();
    await streamChat(body, h, new AbortController().signal);
    expect(calls.at(-1)).toBe("err:Coba lagi:true");
    expect(calls).not.toContain("done");
  });

  it("stream terputus tanpa message_completed dilaporkan sebagai error yang bisa diulang", async () => {
    fetchMock.mockResolvedValue(streamOf([ev("message_started", { conversationId: "c" }), ev("bubble_started", { bubbleIndex: 0 })]));
    const { h, calls } = handlers();
    await streamChat(body, h, new AbortController().signal);
    expect(calls.at(-1)).toMatch(/^err:Koneksi terputus.*:true$/);
  });

  it("error HTTP sebelum stream (mis. 403 usia) memakai pesan server", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "AGE_CONFIRMATION_REQUIRED", message: "Konfirmasi usia", retryable: false } }), { status: 403 }));
    const { h, calls } = handlers();
    await streamChat(body, h, new AbortController().signal);
    expect(calls).toEqual(["err:Konfirmasi usia:false"]);
  });

  it("gagal jaringan dan abort ditangani berbeda", async () => {
    fetchMock.mockRejectedValue(new TypeError("network"));
    const a = handlers();
    await streamChat(body, a.h, new AbortController().signal);
    expect(a.calls[0]).toMatch(/^err:Tidak bisa terhubung.*:true$/);
    const ac = new AbortController();
    ac.abort();
    const b = handlers();
    await streamChat(body, b.h, ac.signal);
    expect(b.calls).toEqual([]); // dibatalkan pengguna: tidak ada error palsu
  });

  it("mengirim header CSRF dan credentials", async () => {
    fetchMock.mockResolvedValue(streamOf([ev("message_completed", {})]));
    await streamChat(body, handlers().h, new AbortController().signal);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({ "X-Requested-With": "sawala" });
  });
});

describe("api()", () => {
  it("melempar ApiFail dengan kode server; jaringan putus -> NETWORK retryable", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Tidak ada", retryable: false } }), { status: 404 }));
    await expect(api("GET", "/api/x")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND", message: "Tidak ada" });
    fetchMock.mockRejectedValueOnce(new TypeError("x"));
    const e = await api("GET", "/api/x").catch((x) => x as ApiFail);
    expect(e).toMatchObject({ code: "NETWORK", retryable: true });
  });
});
