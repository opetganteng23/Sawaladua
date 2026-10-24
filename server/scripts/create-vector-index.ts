// Membuat Atlas Vector Search index untuk memori. Hanya berfungsi di MongoDB Atlas (bukan MongoDB lokal/in-memory).
// Pakai: npm -w server run db:vector-index   (butuh MONGODB_URI, MONGODB_DB, VECTOR_SEARCH_INDEX, EMBEDDING_DIMENSIONS di server/.env)
import { MongoClient } from "mongodb";
import { vectorIndexDefinition } from "../src/memory/vectorIndex.js";

try { process.loadEnvFile(".env"); } catch { /* opsional */ }
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? "sawala";
const name = process.env.VECTOR_SEARCH_INDEX;
const dims = Number(process.env.EMBEDDING_DIMENSIONS ?? 256);
if (!uri || !name) {
  console.error("Isi MONGODB_URI dan VECTOR_SEARCH_INDEX di server/.env terlebih dahulu.");
  process.exit(1);
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const col = client.db(dbName).collection("memories");
  const existing = await col.listSearchIndexes().toArray().catch(() => {
    throw new Error("Cluster ini tidak mendukung Atlas Search (bukan Atlas?).");
  });
  const found = existing.find((i) => i.name === name);
  const definition = vectorIndexDefinition(dims);
  if (found) {
    const dimsNow = (found.latestDefinition as { fields?: { numDimensions?: number }[] } | undefined)?.fields?.find((f) => f.numDimensions)?.numDimensions;
    if (dimsNow && dimsNow !== dims) {
      console.error(`Index "${name}" sudah ada dengan ${dimsNow} dimensi, tetapi EMBEDDING_DIMENSIONS=${dims}. Hapus/ganti nama index secara manual agar tidak merusak data.`);
      process.exit(2);
    }
    console.log(`Index "${name}" sudah ada (status: ${found.status ?? "?"}). Tidak ada perubahan.`);
  } else {
    await col.createSearchIndex({ name, type: "vectorSearch", definition });
    console.log(`Index "${name}" dibuat (${dims} dimensi, cosine). Atlas membangunnya di latar belakang; tunggu status READY di konsol.`);
  }
} finally {
  await client.close();
}
