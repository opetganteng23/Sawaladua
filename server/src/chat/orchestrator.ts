import { ObjectId } from "mongodb";
import type { Request, Response } from "express";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import type { CallSessionDoc, ConversationDoc, MessageDoc, Mood, Strategy, UserDoc } from "../db.js";
import { oid } from "../db.js";
import { ApiError } from "../lib/http.js";
import { log } from "../lib/logger.js";
import { sendAlert } from "../lib/alerts.js";
import { recordOp } from "../lib/ops.js";
import { checkBudget, QUOTA_MESSAGE } from "../lib/budget.js";
import { finishCall } from "../lib/calls.js";
import { LlmQuotaError } from "../llm/types.js";
import {
  addExplicitMemory, deleteMemories, extractAndStore, findForgetTargets, memoryEnabled, retrieveMemories,
} from "../memory/service.js";
import { assessMessage, outputIsSafe, reviewedImminentResponse, safetyInstruction, type SafetyLevel } from "../safety/gate.js";
import { buildSystemPrompt, parseModelOutput, PROMPT_VERSION, type ModelOutput } from "./prompt.js";
import { contextSummaries, maybeSummarize } from "./summary.js";

export const chatBody = z
  .object({
    conversationId: z.string().optional(),
    clientMessageId: z.string().min(8).max(80),
    text: z.string().min(1),
    callId: z.string().optional(),
  })
  .strict();

const HISTORY_LIMIT = 20;
const MAX_LLM_ATTEMPTS = 2;

function sse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function timeHint(offsetMinutes: number): string {
  const h = new Date(Date.now() + offsetMinutes * 60_000).getUTCHours();
  return h < 4 ? "dini hari" : h < 11 ? "pagi" : h < 15 ? "siang" : h < 18 ? "sore" : "malam";
}

const REMEMBER_RE = /^\s*(?:tolong\s+)?(?:ingat(?:kan)?|catat)\s+(?:bahwa\s+|ya[,:]?\s+)?(.{3,250})$/i;
const FORGET_RE = /^\s*(?:tolong\s+)?(?:lupakan|lupain|hapus(?:kan)?\s+(?:ingatan|memori)|jangan\s+(?:ingat|simpan))\s*(.*)$/i;

export interface Plan {
  bubbles: string[];
  mood: Mood;
  strategy: Strategy;
  skipExtraction: boolean;
}

/** "Ingat/lupakan" lewat chat: deterministik, target divalidasi, ambigu -> tanya pengguna. */
export async function memoryCommand(ctx: AppCtx, user: UserDoc, text: string, msgId: ObjectId): Promise<Plan | null> {
  const rem = REMEMBER_RE.exec(text);
  const fog = FORGET_RE.exec(text);
  if (!rem && !fog) return null;
  const base = { mood: "hangat" as Mood, strategy: "clarify" as Strategy, skipExtraction: true };
  if (!memoryEnabled(ctx, user))
    return { ...base, bubbles: ["Memori jangka panjang sedang nonaktif, jadi aku tidak menyimpan atau mengubah apa pun.", "Kamu bisa menyalakannya di Pengaturan > Privasi kalau mau."] };
  if (rem) {
    const content = rem[1]!.trim().replace(/[.!\s]+$/, "");
    await addExplicitMemory(ctx, user, content, [msgId]);
    return { ...base, bubbles: [`Oke, aku simpan: "${content}".`, "Kamu bisa lihat atau ubah kapan saja di panel Memori."] };
  }
  const query = fog![1]!.replace(/^(soal|tentang|bahwa|yang)\s+/i, "").trim();
  const generic = !query || /^(itu|ini|tadi|semuanya?)$/i.test(query);
  const targets = generic ? [] : await findForgetTargets(ctx, user, query);
  const top = targets[0];
  if (top && ((top.sim >= 0.5 && (!targets[1] || top.sim - targets[1].sim >= 0.15)) || (targets.length === 1 && top.sim >= 0.35))) {
    await deleteMemories(ctx, user, [top.memory._id]);
    return { ...base, bubbles: [`Sudah kulupakan: "${top.memory.content}".`] };
  }
  if (targets.length) {
    const list = targets.slice(0, 3).map((t, i) => `${i + 1}. ${t.memory.content}`).join("\n");
    return { ...base, bubbles: ["Aku nemu beberapa yang mirip, dan nggak mau salah hapus:", list, "Kamu bisa hapus yang tepat dari panel Memori, atau sebutkan lebih spesifik."] };
  }
  return { ...base, bubbles: ["Aku belum nemu memori yang cocok untuk dilupakan.", "Kamu bisa cek daftar lengkapnya di panel Memori."] };
}

