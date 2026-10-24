import type { Database } from "../db.js";

export interface Migration {
  id: string;
  description: string;
  /** Harus idempoten: dua instance bisa menjalankannya bersamaan saat deploy. Jangan melakukan perubahan destruktif. */
  up(d: Database): Promise<void>;
}

const objectId = { bsonType: "objectId" };

/** Validator tingkat database sebagai lapisan kedua di bawah validasi zod. Sengaja longgar (hanya field kritis). */
export const VALIDATORS: Record<string, object> = {
  users: {
    bsonType: "object",
    required: ["email", "authProvider", "providerSub"],
    properties: { email: { bsonType: "string" }, authProvider: { enum: ["google", "dev"] }, providerSub: { bsonType: "string" } },
  },
  conversations: { bsonType: "object", required: ["userId", "title"], properties: { userId: objectId, title: { bsonType: "string" } } },
  messages: {
    bsonType: "object",
    required: ["userId", "conversationId", "role", "text", "createdAt"],
    properties: {
      userId: objectId, conversationId: objectId, role: { enum: ["user", "assistant"] }, text: { bsonType: "string" },
      channel: { enum: ["chat", "call"] }, status: { enum: ["complete", "incomplete", "failed"] },
    },
  },
  memories: {
    bsonType: "object",
    required: ["userId", "type", "content", "embedding", "status"],
    properties: {
      userId: objectId, type: { enum: ["episodic", "semantic"] }, content: { bsonType: "string" }, embedding: { bsonType: "array" },
      status: { enum: ["active", "superseded", "conflict", "flagged_wrong"] },
    },
  },
  call_sessions: {
    bsonType: "object",
    required: ["userId", "conversationId", "status"],
    properties: { userId: objectId, conversationId: objectId, status: { enum: ["active", "ended"] } },
  },
};

export const migrations: Migration[] = [
  { id: "001-baseline", description: "Penanda awal skema (tanpa perubahan data)", up: async () => undefined },
  {
    id: "002-user-defaults",
    description: "Isi field baru pada pengguna lama: ageConfirmedAt=null (pengguna lama diminta konfirmasi usia saat login berikutnya), forgottenHashes=[]",
    async up(d) {
      await d.c.users.updateMany({ ageConfirmedAt: { $exists: false } }, { $set: { ageConfirmedAt: null } });
      await d.c.users.updateMany({ forgottenHashes: { $exists: false } }, { $set: { forgottenHashes: [] } });
    },
  },
  {
    id: "003-db-validators",
    description: "Pasang $jsonSchema validator (level moderate: dokumen lama yang tidak sesuai tidak diblokir sampai diubah)",
    async up(d) {
      const existing = new Set((await d.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
      for (const [name, schema] of Object.entries(VALIDATORS)) {
        if (!existing.has(name)) await d.db.createCollection(name).catch(() => undefined);
        await d.db.command({ collMod: name, validator: { $jsonSchema: schema }, validationLevel: "moderate", validationAction: "error" });
      }
    },
  },
];

/** Jalankan migrasi yang belum tercatat, berurutan. Mengembalikan ID yang baru diterapkan. */
export async function runMigrations(d: Database, list: Migration[] = migrations): Promise<string[]> {
  const applied: string[] = [];
  for (const m of list) {
    if (await d.c.migrations.findOne({ _id: m.id })) continue;
    await m.up(d);
    try {
      await d.c.migrations.insertOne({ _id: m.id, appliedAt: new Date() });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e; // instance lain menyelesaikannya lebih dulu
    }
    applied.push(m.id);
  }
  return applied;
}
