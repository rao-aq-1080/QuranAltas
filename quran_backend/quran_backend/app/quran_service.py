"""
Loads all exported artifacts once at startup and exposes clean functions
for the API layer to call.

Expects this folder structure (from unzipping quran_export.zip):

    quran_backend/
        app/
            main.py
            quran_service.py   <- this file
        data/
            quran_embeddings.npy
            quran_faiss.index
            quran_with_clusters.csv
            cluster_labels.json
            root_index.json
            embedding_model/
            raw/
                quran_dictionary.csv
                quran_morphology.csv
                quran_verbs.csv
                surah_info.csv
"""

import json
import re
import os
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
import faiss

try:
    from sentence_transformers import SentenceTransformer
except Exception as exc:  # pragma: no cover - depends on environment
    SentenceTransformer = None
    SENTENCE_TRANSFORMERS_IMPORT_ERROR = exc
else:
    SENTENCE_TRANSFORMERS_IMPORT_ERROR = None

try:
    import pinecone
except Exception as exc:  # pragma: no cover - depends on environment
    pinecone = None
    PINECONE_IMPORT_ERROR = exc
else:
    PINECONE_IMPORT_ERROR = None


def _find_data_dir() -> Path:
    start = Path(__file__).resolve()
    for path in [start.parent, *start.parents]:
        candidate = path / "quran_export"
        if candidate.exists():
            return candidate
    raise FileNotFoundError(
        "Could not find the quran_export directory. Make sure the export folder exists next to the project root."
    )


DATA_DIR = _find_data_dir()

# ---- Load data that is lightweight enough to keep at startup ----
print("Loading Quran dataframe with clusters...")
try:
    quran_df = pd.read_csv(DATA_DIR / "quran_with_clusters.csv")
except Exception as exc:
    raise RuntimeError(f"Could not load quran_with_clusters.csv from {DATA_DIR}: {exc}") from exc

print("Loading root index...")
try:
    with open(DATA_DIR / "root_index.json", encoding="utf-8") as f:
        root_index = json.load(f)
except Exception as exc:
    raise RuntimeError(f"Could not load root index from {DATA_DIR}: {exc}") from exc

print("Loading cluster labels...")
try:
    with open(DATA_DIR / "cluster_labels.json", encoding="utf-8") as f:
        cluster_labels = json.load(f)
except Exception as exc:
    raise RuntimeError(f"Could not load cluster labels from {DATA_DIR}: {exc}") from exc

print("Loading dictionary (for root -> meaning gloss)...")
try:
    dictionary_df = pd.read_csv(DATA_DIR / "raw" / "quran_dictionary.csv")
except Exception as exc:
    raise RuntimeError(f"Could not load dictionary CSV from {DATA_DIR}: {exc}") from exc

faiss_index = None
embedding_model = None
pinecone_client = None
pinecone_index = None


def _load_local_embedding_model():
    global embedding_model
    if embedding_model is not None:
        return embedding_model
    if SentenceTransformer is None:
        print(f"Sentence-transformers unavailable: {SENTENCE_TRANSFORMERS_IMPORT_ERROR}")
        return None
    model_path = DATA_DIR / "embedding_model"
    if not model_path.exists():
        print("Local embedding model directory not found; skipping local embedding model load.")
        return None
    try:
        print("Loading embedding model (offline, from local weights)...")
        embedding_model = SentenceTransformer(str(model_path))
        print("Embedding model loaded.")
    except Exception as exc:
        print(f"Embedding model unavailable: {exc}")
        embedding_model = None
    return embedding_model


def _load_local_faiss_index():
    global faiss_index
    if faiss_index is not None:
        return faiss_index
    index_path = DATA_DIR / "quran_faiss.index"
    if not index_path.exists():
        print("Local FAISS index not found; skipping local FAISS load.")
        return None
    print("Loading FAISS index...")
    try:
        faiss_index = faiss.read_index(str(index_path))
    except Exception as exc:
        print(f"FAISS index unavailable: {exc}")
        faiss_index = None
    return faiss_index


