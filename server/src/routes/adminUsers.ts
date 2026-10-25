import { Router } from "express";
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import { oid, type UserDoc } from "../db.js";
import { adminRoleOf, adminSet, audit, escapeRegex, pageOf, pageQuery, requireAdminRole } from "../lib/adminAuth.js";
import { finishCall } from "../lib/calls.js";
import { jobView, requestDeletion, runDeletionJob } from "../lib/deletion.js";
import { ApiError, wrap } from "../lib/http.js";

const SORTS = { createdAt: "createdAt", email: "email", lastLoginAt: "lastLoginAt" } as const;

/**
 * CRUD pengguna untuk admin. PRINSIP: admin mengelola AKUN, bukan isi percakapan. Tidak ada endpoint yang
 * mengembalikan pesan, memori, atau ringkasan; hanya hitungan agregat dan metadata akun.
 */
export function adminUsersRouter(ctx: AppCtx) {
  const r = Router();
  const { c } = ctx.d;
  r.use("/admin/users", requireAdminRole(ctx, "admin"));
  r.use("/admin/invites", requireAdminRole(ctx, "admin"));

  const rowOf = (u: UserDoc, counts?: { conversations: number; messages: number; memories: number; tokens30d: number }) => {
    const role = adminRoleOf(ctx, u);
    return {
      id: String(u._id), email: u.email, displayName: u.displayName, provider: u.authProvider,
      role: role ?? "user", status: u.status ?? "active", deletionStatus: u.deletionStatus,
      createdAt: u.createdAt, lastLoginAt: u.lastLoginAt ?? null, suspendedAt: u.suspendedAt ?? null, note: u.adminNote ?? "",
      onboardingDone: u.onboardingDone, ageConfirmed: Boolean(u.ageConfirmedAt),
      ...(counts ? { counts } : {}),
    };
  };

  async function countsFor(ids: ObjectId[]) {
    const since = new Date(Date.now() - 30 * 864e5);
    const group = (col: { aggregate: (p: object[]) => { toArray(): Promise<{ _id: ObjectId; n: number }[]> } }) =>
      col.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: "$userId", n: { $sum: 1 } } }]).toArray();
    const [conv, msg, mem, tok] = await Promise.all([
      group(c.conversations as never), group(c.messages as never), group(c.memories as never),
      c.usage_events.aggregate<{ _id: ObjectId; n: number }>([
        { $match: { userId: { $in: ids }, createdAt: { $gte: since } } },
        { $group: { _id: "$userId", n: { $sum: { $add: ["$inputTokens", "$outputTokens"] } } } },
      ]).toArray(),
    ]);
    const m = (rows: { _id: ObjectId; n: number }[]) => new Map(rows.map((x) => [String(x._id), x.n]));
    const [mc, mm, mmem, mt] = [m(conv), m(msg), m(mem), m(tok)];
    return (id: ObjectId) => ({ conversations: mc.get(String(id)) ?? 0, messages: mm.get(String(id)) ?? 0, memories: mmem.get(String(id)) ?? 0, tokens30d: mt.get(String(id)) ?? 0 });
  }

  r.get("/admin/users", wrap(async (req, res) => {
    const q = pageQuery.extend({
      sort: z.enum(["createdAt", "email", "lastLoginAt"]).default("createdAt"),
      status: z.enum(["active", "suspended"]).optional(),
      role: z.enum(["owner", "admin", "user"]).optional(),
    }).parse(req.query);
    const owners = [...adminSet(ctx)];
    const and: Filter<UserDoc>[] = [];
    if (q.q) and.push({ $or: [{ email: { $regex: escapeRegex(q.q), $options: "i" } }, { displayName: { $regex: escapeRegex(q.q), $options: "i" } }] });
    if (q.status === "suspended") and.push({ status: "suspended" });
    if (q.status === "active") and.push({ status: { $ne: "suspended" } });
    if (q.role === "owner") and.push({ email: { $in: owners } });
    if (q.role === "admin") and.push({ role: "admin", email: { $nin: owners } });
    if (q.role === "user") and.push({ role: { $ne: "admin" }, email: { $nin: owners } });
    const filter: Filter<UserDoc> = and.length ? { $and: and } : {};
    const total = await c.users.countDocuments(filter);
    const rows = await c.users.find(filter).sort({ [SORTS[q.sort]]: q.dir === "asc" ? 1 : -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).toArray();
    const counts = rows.length ? await countsFor(rows.map((u) => u._id)) : () => ({ conversations: 0, messages: 0, memories: 0, tokens30d: 0 });
    res.json({ items: rows.map((u) => rowOf(u, counts(u._id))), ...pageOf(total, q.page, q.limit) });
  }));

  const target = async (id: string) => {
    const _id = oid(id);
    const u = _id ? await c.users.findOne({ _id }) : null;
    if (!u) throw new ApiError(404, "NOT_FOUND", "Pengguna tidak ditemukan.");
    return u;
  };

  r.get("/admin/users/:id", wrap(async (req, res) => {
    const u = await target(String(req.params.id));
    const counts = await countsFor([u._id]);
    const [sessions, calls, lastJob] = await Promise.all([
      c.sessions.countDocuments({ userId: u._id, expiresAt: { $gt: new Date() } }),
      c.call_sessions.countDocuments({ userId: u._id }),
      c.deletion_jobs.findOne({ userId: u._id }, { sort: { requestedAt: -1 }, projection: { status: 1, requestedAt: 1 } }),
    ]);
    res.json({ ...rowOf(u, counts(u._id)), activeSessions: sessions, calls, lastDeletionJob: lastJob ? { status: lastJob.status, requestedAt: lastJob.requestedAt } : null });
  }));

  r.patch("/admin/users/:id", wrap(async (req, res) => {
    const body = z.object({
      status: z.enum(["active", "suspended"]).optional(),
      role: z.enum(["user", "admin"]).optional(),
      displayName: z.string().trim().min(1).max(80).optional(),
      note: z.string().trim().max(200).optional(),
    }).strict().refine((b) => Object.keys(b).length > 0, "Tidak ada perubahan").parse(req.body);
    const u = await target(String(req.params.id));
    const actorRole = res.locals.adminRole as "owner" | "admin";
    const targetRole = adminRoleOf(ctx, u);
    const self = String(u._id) === String(req.user!._id);
    const sensitive = body.status !== undefined || body.role !== undefined;

    if (targetRole === "owner" && (sensitive || body.displayName !== undefined)) throw new ApiError(403, "OWNER_PROTECTED", "Pemilik layanan (ADMIN_EMAILS) hanya bisa diubah lewat konfigurasi server.");
    if (self && sensitive) throw new ApiError(400, "SELF_PROTECTED", "Kamu tidak bisa mengubah status atau peran akunmu sendiri.");
    if (targetRole === "admin" && actorRole !== "owner") throw new ApiError(403, "OWNER_REQUIRED", "Hanya pemilik yang boleh mengubah admin lain.");
    if (body.role !== undefined && actorRole !== "owner") throw new ApiError(403, "OWNER_REQUIRED", "Hanya pemilik yang boleh mengubah peran.");

    const $set: Record<string, unknown> = {};
    const changed: string[] = [];
    if (body.displayName !== undefined) { $set.displayName = body.displayName; changed.push("displayName"); }
    if (body.note !== undefined) { $set.adminNote = body.note; changed.push("note"); }
    if (body.role !== undefined) { $set.role = body.role; changed.push(`role=${body.role}`); }
    if (body.status === "suspended") { $set.status = "suspended"; $set.suspendedAt = new Date(); changed.push("status=suspended"); }
    if (body.status === "active") { $set.status = "active"; $set.suspendedAt = null; changed.push("status=active"); }
    await c.users.updateOne({ _id: u._id }, { $set });

    if (body.status === "suspended") {
      await c.sessions.deleteMany({ userId: u._id }); // keluarkan dari semua perangkat
      for (const call of await c.call_sessions.find({ userId: u._id, status: "active" }).toArray()) await finishCall(ctx, call, "user");
    }
    await audit(ctx, req, body.status ? `user.${body.status === "suspended" ? "suspend" : "restore"}` : body.role ? "user.role" : "user.update", u.email, { changed });
    res.json(rowOf((await c.users.findOne({ _id: u._id }))!));
  }));

  r.post("/admin/users/:id/revoke-sessions", wrap(async (req, res) => {
    const u = await target(String(req.params.id));
    if (adminRoleOf(ctx, u) === "owner" && String(u._id) !== String(req.user!._id)) throw new ApiError(403, "OWNER_PROTECTED", "Sesi pemilik layanan tidak bisa dicabut dari sini.");
    const del = await c.sessions.deleteMany({ userId: u._id });
    await audit(ctx, req, "user.revoke_sessions", u.email, { revoked: del.deletedCount });
    res.json({ ok: true, revoked: del.deletedCount });
  }));

  // Hapus pengguna = menjalankan workflow penghapusan yang sama dengan hapus akun mandiri (data aktif dihapus, status dapat dipantau).
  r.delete("/admin/users/:id", wrap(async (req, res) => {
    const { confirmEmail } = z.object({ confirmEmail: z.string().trim().toLowerCase() }).strict().parse(req.body);
    const u = await target(String(req.params.id));
    const actorRole = res.locals.adminRole as "owner" | "admin";
    const targetRole = adminRoleOf(ctx, u);
    if (confirmEmail !== u.email) throw new ApiError(400, "CONFIRM_MISMATCH", "Email konfirmasi tidak cocok.");
    if (String(u._id) === String(req.user!._id)) throw new ApiError(400, "SELF_PROTECTED", "Hapus akunmu sendiri lewat Pengaturan.");
    if (targetRole === "owner") throw new ApiError(403, "OWNER_PROTECTED", "Pemilik layanan tidak bisa dihapus dari dasbor.");
    if (targetRole === "admin" && actorRole !== "owner") throw new ApiError(403, "OWNER_REQUIRED", "Hanya pemilik yang boleh menghapus admin.");
    const { jobId } = await requestDeletion(ctx, u._id);
    const job = await c.deletion_jobs.findOne({ _id: jobId });
    void runDeletionJob(ctx, jobId).catch(() => undefined);
    await audit(ctx, req, "user.delete", u.email);
    res.status(202).json(job ? jobView(job) : { status: "pending" });
  }));

  /* ---- Undangan (membuat akses untuk email tertentu, termasuk saat pendaftaran ditutup) ---- */
  r.get("/admin/invites", wrap(async (req, res) => {
    const q = pageQuery.parse(req.query);
    const filter = q.q ? { email: { $regex: escapeRegex(q.q), $options: "i" } } : {};
    const total = await c.invites.countDocuments(filter);
    const rows = await c.invites.find(filter).sort({ createdAt: q.dir === "asc" ? 1 : -1 }).skip((q.page - 1) * q.limit).limit(q.limit).toArray();
    res.json({ items: rows.map((i) => ({ id: String(i._id), email: i.email, role: i.role, createdBy: i.createdBy, createdAt: i.createdAt, usedAt: i.usedAt ?? null })), ...pageOf(total, q.page, q.limit) });
  }));

  r.post("/admin/invites", wrap(async (req, res) => {
    const body = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: z.enum(["user", "admin"]).default("user") }).strict().parse(req.body);
    if (body.role === "admin" && res.locals.adminRole !== "owner") throw new ApiError(403, "OWNER_REQUIRED", "Hanya pemilik yang boleh mengundang admin.");
    if (await c.users.findOne({ email: body.email })) throw new ApiError(409, "USER_EXISTS", "Email ini sudah terdaftar sebagai pengguna.");
    try {
      const ins = await c.invites.insertOne({ email: body.email, role: body.role, createdBy: req.user!.email, createdAt: new Date(), usedAt: null } as never);
      await audit(ctx, req, "invite.create", body.email, { role: body.role });
      res.status(201).json({ id: String(ins.insertedId), email: body.email, role: body.role });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new ApiError(409, "INVITE_EXISTS", "Email ini sudah diundang.");
      throw e;
    }
  }));

  r.delete("/admin/invites/:id", wrap(async (req, res) => {
    const id = oid(String(req.params.id));
    const inv = id ? await c.invites.findOne({ _id: id }) : null;
    if (!inv) throw new ApiError(404, "NOT_FOUND", "Undangan tidak ditemukan.");
    if (inv.role === "admin" && res.locals.adminRole !== "owner") throw new ApiError(403, "OWNER_REQUIRED", "Hanya pemilik yang boleh mencabut undangan admin.");
    await c.invites.deleteOne({ _id: inv._id });
    await audit(ctx, req, "invite.delete", inv.email);
    res.json({ ok: true });
  }));

  return r;
}
