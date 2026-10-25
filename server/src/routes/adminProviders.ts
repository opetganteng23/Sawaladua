import { Router } from "express";
import { z } from "zod";
import { isProdEnv, validateProviders, type Config } from "../config.js";
import type { AppCtx } from "../context.js";
import { audit, requireAdminRole } from "../lib/adminAuth.js";
import { wrap, ApiError } from "../lib/http.js";
import { countStale, reembedStatus, startReembed } from "../lib/reembed.js";
import { embS, llmS, rtS, sttS, ttsS, VENDORS, type ProviderOverrides, type Vendor } from "../lib/siteSettings.js";
import { makeEmbedder, makeLlm, makeStt, makeTts } from "../llm/index.js";
import { pcm16ToWav } from "../llm/types.js";
import { sendFieldErrors } from "./adminSettings.js";
import { geminiLiveProvider } from "../voice/providers/geminiLive.js";
import { openaiRealtimeProvider } from "../voice/providers/openaiRealtime.js";
import { mockRealtimeProvider } from "../voice/providers/mock.js";

const CAPABILITIES = ["llm", "embedding", "stt", "tts", "realtime"] as const;
type Capability = (typeof CAPABILITIES)[number];
const OPTIONS: Record<Capability, string[]> = {
  llm: ["gemini", "openai", "anthropic"], embedding: ["gemini", "openai"], stt: ["none", "gemini", "openai"], tts: ["none", "gemini", "openai"], realtime: ["none", "gemini", "openai", "cascade"],
};

/**
 * Penggantian provider AI dari dasbor. Hanya PEMILIK (ADMIN_EMAILS) yang boleh mengubah/melihat status kunci.
 * Kunci disimpan terenkripsi (AES-256-GCM), tidak pernah dikembalikan utuh (hanya 4 karakter terakhir), dan tidak masuk log audit.
 * Base URL provider sengaja TIDAK bisa diubah dari dasbor (mencegah SSRF); hanya lewat env.
 */