export async function generatePlan(
  ctx: AppCtx, user: UserDoc, conv: ConversationDoc, history: MessageDoc[], text: string,
  level: SafetyLevel, requestId: string, signal: AbortSignal, channel: "chat" | "call",
): Promise<{ plan: Plan; usage: { inputTokens: number; outputTokens: number } }> {
  const prefs = user.preferences;
  const moodDoc = await ctx.d.c.mood_state.findOne({ userId: user._id });
  const currentMood: Mood = level >= 1 ? "hangat" : moodDoc?.mood ?? "hangat";

  const recentUser = history.filter((m) => m.role === "user").slice(-2).map((m) => m.text).join(" ");
  const [{ items, conflict }, summaries] = await Promise.all([
    retrieveMemories(ctx, user, `${recentUser} ${text}`.slice(-1200), 5).catch(() => ({ items: [], conflict: null })), // retrieval gagal: lanjut tanpa memori
    contextSummaries(ctx, user, conv._id).catch(() => []),
  ]);
  // Memori krisis tidak disuntikkan pada level risiko; percakapan fokus pada keselamatan.
  const system = buildSystemPrompt({
    style: prefs.style,
    mood: currentMood,
    memories: level >= 2 ? [] : items.map((i) => i.memory.content),
    summaries: level >= 2 ? [] : summaries,
    conflict: level >= 2 || !conflict ? null : [conflict[0].content, conflict[1].content],
    timeHint: timeHint(prefs.greeting.utcOffsetMinutes),
    safetyInstruction: safetyInstruction(level),
    channel,
  });
  log("info", { event: "context_built", requestId, retrieved: items.length, promptVersion: PROMPT_VERSION });

  const messages = history.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, text: m.text.slice(0, 1500) }));
  messages.push({ role: "user", text });

  let usage = { inputTokens: 0, outputTokens: 0 };
  let parsed: ModelOutput | null = null;
  for (let attempt = 0; attempt < MAX_LLM_ATTEMPTS && !parsed; attempt++) {
    let r;
    try {
      r = await ctx.llm.generate({ system, messages, maxOutputTokens: ctx.cfg.MAX_OUTPUT_TOKENS, json: true, signal });
    } catch (e) {
      // Pengguna berisiko tidak boleh dibiarkan tanpa jawaban hanya karena kuota provider habis.
      if (e instanceof LlmQuotaError && level >= 2) {
        return { plan: { bubbles: reviewedImminentResponse(ctx.cfg.CRISIS_RESOURCES_TEXT), mood: "hangat", strategy: "safety_support", skipExtraction: true }, usage };
      }
      throw e;
    }
    usage = { inputTokens: usage.inputTokens + r.inputTokens, outputTokens: usage.outputTokens + r.outputTokens };
    parsed = parseModelOutput(r.text);
    if (parsed && !outputIsSafe(parsed.bubbles, level)) parsed = null;
  }
  if (!parsed) {
    recordOp(ctx, "output_invalid");
    // Fallback aman saat keluaran model tidak valid.
    const bubbles = level >= 2
      ? reviewedImminentResponse(ctx.cfg.CRISIS_RESOURCES_TEXT)
      : ["Maaf, aku agak kesulitan merangkai jawaban barusan. Boleh coba kirim lagi atau ceritakan dengan cara lain?"];
    return { plan: { bubbles, mood: "hangat", strategy: level >= 2 ? "safety_support" : "clarify", skipExtraction: true }, usage };
  }
  // Batasan backend atas pilihan model.
  let mood = parsed.mood;
  let strategy = parsed.response_strategy;
  if (level >= 1 && (mood === "ceria" || mood === "playful")) mood = "hangat";
  if (level >= 2) { mood = "hangat"; strategy = "safety_support"; }
  else if (strategy === "safety_support") strategy = "listen";
  return { plan: { bubbles: parsed.bubbles, mood, strategy, skipExtraction: level >= 2 }, usage };
}

