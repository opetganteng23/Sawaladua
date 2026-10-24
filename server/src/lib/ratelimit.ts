import type { NextFunction, Request, Response } from "express";
import type { Collection } from "mongodb";
import type { RateLimitDoc } from "../db.js";
import { log } from "./logger.js";
import { sendError } from "./http.js";

/**
 * Rate limiter jendela tetap yang disimpan di MongoDB (dokumen kedaluwarsa lewat TTL),
 * sehingga batas berlaku lintas instance PM2/cluster. Jika database gagal, request tetap
 * dilayani (fail-open) agar gangguan limiter tidak mematikan layanan; kegagalan dicatat.
 */
export function rateLimit(
  store: Collection<RateLimitDoc>,
  opts: { name: string; windowMs: number; max: number; key: (req: Request) => string },
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = Date.now();
      const windowStart = Math.floor(now / opts.windowMs) * opts.windowMs;
      const reset = windowStart + opts.windowMs;
      const doc = await store.findOneAndUpdate(
        { _id: `${opts.name}:${opts.key(req)}:${windowStart}` },
        { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date(reset + 60_000) } },
        { upsert: true, returnDocument: "after" },
      );
      if (doc && doc.n > opts.max) {
        res.set("Retry-After", String(Math.max(1, Math.ceil((reset - now) / 1000))));
        return sendError(res, 429, "RATE_LIMITED", "Terlalu banyak permintaan. Tunggu sebentar ya.", true);
      }
    } catch {
      log("warn", { event: "ratelimit_store_failed", route: opts.name });
    }
    next();
  };
}
