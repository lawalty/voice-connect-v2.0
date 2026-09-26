# Shared RAG library

Verified on September 26, 2026 against the Hermes repository, running RAG API,
and Supabase project. Voice Connect 2.0 uses the existing library's API contract.
It must not create a second corpus, change embedding models, or rerun migrations.

## Existing owner

- Supabase project: `orb-knowledge-base` (`fjmfziotgloxkiubldip`).
- API: `https://hermes-agent-n3zu.srv1391383.hstgr.cloud`.
- Database: `public.rag_groups`, `rag_documents`, `rag_ingestion_jobs`, `rag_chunks`.
- Private originals bucket: `rag-documents`.
- Embeddings: existing `rag-embed` function, `gte-small`, 384 dimensions.
- Search: group routing followed by cosine vector and English full-text retrieval,
  combined using reciprocal-rank fusion. Existing owner and group filters apply.
- Verified inventory: 96 ready documents, 2,371 chunks, seven groups.
- The older `documents` and `chunks` tables in the same project are separate.

The RAG API and worker run under `/docker/hermes-agent-n3zu` on the Hermes host.
Both running containers use `hermes-supabase-rag:20260824T155930Z` (API 0.9.2).
The checkout README predates the live PDF OCR improvements; use the deployed
contract and source when checking compatibility. The `current` filesystem link
points to `20260824T140338Z`, which differs from the running container image.
This integration does not change that existing release state.

## Connection design

Authenticated Voice Connect browser requests go through its own service to the
existing RAG API. OpenClaw uses an additive tool plugin for that same API. This
keeps the library separate from each harness's conversational memory.

Only the RAG service holds the Supabase service-level credential. API credentials
remain on servers and do not enter browser assets, tool arguments, or prompts.
The existing operator and agent credentials have different authority. Reading
the shared library needs only the agent credential; operator document management
must preserve the stronger authorization boundary.

Reusing this API also reuses its operational dependency on the Hermes host.
A later independent API deployment could use the same Supabase project and owner,
but would need explicit ownership of releases, secrets, and worker scheduling.

## Verification boundary

Current read-only checks confirm authenticated group/document listing and searches
in Work, Devotions, and Assembly of God Papers. Unauthenticated group listing
returns HTTP 401. Integration is not complete until Voice Connect and the native
OpenClaw tool path have separately passed live acceptance.

## Implementation and activation

The Library panel lists documents, selects a collection, searches with citations,
and requests fresh download links. This first integration accesses existing
documents; ingestion, editing and deletion continue through the existing Hermes
portal. It does not copy documents or add database tables, buckets or workers.

The service uses `VC_LIBRARY_URL` and `VC_LIBRARY_TOKEN_FILE`. The credential file
contains the existing RAG agent token, not a Supabase secret. The deployed Compose
file reads `/run/secrets/library-token`; an absent token produces an explicit
unconfigured response. The local owner session, origin and CSRF protections apply
to every Library API request. Downloads expire after one hour. Existing API
responses retain their document IDs and citations; owner IDs and private Storage
paths are omitted from browser responses.

`npm run build` also creates `dist/openclaw-library`. Its `vc-shared-library`
plugin registers `vc_library_groups`, `vc_library_documents`, `vc_library_search`
and `vc_library_download`. Configure `baseUrl` with the API origin and `tokenFile`
with a server-only file path readable inside OpenClaw. The adapter targets the
verified OpenClaw 2026.9.6 plugin contract. No memory provider, model selection,
persona or existing conversation is replaced.

The existing backend automatically chooses one or two relevant collections for
an unscoped search. Selecting a collection searches it explicitly. Generated Docs
is excluded from automatic routing unless requested, matching Hermes. The document
list returns up to 200 entries; selecting a collection narrows it. The current
96-document corpus fits in one complete listing.

Reference: [OpenClaw tool plugins](https://docs.openclaw.ai/plugins/tool-plugins).
Supabase credentials remain exclusively in the existing RAG service, consistent
with [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control).
