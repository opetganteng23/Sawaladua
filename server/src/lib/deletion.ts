import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import type { AppCtx } from "../context.js";
import type { DeletionJobDoc } from "../db.js";
import { sendAlert } from "./alerts.js";
import { recordOp } from "./ops.js";
import { log } from "./logger.js";

const STEP_NAMES = ["revoke_sessions", "calls", "messages", "summaries", "memories", "mood_state", "conversations", "usage_events", "user_record"] as const;

export const DELETION_NOTICE =
  "Data aktif dihapus dari database utama Sawala. Salinan di backup dan sistem pihak ketiga mengikuti jadwal retensi di kebijakan privasi dan tidak langsung hilang.";

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function requestDeletion(ctx: AppCtx, userId: ObjectId) {
  const existing = await ctx.d.c.deletion_jobs.findOne({ userId, status: { $in: ["pending", "running"] } });
  const token = randomBytes(24).toString("base64url");
  if (existing) {
    await ctx.d.c.deletion_jobs.updateOne({ _id: existing._id }, { $set: { tokenHash: sha(token) } });
    return { jobId: existing._id, token };
  }
  await ctx.d.c.users.updateOne({ _id: userId }, { $set: { deletionStatus: "deletion_pending" } });
  const job: Omit<DeletionJobDoc, "_id"> = {
    userId, status: "pending", requestedAt: new Date(), completedAt: null, note: "",
    tokenHash: sha(token), steps: STEP_NAMES.map((name) => ({ name, status: "pending", at: null })),
  };
  const r = await ctx.d.c.deletion_jobs.insertOne(job as DeletionJobDoc);
  return { jobId: r.insertedId, token };
}

/** Idempoten dan dapat dilanjutkan: langkah yang sudah selesai dilewati, kegagalan bisa diulang. */
export async function runDeletionJob(ctx: AppCtx, jobId: ObjectId): Promise<DeletionJobDoc | null> {
  const { c } = ctx.d;
  const job = await c.deletion_jobs.findOne({ _id: jobId });
  if (!job || job.status === "completed") return job;
  await c.deletion_jobs.updateOne({ _id: jobId }, { $set: { status: "running" } });
  const userId = job.userId;
  const actions: Record<(typeof STEP_NAMES)[number], () => Promise<unknown>> = {
    revoke_sessions: () => c.sessions.deleteMany({ userId }),
    calls: () => c.call_sessions.deleteMany({ userId }),
    messages: () => c.messages.deleteMany({ userId }),
    summaries: () => c.session_summaries.deleteMany({ userId }),
    memories: () => c.memories.deleteMany({ userId }),
    mood_state: () => c.mood_state.deleteMany({ userId }),
    conversations: () => c.conversations.deleteMany({ userId }),
    usage_events: () => c.usage_events.deleteMany({ userId }),
    user_record: () => c.users.deleteOne({ _id: userId }),
  };
  let failed = false;
  for (const step of job.steps) {
    if (step.status === "done") continue;
    try {
      await actions[step.name as (typeof STEP_NAMES)[number]]();
      await c.deletion_jobs.updateOne({ _id: jobId, "steps.name": step.name }, { $set: { "steps.$.status": "done", "steps.$.at": new Date() } });
    } catch {
      failed = true;
      await c.deletion_jobs.updateOne({ _id: jobId, "steps.name": step.name }, { $set: { "steps.$.status": "failed", "steps.$.at": new Date() } });
      log("error", { event: "deletion_step_failed", step: step.name });
      recordOp(ctx, "deletion_step_failed");
      void sendAlert(ctx, "deletion_failed", "critical", `langkah penghapusan akun "${step.name}" gagal; akan dicoba ulang otomatis`);
      break;
    }
  }
  // Proses asinkron lain (ekstraksi/ringkasan) bisa menulis setelah langkah koleksi selesai; sapu ulang sebelum menyatakan selesai.
  if (!failed) {
    await Promise.all([c.messages.deleteMany({ userId }), c.memories.deleteMany({ userId }), c.session_summaries.deleteMany({ userId }), c.conversations.deleteMany({ userId })]);
  }
  await c.deletion_jobs.updateOne(
    { _id: jobId },
    { $set: failed ? { status: "failed" } : { status: "completed", completedAt: new Date() } },
  );
  return c.deletion_jobs.findOne({ _id: jobId });
}

export async function resumePendingDeletions(ctx: AppCtx) {
  const jobs = await ctx.d.c.deletion_jobs.find({ status: { $in: ["pending", "running", "failed"] } }).limit(50).toArray();
  for (const j of jobs) await runDeletionJob(ctx, j._id);
}

export function jobView(j: DeletionJobDoc) {
  return {
    status: j.status,
    requestedAt: j.requestedAt,
    completedAt: j.completedAt,
    steps: j.steps.map((s) => ({ name: s.name, status: s.status })),
    notice: DELETION_NOTICE,
  };
}

/** Percakapan sementara (saveHistory=false) yang kedaluwarsa dihapus beserta pesannya. */
export async function sweepEphemeral(ctx: AppCtx) {
  const { c } = ctx.d;
  const old = await c.conversations.find({ ephemeral: true, expiresAt: { $lt: new Date() } }).limit(200).toArray();
  for (const conv of old) {
    await c.messages.deleteMany({ userId: conv.userId, conversationId: conv._id });
    await c.session_summaries.deleteMany({ userId: conv.userId, conversationId: conv._id });
    await c.conversations.deleteOne({ _id: conv._id, userId: conv.userId });
  }
  return old.length;
}
