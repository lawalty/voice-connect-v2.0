# Voice Connect Library

This service is owned and released with Voice Connect 2.0. It provides the
management portal, ingestion API and worker, group routing, hybrid retrieval,
local PDF OCR, optional existing Gemini extraction, and signed downloads.

The existing Supabase project, owner, schema, `rag-documents` bucket and
`rag-embed` function remain authoritative. Do not rerun migrations or re-embed
the corpus during deployment. `supabase/migrations` documents the existing
contract and is tested locally; deployment never applies it.

## Provenance

Imported from the running `hermes-supabase-rag:20260824T155930Z` container,
image digest `sha256:a46e1ebeee42b0b8fb9a7d3e4566c2610574c15ed66f3ca9fc012b4800420d98`.
Its application source matches the accepted OCR commit
`28dcc71716c62d89aa137914556eccef6869eea4` (normalizing line endings).
The source-only export SHA-256 was
`a155aa0d2c45b12aee0963e1340cbabec569b7741aa8983af952d9d8b20263e8`.
Tests, pinned dependencies, OCR Dockerfile and schema reference came from that
same accepted source. PT font license notices remain alongside the fonts.

The port changes session validation to VC 2.0's `/api/status`, uses its CSRF
contract, serves the portal at `/rag/`, and uses the VC origin for generated
links. Legacy `hermes` source enum values are retained for database compatibility;
they are provenance, not a network dependency. No Hermes plugin/runtime is loaded.

## Runtime

`ops/compose.yaml` runs the API on host loopback port 18881, behind VC's Caddy.
The worker starts only with the `library-worker` Compose profile. Credentials
are in `/opt/voice-connect-v2/library/rag.env` (root-only), outside the app's
mounted secrets directory. Never commit, log, or serve that file. The API and
worker use the same existing Supabase identity. Agent and operator tokens
remain distinct; agent access does not confer general operator deletion rights.

The browser uses its HttpOnly VC owner session, validated on every API request;
mutations also require the exact origin and session CSRF token. No RAG or
Supabase credential enters browser storage. `/rag/` redirects signed-out users
to Voice Connect. Signed PDF links work without a session until expiry.

## Validation

Install the pinned runtime requirements and dev versions in `pyproject.toml`,
then run `python -m pytest` from this directory. Docker installs Poppler and
Tesseract for local scanned-PDF processing. End-to-end acceptance must also
check current document IDs, search citations, original/generated downloads,
session/CSRF rejection, and a labeled synthetic upload processed by this worker.
