import { MongoClient, ObjectId, type Collection, type Db } from "mongodb";

export const THEMES = ["terang", "gelap", "senja", "hutan", "sakura"] as const;
export const MOODS = ["hangat", "ceria", "playful", "reflektif"] as const;
export const STRATEGIES = ["listen", "reflect", "suggest", "clarify", "safety_support"] as const;
export type Theme = (typeof THEMES)[number];
export type Mood = (typeof MOODS)[number];
export type Strategy = (typeof STRATEGIES)[number];

export interface Preferences {
  theme: Theme;
  moodThemes: boolean; // fase 2: tema mengikuti mood (opt-in, bisa dimatikan)
  showMood: boolean;
  style: {
    length: "ringkas" | "sedang" | "panjang";
    formality: "santai" | "netral" | "sopan";
    emoji: "tanpa" | "sedikit" | "sedang";
    humor: boolean;
    addressAs: string; // panggilan pilihan pengguna, boleh kosong
  };
  greeting: { enabled: boolean; quietStartHour: number; quietEndHour: number; utcOffsetMinutes: number };
}

export interface PrivacySettings {
  longTermMemory: boolean;
  allowSensitiveMemory: boolean;
  saveHistory: boolean;
}

export interface UserDoc {
  _id: ObjectId;
  email: string;
  displayName: string;
  authProvider: "google" | "dev";
  providerSub: string;
  preferences: Preferences;
  privacySettings: PrivacySettings;
  onboardingDone: boolean;
  ageConfirmedAt?: Date | null; // konfirmasi 18+ (diwajibkan server sebelum chat)
  deletionStatus: "none" | "deletion_pending";
  lastGreetingAt: Date | null;
  forgottenHashes?: string[];
  role?: "user" | "admin"; // pemilik (owner) ditentukan dari ADMIN_EMAILS di env, bukan dari field ini
  status?: "active" | "suspended"; // kosong = active
  suspendedAt?: Date | null;
  lastLoginAt?: Date | null;
  adminNote?: string; // catatan internal singkat; JANGAN berisi isi percakapan
  createdAt: Date;
}

export interface SessionDoc {
  _id: string; // hash token
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
  userAgent?: string; // dipotong; hanya untuk daftar sesi di Pengaturan
}

export interface ConversationDoc {
  _id: ObjectId;
  userId: ObjectId;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  summaryFloor?: Date | null; // ringkasan tidak boleh mencakup pesan sebelum waktu ini (setelah pengguna menghapus memori terkait)
  ephemeral?: boolean; // saveHistory=false: dihapus otomatis setelah expiresAt
  expiresAt?: Date | null;
}

export interface MessageDoc {
  _id: ObjectId;
  userId: ObjectId;
  conversationId: ObjectId;
  role: "user" | "assistant";
  text: string;
  bubbles?: string[];
  status: "complete" | "incomplete" | "failed";
  mood?: Mood;
  strategy?: Strategy;
  channel: "chat" | "call";
  clientMessageId?: string;
  safetyLevel?: number;
  createdAt: Date;
}

export type MemoryType = "episodic" | "semantic";
export interface MemoryDoc {
  _id: ObjectId;
  userId: ObjectId;
  type: MemoryType;
  content: string;
  importance: number;
  confidence: number;
  sensitivity: "none" | "personal" | "sensitive";
  sourceMessageIds: ObjectId[];
  embedding: number[];
  status: "active" | "superseded" | "conflict" | "flagged_wrong";
  userConfirmed: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  decayedAt?: Date | null;
  embeddingTag?: string; // provider/model/dimensi yang membuat vektor; vektor beda tag tidak dibandingkan
  useCount: number;
  supersededBy: ObjectId | null;
  conflictWith: ObjectId | null;
}

