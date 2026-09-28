# Voice Connect Library

Voice Connect 2.0 owns the Library API, management portal and ingestion worker.
The browser and NorthPointe agent use `https://srv2003889.hstgr.cloud`; no request
in that path requires the Hermes host. Supabase remains the source of truth.

## Preserved resources

- Project `orb-knowledge-base` (`fjmfziotgloxkiubldip`), with the same owner ID.
- Tables `rag_groups`, `rag_documents`, `rag_ingestion_jobs`, `rag_chunks`.
- Private `rag-documents` bucket and existing document IDs and originals.
- Existing `rag-embed` function, normalized 384-dimensional `gte-small` vectors.
- Group routing, vector/full-text retrieval and reciprocal-rank fusion.
- Local PDF OCR, optional Gemini extraction, generated PDFs and signed links.

The pre-move inventory on September 28 was 96 ready documents in seven groups.
No document copying, bulk ingestion, migration, ownership rewrite or embedding
change is part of this move. Conversation memory remains separate.

## Using it

Open **Library → Manage Library**. `/rag/` opens in a new tab using the same
Voice Connect owner sign-in. It supports groups, multiple file uploads, public
URLs, ingestion progress, search, downloads and confirmed document deletion.
Signed-out users return to Voice Connect to sign in. Returning to the original
tab preserves the conversation. Refresh the Library to see newly ingested files.

The management portal uses an HttpOnly session and exact-origin/CSRF checks.
API/Supabase credentials never enter browser storage. The stronger operator
authority comes from the authenticated owner session. The agent retains its
separate existing credential and four tools: `vc_library_groups`,
`vc_library_documents`, `vc_library_search`, `vc_library_download`.

The backend is in `library/`. See its README for source provenance and tests.
Legacy database values such as `hermes-generated-documents` remain for schema
compatibility; they do not cause calls to Hermes.

## Deployment and worker handoff

1. Publish and test the source. Provision the same existing Supabase, owner,
   agent/operator and link-signing credentials over SSH, without logging them.
   Store the root-only env file at `/opt/voice-connect-v2/library/rag.env`,
   outside the application container's mounted secrets directory.
2. Deploy the API on loopback 18881. Its public origin is the VC origin;
   its session authority is `http://127.0.0.1:18880/api/status`. Caddy routes
   `/rag/*`, `/v1/*` and `/share/documents/*` to it. Generated links therefore
   use the new host; original downloads remain private Supabase signed URLs.
3. Compare document IDs, metadata, group IDs, retrieval and downloads before
   transferring work. Record an inventory and the current releases for rollback.
4. Wait for active ingestion jobs to finish, stop the old RAG worker and disable
   its restart policy, then start the VC `library-worker` Compose profile.
   Create `/opt/voice-connect-v2/library/worker-enabled` only after this handoff.
   Future VC releases use that marker to preserve worker ownership.
5. Update only `plugins.entries.vc-shared-library.config.baseUrl` in OpenClaw
   to the VC origin, retaining the existing token file and memory configuration.
   Preserve its config backup and wait for active voice turns before restarting.
6. Verify the public portal with real owner-session authentication, refusal of
   unauthenticated/forged requests, read parity, both download types, and a
   labeled synthetic upload through the new worker. Delete only that QA upload.

The old API can remain a secondary client of the same Supabase project for
existing Hermes users and old signed links. It is not needed by VC or NorthPointe.
Do not restart the old worker during a later Hermes deployment. No Hermes agent,
conversation, or existing document is deleted by this migration.

## Rollback

Preserve the prior VC image/release, Caddyfile and OpenClaw config. To roll back
worker ownership, first stop the VC worker and remove its enable marker, then
restore the old worker's restart policy and start it. Never intentionally run
both workers during a cutover. Restore the old client API URL and old Caddyfile
before reverting the app. Existing Supabase data remains valid on either release;
do not restore an old database snapshot over newly ingested documents.

The move changes runtime ownership, not measured retrieval quality. Broad answer
quality across Work, church administration and Bible study still requires a
separate question-and-evidence evaluation.
