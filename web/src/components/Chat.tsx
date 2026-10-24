import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat, type Conversation, type Features, type Mood, type Msg, type SearchHit, type SimilarHit, type User } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { MemoryPanel } from "./MemoryPanel";
import { SettingsPanel } from "./SettingsPanel";
import { CallView } from "./CallView";
import { RealtimeCall } from "./RealtimeCall";
import { AppShell } from "./chat/AppShell";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatHeader } from "./chat/ChatHeader";
import { ConversationSidebar } from "./chat/ConversationSidebar";
import { ErrorBanner } from "./chat/ErrorBanner";
import { MessageList } from "./chat/MessageList";
import { StatusMessage } from "./chat/StatusMessage";

interface Pending { clientMessageId: string; text: string; conversationId?: string }

export function Chat({ user, features, onUser, onMood, onLogout, onDeleted }: {
  user: User; features: Features; onUser: (u: User) => void; onMood: (m: Mood) => void; onLogout: () => void; onDeleted: (token: string) => void;
}) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [live, setLive] = useState<string[] | null>(null); // bubble yang sedang di-stream
  const [mood, setMood] = useState<Mood>("hangat");
  const [banner, setBanner] = useState<{ text: string; retry: boolean } | null>(null);
  const [greeting, setGreeting] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState<null | "memory" | "settings" | "call">(null);
  const [delConv, setDelConv] = useState<Conversation | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [convNext, setConvNext] = useState<string | null>(null);
  const [msgNext, setMsgNext] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pending = useRef<Pending | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;

  const loadConvs = useCallback(async () => {
    try {
      const r = await api<{ items: Conversation[]; nextBefore: string | null }>("GET", "/api/conversations?limit=30");
      setConvs(r.items); setConvNext(r.nextBefore);
    } catch { /* daftar gagal dimuat: tidak fatal */ }
  }, []);
  const moreConvs = async () => {
    if (!convNext) return;
    try {
      const r = await api<{ items: Conversation[]; nextBefore: string | null }>("GET", `/api/conversations?limit=30&before=${encodeURIComponent(convNext)}`);
      setConvs((c) => [...c, ...r.items]); setConvNext(r.nextBefore);
    } catch (e) { setBanner({ text: (e as Error).message, retry: false }); }
  };
  const loadMsgs = useCallback(async (id: string) => {
    try {
      const r = await api<{ items: Msg[]; nextBefore: string | null }>("GET", `/api/conversations/${id}/messages?limit=50`);
      setMsgs(r.items); setMsgNext(r.nextBefore);
    } catch (e) { setBanner({ text: (e as Error).message, retry: false }); }
  }, []);

  useEffect(() => {
    void loadConvs();
    api<{ mood: Mood }>("GET", "/api/mood").then((r) => { setMood(r.mood); onMood(r.mood); }).catch(() => undefined);
    if (features.proactiveGreeting && user.preferences.greeting.enabled)
      api<{ greeting: { text: string } | null }>("GET", "/api/greeting").then((r) => setGreeting(r.greeting?.text ?? null)).catch(() => undefined);
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (id: string | null) => {
    abort.current?.abort();
    setBusy(false); setLive(null); setBanner(null); setSidebar(false); setHits(null); setSimilar([]); setQ("");
    setActive(id); setMsgNext(null);
    if (id) void loadMsgs(id); else setMsgs([]);
  };

  const send = async (p: Pending) => {
    pending.current = p;
    setBanner(null); setBusy(true); setLive([]);
    const ac = new AbortController();
    abort.current = ac;
    let convId = p.conversationId ?? null;
    let failed = false;
    await streamChat({ conversationId: p.conversationId, clientMessageId: p.clientMessageId, text: p.text }, {
      onStarted: (d) => { convId = d.conversationId; if (!activeRef.current) setActive(d.conversationId); },
      onBubbleStart: (i) => setLive((l) => { const n = [...(l ?? [])]; n[i] = ""; return n; }),
      onDelta: (i, t) => setLive((l) => { const n = [...(l ?? [])]; n[i] = (n[i] ?? "") + t; return n; }),
      onMood: (m) => { setMood(m); onMood(m); },
      onError: (msg, retryable) => { failed = true; setBanner({ text: msg, retry: retryable }); },
      onDone: () => undefined,
    }, ac.signal);
    if (ac.signal.aborted) return;
    setBusy(false);
    setLive(null);
    if (convId) await loadMsgs(convId);
    if (!failed) pending.current = null;
    void loadConvs();
  };

  const submit = (t: string) => {
    if (busy) return;
    setMsgs((m) => [...m, { id: `tmp-${Date.now()}`, role: "user", text: t, bubbles: [t], status: "complete", mood: null, createdAt: new Date().toISOString() }]);
    void send({ clientMessageId: crypto.randomUUID(), text: t, conversationId: active ?? undefined });
  };

  const retry = () => { if (pending.current && !busy) void send(pending.current); };

  const olderMsgs = async () => {
    if (!active || !msgNext) return;
    try {
      const r = await api<{ items: Msg[]; nextBefore: string | null }>("GET", `/api/conversations/${active}/messages?limit=50&before=${encodeURIComponent(msgNext)}`);
      setMsgs((m) => [...r.items, ...m]); setMsgNext(r.nextBefore);
    } catch (e) { setBanner({ text: (e as Error).message, retry: false }); }
  };

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return setHits(null);
    try {
      const r = await api<{ results: SearchHit[]; similar?: SimilarHit[] }>("GET", `/api/search?q=${encodeURIComponent(q.trim())}&semantic=1`);
      setHits(r.results); setSimilar(r.similar ?? []);
    } catch (x) { setBanner({ text: (x as Error).message, retry: false }); }
  };

  const removeConv = async (c: Conversation) => {
    try { await api("DELETE", `/api/conversations/${c.id}`); if (active === c.id) open(null); await loadConvs(); setDelConv(null); }
    catch (e) { setBanner({ text: (e as Error).message, retry: false }); setDelConv(null); }
  };

  const showPanel = (p: "memory" | "settings" | "call") => { setPanel(p); setSidebar(false); };
  const onCallEnded = (kept: boolean) => { if (kept) void loadConvs(); };

  return (
    <AppShell>
      <ConversationSidebar
        open={sidebar} user={user} features={features} convs={convs} active={active} hasMore={Boolean(convNext)} q={q} hits={hits} similar={similar}
        onClose={() => setSidebar(false)} onNew={() => open(null)} onOpen={open} onDelete={setDelConv} onMore={moreConvs}
        onQuery={(v) => { setQ(v); if (!v) { setHits(null); setSimilar([]); } }} onSearch={search}
        onCall={() => showPanel("call")} onMemory={() => showPanel("memory")} onSettings={() => showPanel("settings")} onLogout={onLogout}
      />

      <section className="main" aria-label="Percakapan">
        <ChatHeader title={convs.find((c) => c.id === active)?.title ?? "Percakapan baru"} mood={mood} showMood={user.preferences.showMood} onOpenSidebar={() => setSidebar(true)} />
        {greeting && <StatusMessage text={greeting} onClose={() => setGreeting(null)} />}
        {banner && <ErrorBanner text={banner.text} retryable={banner.retry} onRetry={retry} onClose={() => setBanner(null)} />}
        <MessageList msgs={msgs} live={live} busy={busy} hasOlder={Boolean(msgNext)} onOlder={olderMsgs} />
        <ChatComposer busy={busy} onSend={submit} />
      </section>

      {panel === "call" && (features.realtimeVoice
        ? <RealtimeCall features={features} onClose={() => setPanel(null)} onEnded={onCallEnded} />
        : <CallView onClose={() => setPanel(null)} onEnded={onCallEnded} />)}
      {panel === "memory" && <MemoryPanel user={user} onUser={onUser} onClose={() => setPanel(null)} />}
      {panel === "settings" && <SettingsPanel user={user} features={features} onUser={onUser} onClose={() => setPanel(null)} onDeleted={onDeleted} />}
      {delConv && (
        <ConfirmDialog
          title="Hapus percakapan?" danger confirmLabel="Hapus" onCancel={() => setDelConv(null)} onConfirm={() => removeConv(delConv)}
          body={<>Seluruh pesan di &quot;{delConv.title}&quot; akan dihapus dan tidak bisa dikembalikan. Memori yang sudah tersimpan dari percakapan ini tetap ada, dan bisa kamu hapus sendiri di panel Memori.</>}
        />
      )}
    </AppShell>
  );
}