export interface SummaryDoc {
  _id: ObjectId;
  userId: ObjectId;
  conversationId: ObjectId;
  summary: string;
  sourceUpTo: Date;
  embedding?: number[];
  embeddingTag?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MoodStateDoc { _id: ObjectId; userId: ObjectId; mood: Mood; updatedAt: Date }

export interface DeletionJobDoc {
  _id: ObjectId;
  userId: ObjectId;
  status: "pending" | "running" | "completed" | "failed";
  requestedAt: Date;
  completedAt: Date | null;
  steps: { name: string; status: "pending" | "done" | "failed"; at: Date | null }[];
  note: string;
  tokenHash: string;
}

export interface UsageEventDoc {
  _id: ObjectId;
  userId: ObjectId;
  requestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: string;
  createdAt: Date;
}

export interface RateLimitDoc {
  _id: string; // name:id:windowStart
  n: number;
  expiresAt: Date;
}

export interface CallSessionDoc {
  _id: ObjectId;
  userId: ObjectId;
  conversationId: ObjectId;
  status: "active" | "ended";
  transcriptConsent: boolean; // true: transkrip disimpan sebagai riwayat; false: teks sementara dihapus saat panggilan berakhir
  startedAt: Date;
  lastActivityAt: Date;
  endedAt: Date | null;
  endReason?: "user" | "timeout" | "max_duration" | "error";
  turns: number;
  metrics?: { avgLatencyMs?: number; clientTurns?: number };
}

export interface AppSettingDoc {
  _id: string; // "flags"
  killed?: string[]; // fitur yang dimatikan operator saat runtime (kill switch)
  updatedAt: Date;
}

export interface OpsEventDoc {
  _id: ObjectId;
  type: string; // jenis kejadian teknis; TIDAK memuat isi percakapan maupun identitas pengguna
  at: Date;
  ms?: number;
}

export interface MigrationDoc {
  _id: string;
  appliedAt: Date;
}

export interface InviteDoc {
  _id: ObjectId;
  email: string; // huruf kecil, unik
  role: "user" | "admin";
  createdBy: string; // email admin
  createdAt: Date;
  usedAt?: Date | null;
}

export interface AuditDoc {
  _id: ObjectId;
  at: Date;
  actor: string; // email admin
  action: string; // mis. user.suspend, settings.update
  target?: string; // mis. email pengguna / bagian pengaturan
  detail?: Record<string, unknown>; // TIDAK boleh memuat rahasia atau isi percakapan
  ip?: string;
}

export interface Collections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  conversations: Collection<ConversationDoc>;
  messages: Collection<MessageDoc>;
  memories: Collection<MemoryDoc>;
  mood_state: Collection<MoodStateDoc>;
  session_summaries: Collection<SummaryDoc>;
  deletion_jobs: Collection<DeletionJobDoc>;
  usage_events: Collection<UsageEventDoc>;
  rate_limits: Collection<RateLimitDoc>;
  call_sessions: Collection<CallSessionDoc>;
  app_settings: Collection<AppSettingDoc>;
  migrations: Collection<MigrationDoc>;
  ops_events: Collection<OpsEventDoc>;
  invites: Collection<InviteDoc>;
  audit_log: Collection<AuditDoc>;
}

export interface Database {
  client: MongoClient;
  db: Db;
  c: Collections;
}

export async function connectDb(uri: string, name: string): Promise<Database> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(name);
  const c: Collections = {
    users: db.collection("users"),
    sessions: db.collection("sessions"),
    conversations: db.collection("conversations"),
    messages: db.collection("messages"),
    memories: db.collection("memories"),
    mood_state: db.collection("mood_state"),
    session_summaries: db.collection("session_summaries"),
    deletion_jobs: db.collection("deletion_jobs"),
    usage_events: db.collection("usage_events"),
    rate_limits: db.collection("rate_limits"),
    call_sessions: db.collection("call_sessions"),
    app_settings: db.collection("app_settings"),
    migrations: db.collection("migrations"),
    ops_events: db.collection("ops_events"),
    invites: db.collection("invites"),
    audit_log: db.collection("audit_log"),
  };
  await Promise.all([
    c.users.createIndex({ email: 1 }, { unique: true }),
    c.users.createIndex({ authProvider: 1, providerSub: 1 }, { unique: true }),
    c.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.sessions.createIndex({ userId: 1 }),
    c.conversations.createIndex({ userId: 1, deletedAt: 1, updatedAt: -1 }),
    c.messages.createIndex({ userId: 1, conversationId: 1, createdAt: 1 }),
    c.messages.createIndex(
      { userId: 1, conversationId: 1, clientMessageId: 1 },
      { unique: true, partialFilterExpression: { clientMessageId: { $type: "string" }, role: "user" } },
    ),
    c.memories.createIndex({ userId: 1, status: 1, updatedAt: -1 }),
    c.mood_state.createIndex({ userId: 1 }, { unique: true }),
    c.session_summaries.createIndex({ userId: 1, conversationId: 1 }, { unique: true }),
    c.rate_limits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.ops_events.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }),
    c.ops_events.createIndex({ type: 1, at: -1 }),
    c.invites.createIndex({ email: 1 }, { unique: true }),
    c.audit_log.createIndex({ at: -1 }),
    c.audit_log.createIndex({ action: 1, at: -1 }),
    c.audit_log.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 }),
    c.users.createIndex({ createdAt: -1 }),
    c.call_sessions.createIndex({ userId: 1, status: 1 }),
    c.call_sessions.createIndex({ status: 1, lastActivityAt: 1 }),
    c.deletion_jobs.createIndex({ userId: 1, requestedAt: -1 }),
    c.deletion_jobs.createIndex({ tokenHash: 1 }),
    c.deletion_jobs.createIndex({ completedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }),
    c.usage_events.createIndex({ userId: 1, createdAt: -1 }),
    // Retensi terbatas untuk metrik penggunaan (90 hari).
    c.usage_events.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),
  ]);
  return { client, db, c };
}

export const oid = (s: string): ObjectId | null => (ObjectId.isValid(s) && String(new ObjectId(s)) === s ? new ObjectId(s) : null);

export const defaultPreferences = (theme: Theme = "terang"): Preferences => ({
  theme,
  moodThemes: false,
  showMood: true,
  style: { length: "ringkas", formality: "santai", emoji: "sedikit", humor: true, addressAs: "" },
  greeting: { enabled: false, quietStartHour: 21, quietEndHour: 8, utcOffsetMinutes: 420 },
});

export const defaultPrivacy = (): PrivacySettings => ({
  longTermMemory: true,
  allowSensitiveMemory: false,
  saveHistory: true,
});
