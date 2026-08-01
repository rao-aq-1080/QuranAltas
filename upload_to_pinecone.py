import math
import os
from pathlib import Path

import pandas as pd
from pinecone import Pinecone

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "quran_export"

API_KEY = os.environ.get("PINECONE_API_KEY", "").strip()
INDEX_NAME = os.environ.get("PINECONE_INDEX", "quran-embeddings").strip() or "quran-embeddings"

if not API_KEY:
    raise SystemExit("PINECONE_API_KEY is required")

print("Loading Quran data...")
quran_df = pd.read_csv(DATA_DIR / "quran_with_clusters.csv")

print("Connecting to Pinecone...")
pc = Pinecone(api_key=API_KEY)
index = pc.Index(INDEX_NAME)

texts = []
ids = []
metadata = []

for idx, row in quran_df.iterrows():
    text = " ".join(
        [
            str(row.get("ayah_ar", "")),
            str(row.get("ayah_en", "")),
            str(row.get("surah_name_en", "")),
        ]
    ).strip()
    if not text:
        continue
    texts.append(text)
    ids.append(str(int(idx)))
    metadata.append(
        {
            "surah": int(row.get("surah_no", 0)),
            "ayah": int(row.get("ayah_no_surah", 0)),
            "surah_name": str(row.get("surah_name_en", "")),
            "cluster": int(row.get("cluster", -1)) if pd.notna(row.get("cluster")) else -1,
        }
    )

print(f"Preparing {len(texts)} text entries for upload...")


def simple_embed(text: str, dim: int = 1024) -> list[float]:
    tokens = [t.lower() for t in text.replace("\n", " ").split() if t]
    vector = [0.0] * dim
    for token in tokens:
        h = abs(hash(token)) % dim
        vector[h] += 1.0
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]

embeddings = [simple_embed(text) for text in texts]

print("Upserting vectors to Pinecone...")
chunk_size = 256
for start in range(0, len(ids), chunk_size):
    batch_ids = ids[start:start + chunk_size]
    batch_embeddings = embeddings[start:start + chunk_size]
    batch_metadata = metadata[start:start + chunk_size]
    index.upsert(vectors=[(vid, emb, meta) for vid, emb, meta in zip(batch_ids, batch_embeddings, batch_metadata)])
    print(f"Uploaded batch {start // chunk_size + 1} of {math.ceil(len(ids) / chunk_size)}")

print("Done.")
