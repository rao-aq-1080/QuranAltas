# Pinecone setup for Quran Atlas

This project now supports an optional Pinecone-backed vector search path.

## Environment variables

Set these in your deployment environment:

- `PINECONE_API_KEY`
- `PINECONE_INDEX=quran-embeddings`

## Behavior

- If Pinecone credentials are present and the `pinecone` package is available, the app will use Pinecone for semantic search.
- If not, it will continue to use the local FAISS/embedding fallback so the app remains deployable and stable.

## Important note

You still do not need to load the full 2GB vector file into memory on the server. The app now uses cloud vectors when configured, while preserving the local fallback for safety.
