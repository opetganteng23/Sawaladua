import { ObjectId } from "mongodb";
import { generatePlan, memoryCommand } from "../chat/orchestrator.js";
import { maybeSummarize } from "../chat/summary.js";
import type { AppCtx } from "../context.js";
import type { CallSessionDoc, ConversationDoc, MessageDoc, Mood, Strategy, UserDoc } from "../db.js";
import { sendAlert } from "../lib/alerts.js";
import { checkBudget } from "../lib/budget.js";
import { extractAndStore } from "../memory/service.js";
import { LlmQuotaError } from "../llm/types.js";
import { assessMessage, reviewedImminentResponse, type SafetyLevel } from "../safety/gate.js";

export async function loadHistory(ctx: AppCtx, user: UserDoc, convId: ObjectId, limit = 20): Promise<MessageDoc[]> {
  const rows = await ctx.d.c.messages.find({ userId: user._id, conversationId: convId, status: "complete" }).sort({ createdAt: -1 }).limit(limit).toArray();
  return rows.reverse();
}

export async function saveUserMessage(ctx: AppCtx, user: UserDoc, call: CallSessionDoc, text: string, level?: SafetyLevel) {
  const doc: Omit<MessageDoc, "_id"> = {
    userId: user._id, conversationId: call.conversationId, role: "user", text, status: "complete", channel: "call",
    safetyLevel: level, createdAt: new Date(),
  };
  const r = await ctx.d.c.messages.insertOne(doc as MessageDoc);
  await ctx.d.c.call_sessions.updateOne({ _id: call._id, userId: user._id }, { $set: { lastActivityAt: new Date() }, $inc: { turns: 1 } });
  return r.insertedId;
}

export async function saveAssistantMessage(
  ctx: AppCtx, user: UserDoc, call: CallSessionDoc, bubbles: string[], mood: Mood = "hangat", strategy?: Strategy, level?: SafetyLevel,
) {
  const text = bubbles.join("\n");
  if (!text.trim()) return;
  await ctx.d.c.messages.insertOne({
    userId: user._id, conversationId: call.conversationId, role: "assistant", text, bubbles, status: "complete", mood, strategy,
    channel: "call", safetyLevel: level, createdAt: new Date(),
  } as MessageDoc);
  await ctx.d.c.mood_state.updateOne({ userId: user._id }, { $set: { mood, updatedAt: new Date() } }, { upsert: true });
}

/** Ekstraksi memori setelah ucapan pengguna; hanya jika transkrip disetujui disimpan. Kegagalan tidak memengaruhi panggilan. */
export function scheduleExtraction(ctx: AppCtx, user: UserDoc, call: CallSessionDoc, recent: { role: "user" | "assistant"; text: string }[], sourceId: ObjectId) {
  if (!call.transcriptConsent) return;
  void extractAndStore(ctx, user, recent, [sourceId]).catch(() => undefined);
}

export async function finalizeCallSummary(ctx: AppCtx, user: UserDoc, call: CallSessionDoc) {
  if (!call.transcriptConsent) return;
  const conv = await ctx.d.c.conversations.findOne({ _id: call.conversationId, userId: user._id });
  if (conv) await maybeSummarize(ctx, user, conv as ConversationDoc).catch(() => undefined);
}

export class QuotaExhausted extends Error {
  constructor() { super("quota"); }
}

/**
 * Satu giliran bicara melalui jalur tervalidasi (sama dengan chat teks): safety gate, perintah memori, anggaran,
 * model, pemeriksa output, penyimpanan. Dipakai oleh mode cascade dan oleh relay setelah sesi native "terkunci" karena risiko.
 */
export async function voiceTurn(
  ctx: AppCtx, user: UserDoc, call: CallSessionDoc, conv: ConversationDoc, text: string, signal: AbortSignal,
): Promise<{ bubbles: string[]; level: SafetyLevel }> {
  const history = await loadHistory(ctx, user, conv._id);
  const level = assessMessage(text, history.filter((m) => m.role === "user").map((m) => m.text)).level;
  const userMsgId = await saveUserMessage(ctx, user, call, text, level);

  let bubbles: string[];
  let mood: Mood = "hangat";
  let strategy: Strategy = "listen";
  let skipExtraction = level >= 2;

  if (level >= 3) {
    bubbles = reviewedImminentResponse(ctx.cfg.CRISIS_RESOURCES_TEXT);
    strategy = "safety_support";
  } else {
    const cmd = level === 0 ? await memoryCommand(ctx, user, text, userMsgId) : null;
    if (cmd) ({ bubbles, mood, strategy, skipExtraction } = cmd);
    else {
      const budget = await checkBudget(ctx, user._id);
      if (budget !== "ok" && level >= 2) {
        bubbles = reviewedImminentResponse(ctx.cfg.CRISIS_RESOURCES_TEXT);
        strategy = "safety_support";
      } else if (budget !== "ok") {
        void sendAlert(ctx, "quota_exhausted", "warning", "anggaran token tercapai pada panggilan suara");
        throw new QuotaExhausted();
      } else {
        const started = Date.now();
        try {
          const r = await generatePlan(ctx, user, conv, history, text, level, "voice", signal, "call");
          ({ bubbles, mood, strategy, skipExtraction } = r.plan);
          await ctx.d.c.usage_events.insertOne({
            userId: user._id, requestId: `call-${call._id}`, provider: ctx.llm.name, model: ctx.llm.model, ...r.usage,
            latencyMs: Date.now() - started, status: "ok", createdAt: new Date(),
          } as never);
        } catch (e) {
          if (e instanceof LlmQuotaError) throw new QuotaExhausted();
          throw e;
        }
      }
    }
  }
  await saveAssistantMessage(ctx, user, call, bubbles, mood, strategy, level);
  if (!skipExtraction && level < 2) scheduleExtraction(ctx, user, call, [...history.slice(-4).map((m) => ({ role: m.role, text: m.text })), { role: "user", text }], userMsgId);
  return { bubbles, level };
}
