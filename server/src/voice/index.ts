import type { AppCtx } from "../context.js";
import { cascadeProvider } from "./providers/cascade.js";
import { geminiLiveProvider } from "./providers/geminiLive.js";
import { mockRealtimeProvider } from "./providers/mock.js";
import { openaiRealtimeProvider } from "./providers/openaiRealtime.js";
import type { RealtimeProvider } from "./types.js";

/** Pilih provider suara realtime dari konfigurasi. Mengganti vendor cukup lewat env (REALTIME_PROVIDER dll). */
export function makeRealtime(ctx: AppCtx): RealtimeProvider | null {
  switch (ctx.cfg.REALTIME_PROVIDER) {
    case "gemini": return geminiLiveProvider(ctx.cfg);
    case "openai": return openaiRealtimeProvider(ctx.cfg);
    case "cascade": return ctx.stt ? cascadeProvider(ctx) : null;
    case "mock": return mockRealtimeProvider();
    default: return null;
  }
}

export { attachVoice } from "./ws.js";
