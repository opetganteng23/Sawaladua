import type { AppCtx } from "./context.js";

/** Flag efektif = batas dari environment, dikurangi kill switch operator saat runtime. */
export function featureFlags(ctx: AppCtx) {
  const f = ctx.flags.get();
  const rt = ctx.cfg.REALTIME_PROVIDER;
  return {
    ...f,
    // Suara realtime tersedia bila fitur suara menyala dan provider realtime dikonfigurasi.
    realtimeVoice: f.voiceCalls && rt !== "none",
    realtimeProvider: rt,
    realtimeMode: rt === "gemini" || rt === "openai" ? ("native" as const) : rt === "none" ? null : ("cascade" as const),
  };
}
