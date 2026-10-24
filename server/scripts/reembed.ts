// Menghitung ulang embedding memori dan ringkasan sesi setelah mengganti EMBEDDING_PROVIDER / model / dimensi.
// Data berisi vektor dari model lama TIDAK dipakai untuk retrieval sampai dihitung ulang (tag tidak cocok).
// Pakai: npm -w server run db:reembed [-- --dry-run]
import { loadConfig } from "../src/config.js";
import { connectDb } from "../src/db.js";
import { makeEmbedder } from "../src/llm/index.js";

try { process.loadEnvFile(".env"); } catch { /* opsional */ }
const dry = process.argv.includes("--dry-run");
const cfg = loadConfig();
const emb = makeEmbedder(cfg);
const d = await connectDb(cfg.MONGODB_URI, cfg.MONGODB_DB);
const stale = (doc: { embedding?: number[]; embeddingTag?: string }) =>
  doc.embeddingTag ? doc.embeddingTag !== emb.tag : doc.embedding?.length !== emb.dimensions;

try {
  let memCount = 0, sumCount = 0;
  const mems = await d.c.memories.find({}, { projection: { content: 1, embedding: 1, embeddingTag: 1 } }).toArray();
  const staleMems = mems.filter(stale);
  const sums = await d.c.session_summaries.find({ embedding: { $exists: true } }, { projection: { summary: 1, embedding: 1, embeddingTag: 1 } }).toArray();
  const staleSums = sums.filter(stale);
  console.log(`Embedding aktif: ${emb.tag}. Perlu dihitung ulang: ${staleMems.length} memori, ${staleSums.length} ringkasan.`);
  if (dry) process.exit(0);
  for (let i = 0; i < staleMems.length; i += 50) {
    const batch = staleMems.slice(i, i + 50);
    const vecs = await emb.embed(batch.map((m) => m.content));
    for (let j = 0; j < batch.length; j++) { await d.c.memories.updateOne({ _id: batch[j]!._id }, { $set: { embedding: vecs[j]!, embeddingTag: emb.tag } }); memCount++; }
  }
  for (let i = 0; i < staleSums.length; i += 50) {
    const batch = staleSums.slice(i, i + 50);
    const vecs = await emb.embed(batch.map((s) => s.summary));
    for (let j = 0; j < batch.length; j++) { await d.c.session_summaries.updateOne({ _id: batch[j]!._id }, { $set: { embedding: vecs[j]!, embeddingTag: emb.tag } }); sumCount++; }
  }
  console.log(`Selesai: ${memCount} memori dan ${sumCount} ringkasan diperbarui.`);
  console.log("Jika memakai Atlas Vector Search: buat ulang index dengan dimensi baru (npm run db:vector-index).");
} finally {
  await d.client.close();
}