export async function handleChat(ctx: AppCtx, req: Request, res: Response) {
  const user = req.user!;
  const requestId = res.locals.requestId as string;
  const body = chatBody.parse(req.body);
  const text = body.text.trim();
  if (!text) throw new ApiError(400, "EMPTY_MESSAGE", "Pesan tidak boleh kosong.");
  if (text.length > ctx.cfg.MAX_MESSAGE_CHARS)
    throw new ApiError(413, "MESSAGE_TOO_LONG", `Pesan maksimal ${ctx.cfg.MAX_MESSAGE_CHARS} karakter.`);

  if (!user.ageConfirmedAt) throw new ApiError(403, "AGE_CONFIRMATION_REQUIRED", "Konfirmasi usia 18+ diperlukan sebelum mengobrol.");
  let call: CallSessionDoc | null = null;
  if (body.callId) {
    if (!ctx.flags.get().voiceCalls) throw new ApiError(404, "FEATURE_DISABLED", "Panggilan suara belum tersedia.");
    const cid = oid(body.callId);
    call = cid ? await ctx.d.c.call_sessions.findOne({ _id: cid, userId: user._id, status: "active" }) : null;
    if (!call) throw new ApiError(404, "CALL_NOT_ACTIVE", "Panggilan sudah berakhir.");
    if (Date.now() - call.startedAt.getTime() > ctx.cfg.CALL_MAX_MINUTES * 60_000) {
      await finishCall(ctx, call, "max_duration");
      throw new ApiError(410, "CALL_EXPIRED", "Durasi maksimum panggilan tercapai. Kamu bisa memulai panggilan baru.");
    }
  }
  const channel: "chat" | "call" = call ? "call" : "chat";
  const conversationIdInput = call ? String(call.conversationId) : body.conversationId;

  const since = new Date(Date.now() - 864e5);
  const used = await ctx.d.c.messages.countDocuments({ userId: user._id, role: "user", createdAt: { $gte: since } });
  if (used >= ctx.cfg.DAILY_MESSAGE_LIMIT)
    throw new ApiError(429, "DAILY_LIMIT", "Batas pesan harian tercapai. Coba lagi besok ya.");

  // Percakapan: harus milik pengguna ini.
  let conv: ConversationDoc | null;
  if (conversationIdInput) {
    const id = oid(conversationIdInput);
    conv = id ? await ctx.d.c.conversations.findOne({ _id: id, userId: user._id, deletedAt: null }) : null;
    if (!conv) throw new ApiError(404, "NOT_FOUND", "Percakapan tidak ditemukan.");
  } else {
    const now = new Date();
    const ephemeral = !user.privacySettings.saveHistory;
    const doc: Omit<ConversationDoc, "_id"> = {
      userId: user._id, title: text.slice(0, 40), createdAt: now, updatedAt: now, deletedAt: null,
      ephemeral, expiresAt: ephemeral ? new Date(now.getTime() + 864e5) : null,
    };
    const r = await ctx.d.c.conversations.insertOne(doc as ConversationDoc);
    conv = { ...doc, _id: r.insertedId } as ConversationDoc;
  }

  // Idempotensi: retry dengan clientMessageId yang sama tidak menggandakan pesan.
  let userMsg = await ctx.d.c.messages.findOne({ userId: user._id, conversationId: conv._id, role: "user", clientMessageId: body.clientMessageId });
  let replay: MessageDoc | null = null;
  if (userMsg) {
    replay = await ctx.d.c.messages.findOne({ userId: user._id, conversationId: conv._id, role: "assistant", createdAt: { $gt: userMsg.createdAt }, status: "complete" }, { sort: { createdAt: 1 } });
  } else {
    const doc: Omit<MessageDoc, "_id"> = {
      userId: user._id, conversationId: conv._id, role: "user", text, status: "complete", channel,
      clientMessageId: body.clientMessageId, createdAt: new Date(),
    };
    const r = await ctx.d.c.messages.insertOne(doc as MessageDoc);
    userMsg = { ...doc, _id: r.insertedId } as MessageDoc;
  }

  res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const ac = new AbortController();
  let clientGone = false;
  res.on("close", () => { if (!res.writableEnded) { clientGone = true; ac.abort(); } });
  const started = Date.now();
  sse(res, "message_started", { requestId, conversationId: String(conv._id), userMessageId: String(userMsg._id) });

  const streamBubbles = async (bubbles: string[], sent: string[]) => {
    for (let i = 0; i < bubbles.length; i++) {
      if (clientGone) return false;
      sse(res, "bubble_started", { bubbleIndex: i });
      const b = bubbles[i]!;
      for (let p = 0; p < b.length; p += 24) sse(res, "bubble_delta", { bubbleIndex: i, text: b.slice(p, p + 24) });
      sse(res, "bubble_completed", { bubbleIndex: i });
      sent.push(b);
    }
    return true;
  };

  try {
    if (replay) {
      const sent: string[] = [];
      await streamBubbles(replay.bubbles ?? [replay.text], sent);
      if (replay.mood) sse(res, "mood_updated", { mood: replay.mood });
      sse(res, "message_completed", { messageId: String(replay._id), replayed: true });
      return res.end();
    }

    const history = await ctx.d.c.messages
      .find({ userId: user._id, conversationId: conv._id, _id: { $ne: userMsg._id }, status: "complete" })
      .sort({ createdAt: -1 }).limit(HISTORY_LIMIT).toArray();
    history.reverse();

    const assessment = assessMessage(text, history.filter((m) => m.role === "user").map((m) => m.text));
    const level = assessment.level;
    log("info", { event: "safety_assessed", requestId, status: String(level) });
    if (level >= 1) recordOp(ctx, `safety_level_${level}`);

    let plan: Plan;
    let usage = { inputTokens: 0, outputTokens: 0 };
    if (level >= 3) {
      plan = { bubbles: reviewedImminentResponse(ctx.cfg.CRISIS_RESOURCES_TEXT), mood: "hangat", strategy: "safety_support", skipExtraction: true };
    } else {
      const cmd = level === 0 ? await memoryCommand(ctx, user, text, userMsg._id) : null;
      if (cmd) plan = cmd;
      else {
        const budget = await checkBudget(ctx, user._id);
        if (budget !== "ok" && level >= 2) {
          plan = { bubbles: reviewedImminentResponse(ctx.cfg.CRISIS_RESOURCES_TEXT), mood: "hangat", strategy: "safety_support", skipExtraction: true };
        } else if (budget !== "ok") {
          throw new LlmQuotaError();
        } else {
          const timeout = setTimeout(() => ac.abort(), ctx.cfg.LLM_TIMEOUT_MS);
          try {
            ({ plan, usage } = await generatePlan(ctx, user, conv, history, text, level, requestId, ac.signal, channel));
          } finally {
            clearTimeout(timeout);
          }
        }
      }
    }

    const sent: string[] = [];
    const finished = await streamBubbles(plan.bubbles, sent);
    if (!finished) recordOp(ctx, "stream_disconnect");
    const assistant: Omit<MessageDoc, "_id"> = {
      userId: user._id, conversationId: conv._id, role: "assistant", text: (finished ? plan.bubbles : sent).join("\n"),
      bubbles: finished ? plan.bubbles : sent, status: finished ? "complete" : "incomplete", mood: plan.mood, strategy: plan.strategy,
      channel, safetyLevel: level, createdAt: new Date(),
    };
    const saved = await ctx.d.c.messages.insertOne(assistant as MessageDoc);
    await ctx.d.c.conversations.updateOne(
      { _id: conv._id, userId: user._id },
      { $set: { updatedAt: new Date(), ...(conv.ephemeral ? { expiresAt: new Date(Date.now() + 864e5) } : {}) } },
    );
    await ctx.d.c.mood_state.updateOne({ userId: user._id }, { $set: { mood: plan.mood, updatedAt: new Date() } }, { upsert: true });
    await ctx.d.c.usage_events.insertOne({
      userId: user._id, requestId, provider: ctx.llm.name, model: ctx.llm.model, ...usage,
      latencyMs: Date.now() - started, status: finished ? "ok" : "client_disconnected", createdAt: new Date(),
    } as never);

    if (call) await ctx.d.c.call_sessions.updateOne({ _id: call._id, userId: user._id }, { $set: { lastActivityAt: new Date() }, $inc: { turns: 1 } });
    if (finished) {
      if (!user.preferences.showMood) sse(res, "message_completed", { messageId: String(saved.insertedId), usage });
      else {
        sse(res, "mood_updated", { mood: plan.mood });
        sse(res, "message_completed", { messageId: String(saved.insertedId), usage });
      }
      res.end();
      if (!plan.skipExtraction && !conv.ephemeral) {
        const recent = [...history.slice(-4).map((m) => ({ role: m.role, text: m.text })), { role: "user" as const, text }];
        void extractAndStore(ctx, user, recent, [userMsg._id]).then(() => maybeSummarize(ctx, user, conv!));
      }
    }
  } catch (err) {
    if (err instanceof LlmQuotaError) {
      log("warn", { event: "quota_exhausted", requestId });
      void sendAlert(ctx, "quota_exhausted", "warning", "batas kuota provider atau anggaran token tercapai; pengguna menerima pesan batas penggunaan");
      if (!clientGone && !res.writableEnded) {
        sse(res, "error", { code: "QUOTA_EXHAUSTED", userMessage: QUOTA_MESSAGE, retryable: false, requestId });
        res.end();
      }
      return;
    }
    const aborted = clientGone || ac.signal.aborted;
    log("error", { event: "chat_failed", requestId, code: aborted ? "ABORTED" : "PROVIDER_ERROR" });
    await ctx.d.c.messages.insertOne({
      userId: user._id, conversationId: conv._id, role: "assistant", text: "", status: "failed", channel, createdAt: new Date(),
    } as MessageDoc).catch(() => undefined);
    if (!clientGone && !res.writableEnded) {
      // Pesan pengguna sudah tersimpan (insert di atas berhasil) sehingga klaim ini akurat.
      sse(res, "error", { code: "PROVIDER_UNAVAILABLE", userMessage: "Sawala sedang kesulitan merespons. Pesanmu sudah tersimpan, coba kirim ulang sebentar lagi.", retryable: true, requestId });
      res.end();
    }
    void err;
  }
}