export function adminProvidersRouter(ctx: AppCtx) {
  const r = Router();
  const owner = requireAdminRole(ctx, "owner");
  const anyAdmin = requireAdminRole(ctx, "admin");

  const capRow = (cap: Capability) => {
    const c = ctx.cfg, base = ctx.settings.base(), ov = ctx.settings.providerOverrides();
    const rows: Record<Capability, { provider: string; model: string; voice?: string; dimensions?: number; envProvider: string }> = {
      llm: { provider: c.LLM_PROVIDER, model: c.LLM_PROVIDER === "gemini" ? c.GEMINI_MODEL : c.LLM_PROVIDER === "openai" ? c.OPENAI_MODEL : c.LLM_PROVIDER === "anthropic" ? c.ANTHROPIC_MODEL : "", envProvider: base.LLM_PROVIDER },
      embedding: { provider: c.EMBEDDING_PROVIDER, model: c.EMBEDDING_PROVIDER === "gemini" ? c.GEMINI_EMBEDDING_MODEL : c.EMBEDDING_PROVIDER === "openai" ? c.OPENAI_EMBEDDING_MODEL : "", dimensions: c.EMBEDDING_DIMENSIONS, envProvider: base.EMBEDDING_PROVIDER },
      stt: { provider: c.STT_PROVIDER, model: c.STT_PROVIDER === "gemini" ? c.GEMINI_STT_MODEL : c.STT_PROVIDER === "openai" ? c.OPENAI_STT_MODEL : "", envProvider: base.STT_PROVIDER },
      tts: { provider: c.TTS_PROVIDER, model: c.TTS_PROVIDER === "gemini" ? c.GEMINI_TTS_MODEL : c.TTS_PROVIDER === "openai" ? c.OPENAI_TTS_MODEL : "", voice: c.TTS_PROVIDER === "gemini" ? c.GEMINI_TTS_VOICE : c.OPENAI_TTS_VOICE, envProvider: base.TTS_PROVIDER },
      realtime: { provider: c.REALTIME_PROVIDER, model: c.REALTIME_PROVIDER === "gemini" ? c.GEMINI_REALTIME_MODEL : c.REALTIME_PROVIDER === "openai" ? c.OPENAI_REALTIME_MODEL : "", voice: c.REALTIME_PROVIDER === "gemini" ? c.GEMINI_REALTIME_VOICE : c.OPENAI_REALTIME_VOICE, envProvider: base.REALTIME_PROVIDER },
    };
    return { capability: cap, ...rows[cap], source: ov[cap] ? "db" : "env" };
  };

  const view = async () => ({
    capabilities: CAPABILITIES.map(capRow),
    keys: ctx.settings.keyInfo(),
    encryptionConfigured: ctx.settings.encryption(),
    mockAllowed: !isProdEnv(ctx.cfg),
    options: OPTIONS,
    meta: ctx.settings.providersMeta(),
    embeddingTag: ctx.embedder.tag,
    stale: await countStale(ctx),
    reembed: await reembedStatus(ctx),
  });

  r.get("/admin/providers", anyAdmin, wrap(async (_req, res) => res.json(await view())));

  const patchSchema = z.object({
    providers: z.object({ llm: llmS.nullable().optional(), embedding: embS.nullable().optional(), stt: sttS.nullable().optional(), tts: ttsS.nullable().optional(), realtime: rtS.nullable().optional() }).strict().optional(),
    keys: z.object({ gemini: z.string().trim().min(8).max(500).nullable().optional(), openai: z.string().trim().min(8).max(500).nullable().optional(), anthropic: z.string().trim().min(8).max(500).nullable().optional() }).strict().optional(),
    confirmEmbeddingChange: z.boolean().optional(),
  }).strict();

  r.put("/admin/providers", owner, wrap(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return sendFieldErrors(res, "INVALID_PROVIDERS", "Ada isian yang tidak valid.", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const body = parsed.data;
    const keyPatch = (body.keys ?? {}) as Partial<Record<Vendor, string | null>>;
    if (Object.values(keyPatch).some((v) => typeof v === "string") && !ctx.settings.encryption())
      throw new ApiError(400, "ENCRYPTION_KEY_MISSING", "Menyimpan kunci API membutuhkan SETTINGS_ENCRYPTION_KEY di server (openssl rand -base64 32). Atau isi kunci lewat env.");

    // gabungkan per kemampuan; null = kembali ke bawaan env
    const next: ProviderOverrides = { ...ctx.settings.providerOverrides() };
    for (const cap of CAPABILITIES) {
      const v = body.providers?.[cap];
      if (v === null) delete next[cap];
      else if (v !== undefined) (next as Record<string, unknown>)[cap] = v;
    }
    const candidate: Config = ctx.settings.preview({ providers: next, keys: keyPatch });
    const errs = validateProviders(candidate);
    if (errs.length) return sendFieldErrors(res, "INVALID_PROVIDERS", "Konfigurasi provider belum valid.", errs.map((m) => ({ path: "providers", message: m })));

    const embeddingChanged = makeEmbedder(candidate).tag !== ctx.embedder.tag;
    if (embeddingChanged && !body.confirmEmbeddingChange)
      return void res.status(409).json({ error: { code: "EMBEDDING_CHANGE_NEEDS_CONFIRM", message: "Mengganti model embedding membuat memori dan ringkasan lama tidak dipakai sampai dihitung ulang. Konfirmasi untuk melanjutkan, lalu jalankan 'Hitung ulang embedding'.", retryable: false, requestId: res.locals.requestId } });

    const changedCaps = CAPABILITIES.filter((cap) => JSON.stringify(next[cap]) !== JSON.stringify(ctx.settings.providerOverrides()[cap]));
    if (changedCaps.length) await ctx.settings.saveProviders(next, req.user!.email);
    const changedKeys: string[] = [];
    for (const v of VENDORS) {
      const k = keyPatch[v];
      if (k === undefined) continue;
      await ctx.settings.setKey(v, k, req.user!.email);
      changedKeys.push(`${v}:${k === null ? "dihapus" : "diganti"}`); // hanya nama vendor dan aksi, TIDAK pernah nilainya
    }
    if (changedCaps.length || changedKeys.length) await audit(ctx, req, "providers.update", "providers", { capabilities: changedCaps, keys: changedKeys, embeddingChanged });
    res.json(await view());
  }));

  /** Uji koneksi dengan permintaan kecil dan sintetis. Memakai konfigurasi yang SEDANG berlaku, atau usulan (belum disimpan). */
  r.post("/admin/providers/test", owner, wrap(async (req, res) => {
    const body = z.object({
      capability: z.enum(CAPABILITIES),
      provider: z.object({ llm: llmS, embedding: embS, stt: sttS, tts: ttsS, realtime: rtS }).partial().strict().optional(),
      keys: z.object({ gemini: z.string().trim().min(8).max(500).optional(), openai: z.string().trim().min(8).max(500).optional(), anthropic: z.string().trim().min(8).max(500).optional() }).strict().optional(),
    }).strict().parse(req.body);
    const cfg = ctx.settings.preview({ providers: { ...ctx.settings.providerOverrides(), ...(body.provider ?? {}) }, keys: body.keys });
    const errs = validateProviders(cfg);
    if (errs.length) return void res.json({ ok: false, capability: body.capability, error: errs[0] });
    const t0 = Date.now();
    const ac = AbortSignal.timeout(15_000);
    try {
      let detail = "";
      if (body.capability === "llm") {
        const out = await makeLlm(cfg).generate({ system: "Balas dengan satu kata: ok", messages: [{ role: "user", text: "tes koneksi" }], maxOutputTokens: 16, signal: ac });
        detail = `balasan ${out.text.trim().length} karakter, token ${out.inputTokens}/${out.outputTokens}`;
      } else if (body.capability === "embedding") {
        const e = makeEmbedder(cfg);
        const [v] = await e.embed(["tes koneksi"]);
        detail = `dimensi ${v?.length ?? 0}`;
      } else if (body.capability === "stt") {
        const stt = makeStt(cfg);
        if (!stt) throw new Error("STT tidak dikonfigurasi");
        const t = await stt.transcribe(pcm16ToWav(Buffer.alloc(16000), 16000), "audio/wav", { language: "id-ID", signal: ac });
        detail = `transkrip ${t.text.length} karakter (audio uji hening)`;
      } else if (body.capability === "tts") {
        const tts = makeTts(cfg);
        if (!tts) throw new Error("TTS tidak dikonfigurasi");
        const a = await tts.synthesize("Halo", { language: "id-ID", signal: ac });
        detail = `audio ${a.audio.length} byte (${a.mime})`;
      } else {
        const p = cfg.REALTIME_PROVIDER === "gemini" ? geminiLiveProvider(cfg) : cfg.REALTIME_PROVIDER === "openai" ? openaiRealtimeProvider(cfg) : cfg.REALTIME_PROVIDER === "mock" ? mockRealtimeProvider() : null;
        if (!p) { detail = cfg.REALTIME_PROVIDER === "cascade" ? "mode cascade memakai STT/LLM/TTS: uji masing-masing" : "tidak ada provider realtime"; }
        else {
          const noop = { onAudio() {}, onSpeech() {}, onSpeechText() {}, onUserTranscript() {}, onAssistantTranscript() {}, onTurnComplete() {}, onInterrupted() {}, onUsage() {}, onError() {}, onClosed() {} };
          const s = await p.open({ instructions: "tes", language: "id-ID", bargeIn: false, signal: ac }, noop);
          s.close();
          detail = "sesi realtime berhasil dibuka dan ditutup";
        }
      }
      await audit(ctx, req, "providers.test", body.capability, { ok: true });
      res.json({ ok: true, capability: body.capability, ms: Date.now() - t0, detail });
    } catch (e) {
      // Pesan galat dari provider tidak diteruskan apa adanya (bisa memuat potongan permintaan); hanya kode status/nama aman.
      const m = (e as Error).message ?? "";
      const safe = /^(gemini|openai|anthropic)_http_\d{3}$/.test(m) ? m : (e as Error).name === "TimeoutError" ? "waktu habis (15 dtk)" : m === "llm_quota" ? "kuota/rate limit provider tercapai (429)" : /dimension|tidak dikonfigurasi/.test(m) ? m : "gagal tersambung";
      await audit(ctx, req, "providers.test", body.capability, { ok: false, reason: safe });
      res.json({ ok: false, capability: body.capability, ms: Date.now() - t0, error: safe });
    }
  }));

  r.post("/admin/reembed", owner, wrap(async (req, res) => {
    const out = await startReembed(ctx, req.user!.email);
    if (out.started) await audit(ctx, req, "embedding.reembed", "memories", { tag: ctx.embedder.tag });
    res.status(out.started ? 202 : 409).json({ ...out, status: await reembedStatus(ctx) });
  }));

  return r;
}
