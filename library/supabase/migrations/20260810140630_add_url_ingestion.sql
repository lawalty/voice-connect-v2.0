alter table public.rag_documents
  drop constraint if exists rag_documents_source_check;

alter table public.rag_documents
  add constraint rag_documents_source_check
    check (
      source in (
        'portal',
        'hermes',
        'email',
        'api',
        'url',
        'hermes_generated'
      )
    ),
  validate constraint rag_documents_source_check;

update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream',
  'application/xhtml+xml',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/x-markdown'
]::text[]
where id = 'rag-documents';