def get_vector_backend() -> dict:
    global pinecone_client, pinecone_index

    api_key = os.environ.get("PINECONE_API_KEY", "").strip()
    index_name = os.environ.get("PINECONE_INDEX", "quran-embeddings").strip() or "quran-embeddings"
    if api_key and pinecone is not None:
        try:
            if pinecone_client is None:
                pinecone_client = pinecone.Pinecone(api_key=api_key)
            if pinecone_index is None:
                pinecone_index = pinecone_client.Index(index_name)
            return {"type": "pinecone", "index": pinecone_index}
        except Exception as exc:
            print(f"Pinecone unavailable: {exc}")

    return {"type": "local"}


print("Vector backend ready. Cloud mode will be used when Pinecone credentials are provided.")


ASSISTANT_QUERY_ALIASES = {
    "patience": ["patient", "perseverance", "persevere", "endure", "steadfast", "sabr"],
    "mercy": ["mercy", "compassion", "forgiving", "forgiveness", "rahmah"],
    "prayer": ["prayer", "salat", "bow", "prostrate", "worship"],
    "guidance": ["guidance", "guided", "guide", "truth", "light", "huda"],
    "forgiveness": ["forgive", "forgiveness", "pardon", "mercy"],
    "charity": ["charity", "give", "giving", "zakat", "spend"],
    "faith": ["believe", "belief", "believers", "faith", "iman"],
    "gratitude": ["thank", "thankful", "gratitude", "grateful"],
    "justice": ["justice", "equity", "fair", "just"],
    "repentance": ["repent", "repentance", "return", "forgive"],
}


def _expand_assistant_query(question: str) -> str:
    lower_question = question.lower()
    terms = [question]
    for trigger, aliases in ASSISTANT_QUERY_ALIASES.items():
        if trigger in lower_question:
            terms.extend(aliases)
    return " ".join(dict.fromkeys(term for term in terms if term))


# =========================================================
# Semantic search
# =========================================================

def _lexical_search(query: str, top_k: int = 5) -> list[dict]:
    terms = [term for term in re.findall(r"[A-Za-z\u0600-\u06FF]+", query.lower()) if len(term) > 1]
    if not terms:
        terms = [query.strip().lower()]

    scored_rows = []
    for idx, row in quran_df.iterrows():
        haystack = " ".join(
            [str(row.get("ayah_ar", "")), str(row.get("ayah_en", "")), str(row.get("surah_name_en", ""))]
        ).lower()
        score = sum(1 for term in terms if term in haystack)
        if score > 0:
            scored_rows.append((score, idx, row))

    if not scored_rows:
        fallback_rows = quran_df.head(top_k).iterrows()
        return [
            {
                "surah": int(row["surah_no"]),
                "ayah": int(row["ayah_no_surah"]),
                "surah_name": row["surah_name_en"],
                "arabic": row["ayah_ar"],
                "translation": row["ayah_en"],
                "score": 0.0,
            }
            for _, row in fallback_rows
        ]

    scored_rows.sort(key=lambda item: item[0], reverse=True)
    results = []
    for _, idx, row in scored_rows[:top_k]:
        results.append({
            "surah": int(row["surah_no"]),
            "ayah": int(row["ayah_no_surah"]),
            "surah_name": row["surah_name_en"],
            "arabic": row["ayah_ar"],
            "translation": row["ayah_en"],
            "score": float(idx),
        })
    return results


def _pinecone_search(query: str, top_k: int = 5) -> list[dict]:
    model = _load_local_embedding_model()
    if model is None:
        return _lexical_search(query, top_k=top_k)

    try:
        q_emb = model.encode([query], normalize_embeddings=True).astype("float32").tolist()[0]
        backend = get_vector_backend()
        index = backend.get("index")
        if index is None:
            return _lexical_search(query, top_k=top_k)
        response = index.query(vector=q_emb, top_k=top_k, include_metadata=True)
        results = []
        for match in response.get("matches", []):
            try:
                row_idx = int(match.get("id"))
            except (TypeError, ValueError):
                row_idx = None
            row = quran_df.iloc[row_idx] if row_idx is not None and 0 <= row_idx < len(quran_df) else None
            if row is None:
                continue
            results.append({
                "surah": int(row["surah_no"]),
                "ayah": int(row["ayah_no_surah"]),
                "surah_name": row["surah_name_en"],
                "arabic": row["ayah_ar"],
                "translation": row["ayah_en"],
                "score": float(match.get("score", 0.0)),
            })
        if results:
            return results
    except Exception as exc:
        print(f"Pinecone search failed, falling back to lexical search: {exc}")
    return _lexical_search(query, top_k=top_k)


