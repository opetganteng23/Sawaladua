/** Definisi Atlas Vector Search untuk koleksi `memories`. Dimensi HARUS sama dengan EMBEDDING_DIMENSIONS dan model embedding. */
export function vectorIndexDefinition(dimensions: number) {
  return {
    fields: [
      { type: "vector", path: "embedding", numDimensions: dimensions, similarity: "cosine" },
      // Filter kepemilikan dan status diterapkan di database, bukan di aplikasi.
      { type: "filter", path: "userId" },
      { type: "filter", path: "status" },
    ],
  };
}
