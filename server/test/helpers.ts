import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { connectDb } from "../src/db.js";
import { createCtx } from "../src/bootstrap.js";

export async function setup(env: Record<string, string> = {}) {
  const mongod = await MongoMemoryServer.create();
  const cfg = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "x".repeat(40),
    AUTH_DEV_LOGIN: "true",
    FEATURE_LONG_TERM_MEMORY: "true",
    FEATURE_MOOD_THEMES: "true",
    FEATURE_PROACTIVE_GREETING: "true",
    FEATURE_DATA_EXPORT: "true",
    MONGODB_DB: "sawala_test",
    RATE_LIMIT_SCALE: "1000",
    FEATURE_VOICE_CALLS: "true",
    ADMIN_EMAILS: "admin@x.com",
    ...env,
  });
  const d = await connectDb(mongod.getUri(), "sawala_test");
  const ctx = await createCtx(cfg, d);
  const app = createApp(ctx);
  return {
    ctx, app,
    async stop() { await d.client.close(); await mongod.stop(); },
  };
}

export async function login(app: Parameters<typeof request>[0], email: string, opts: { confirmAge?: boolean } = {}) {
  const agent = request.agent(app);
  const r = await agent.post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email, displayName: email.split("@")[0] });
  if (r.status !== 200) throw new Error("login failed " + r.status);
  const call = (method: "get" | "post" | "patch" | "delete", url: string, body?: unknown) => {
    const t = agent[method](url).set("X-Requested-With", "sawala");
    return body === undefined ? t : t.send(body as object);
  };
  if (opts.confirmAge !== false) await call("patch", "/api/settings", { ageConfirmed: true });
  return { agent, call, user: r.body.user as { id: string } };
}

export function parseSse(text: string) {
  return text.split("\n\n").filter(Boolean).map((blk) => {
    const ev = /event: (.*)/.exec(blk)?.[1] ?? "";
    const data = JSON.parse(/data: (.*)/.exec(blk)?.[1] ?? "null");
    return { event: ev, data };
  });
}

export function bubblesFrom(events: ReturnType<typeof parseSse>) {
  const out: string[] = [];
  for (const e of events) if (e.event === "bubble_delta") out[e.data.bubbleIndex] = (out[e.data.bubbleIndex] ?? "") + e.data.text;
  return out;
}

export async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}