def semantic_search(query: str, top_k: int = 5) -> list[dict]:
    backend = get_vector_backend()
    if backend.get("type") == "pinecone":
        return _pinecone_search(query, top_k=top_k)

    local_model = _load_local_embedding_model()
    if local_model is None:
        return _lexical_search(query, top_k=top_k)

    faiss_index_local = _load_local_faiss_index()
    if faiss_index_local is None:
        return _lexical_search(query, top_k=top_k)

    try:
        q_emb = local_model.encode([query], normalize_embeddings=True).astype("float32")
        scores, idxs = faiss_index_local.search(q_emb, top_k)
        results = []
        for score, idx in zip(scores[0], idxs[0]):
            row = quran_df.iloc[idx]
            results.append({
                "surah": int(row["surah_no"]),
                "ayah": int(row["ayah_no_surah"]),
                "surah_name": row["surah_name_en"],
                "arabic": row["ayah_ar"],
                "translation": row["ayah_en"],
                "score": float(score),
            })
        return results
    except Exception as exc:
        print(f"Embedding search failed, falling back to lexical search: {exc}")
        return _lexical_search(query, top_k=top_k)


# =========================================================
# Root / morphology lookup
# =========================================================

def lookup_root(root: str, limit: int = 20) -> list[dict]:
    hits = root_index.get(root, [])
    seen = set()
    verses = []
    for h in hits:
        key = (h["surah"], h["ayah"])
        if key in seen:
            continue
        seen.add(key)
        row = quran_df[(quran_df.surah_no == h["surah"]) & (quran_df.ayah_no_surah == h["ayah"])]
        if not row.empty:
            verses.append({
                "surah": h["surah"], "ayah": h["ayah"],
                "arabic": row.iloc[0]["ayah_ar"],
                "translation": row.iloc[0]["ayah_en"],
            })
        if len(verses) >= limit:
            break
    return verses


def root_meaning(root: str) -> list[dict]:
    """Rough gloss for a root, pulled from the word dictionary.
    Dictionary is word-indexed, not root-indexed, so this does a loose
    match on transliteration containing the root string — review results,
    it's a starting point, not guaranteed precise."""
    matches = dictionary_df[dictionary_df["transliteration"].str.contains(root, case=False, na=False)]
    return matches[["title", "transliteration", "translation"]].drop_duplicates().head(10).to_dict("records")


# =========================================================
# Theme clusters
# =========================================================

def list_clusters() -> dict:
    return cluster_labels


def verses_in_cluster(cluster_id: int, limit: int = 20) -> list[dict]:
    subset = quran_df[quran_df["cluster"] == cluster_id].head(limit)
    return [
        {
            "surah": int(r["surah_no"]),
            "ayah": int(r["ayah_no_surah"]),
            "surah_name": r["surah_name_en"],
            "arabic": r["ayah_ar"],
            "translation": r["ayah_en"],
        }
        for _, r in subset.iterrows()
    ]


# =========================================================
# Surah browser
# =========================================================

def list_surahs() -> list[dict]:
    grouped = quran_df.groupby(["surah_no", "surah_name_en"], sort=True)
    surahs = []
    for (surah_no, surah_name), group in grouped:
        surahs.append({
            "surah": int(surah_no),
            "surah_name": surah_name,
            "ayah_count": int(group["ayah_no_surah"].max()),
        })
    return surahs


def verses_in_surah(surah_no: int, limit: int = 50) -> list[dict]:
    subset = quran_df[quran_df["surah_no"] == surah_no].head(limit)
    return [
        {
            "surah": int(r["surah_no"]),
            "ayah": int(r["ayah_no_surah"]),
            "surah_name": r["surah_name_en"],
            "arabic": r["ayah_ar"],
            "translation": r["ayah_en"],
        }
        for _, r in subset.iterrows()
    ]


