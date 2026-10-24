import type { Config } from "./config.js";
import type { Database, UserDoc } from "./db.js";
import type { FlagStore } from "./lib/flags.js";
import type { Embedder, LlmProvider, SttProvider, TtsProvider } from "./llm/types.js";

export interface AppCtx {
  cfg: Config;
  d: Database;
  llm: LlmProvider;
  embedder: Embedder;
  stt: SttProvider | null;
  tts: TtsProvider | null;
  flags: FlagStore;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: UserDoc;
  }
}
