import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) {
    super(message);
  }
}

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);

export function sendError(res: Response, status: number, code: string, message: string, retryable = false) {
  res.status(status).json({ error: { code, message, retryable, requestId: res.locals.requestId } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return res.end();
  if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message, err.retryable);
  if (err instanceof ZodError) return sendError(res, 400, "INVALID_REQUEST", "Permintaan tidak valid.");
  if ((err as { type?: string })?.type === "entity.too.large")
    return sendError(res, 413, "PAYLOAD_TOO_LARGE", "Pesan terlalu besar.");
  sendError(res, 500, "INTERNAL", "Terjadi kesalahan di sisi Sawala. Coba lagi sebentar lagi.", true);
}
