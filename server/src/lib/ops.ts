import type { AppCtx } from "../context.js";

/**
 * Catat kejadian operasional (MTS 13.2). Hanya jenis kejadian dan durasi: tidak ada isi percakapan, tidak ada userId.
 * Fire-and-forget: kegagalan pencatatan tidak boleh memengaruhi alur pengguna. Data kedaluwarsa otomatis (30 hari).
 */
export function recordOp(ctx: AppCtx, type: string, ms?: number): void {
  void ctx.d.c.ops_events.insertOne({ type, at: new Date(), ...(ms !== undefined ? { ms } : {}) } as never).catch(() => undefined);
}