def get_verse(surah_no: int, ayah_no: int) -> dict | None:
    row = quran_df[(quran_df.surah_no == surah_no) & (quran_df.ayah_no_surah == ayah_no)]
    if row.empty:
        return None
    verse = row.iloc[0]
    return {
        "surah": int(verse["surah_no"]),
        "ayah": int(verse["ayah_no_surah"]),
        "surah_name": verse["surah_name_en"],
        "arabic": verse["ayah_ar"],
        "translation": verse["ayah_en"],
    }


# =========================================================
# AI assistant
# =========================================================

def _verse_context_row(row: pd.Series) -> dict:
    cluster_id = int(row.get("cluster", -1)) if pd.notna(row.get("cluster")) else -1
    return {
        "surah": int(row["surah_no"]),
        "ayah": int(row["ayah_no_surah"]),
        "surah_name": row["surah_name_en"],
        "arabic": row["ayah_ar"],
        "translation": row["ayah_en"],
        "cluster": cluster_id,
        "cluster_label": cluster_labels.get(str(cluster_id), cluster_labels.get(cluster_id, "")),
    }


def assistant_context(question: str, top_k: int = 6) -> list[dict]:
    results = semantic_search(_expand_assistant_query(question), top_k=top_k)
    context = []
    seen = set()
    for item in results:
        row = quran_df[(quran_df.surah_no == item["surah"]) & (quran_df.ayah_no_surah == item["ayah"])]
        if row.empty:
            continue
        verse = _verse_context_row(row.iloc[0])
        key = (verse["surah"], verse["ayah"])
        if key in seen:
            continue
        seen.add(key)
        verse["score"] = item.get("score", 0.0)
        context.append(verse)
    return context


def _compose_fallback_answer(question: str, context: list[dict]) -> dict:
    if not context:
        return {
            "answer": "I could not find a strong Quran-based match for that question in the current data.",
            "sources": [],
            "model": "fallback",
        }

    lines = [
        "I could not reach OpenRouter, so here is a Quran-grounded answer from the local data:",
        "",
    ]
    for verse in context[:4]:
        lines.append(f"- {verse['surah']}:{verse['ayah']} {verse['translation']}")
    return {
        "answer": "\n".join(lines),
        "sources": context,
        "model": "fallback",
    }


def answer_question(question: str, top_k: int = 6) -> dict:
    context = assistant_context(question, top_k=top_k)
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    model = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini").strip() or "openai/gpt-4o-mini"

    if not api_key:
        return _compose_fallback_answer(question, context)

    system_prompt = (
        "You are Quran Atlas, a careful assistant about the Quran and Islam. "
        "Use only the provided Quran verses and metadata as grounding. "
        "Do not invent citations, hadith, or scholarly claims that are not supported by the supplied context. "
        "If the context is insufficient, say so plainly and answer conservatively. "
        "Keep the response clear, respectful, and concise. "
        "When relevant, cite verses like (2:255) or (surah:ayah)."
    )

    context_lines = []
    for verse in context:
        label = f"{verse['surah']}:{verse['ayah']} - {verse['surah_name']}"
        if verse.get("cluster_label"):
            label += f" | theme: {verse['cluster_label']}"
        context_lines.append(
            f"{label}\nArabic: {verse['arabic']}\nTranslation: {verse['translation']}"
        )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"Question: {question}\n\n"
                    "Use these Quran references and translations as your evidence:\n"
                    + "\n\n".join(context_lines)
                ),
            },
        ],
        "temperature": 0.2,
        "max_tokens": 800,
    }

    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            response_data = json.loads(response.read().decode("utf-8"))
        answer = response_data["choices"][0]["message"]["content"].strip()
        return {
            "answer": answer,
            "sources": context,
            "model": model,
        }
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, IndexError, json.JSONDecodeError) as exc:
        print(f"OpenRouter assistant unavailable: {exc}")
        return _compose_fallback_answer(question, context)
