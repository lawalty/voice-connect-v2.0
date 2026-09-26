export interface LibraryGroup { id: string; name: string; slug: string; description: string; }
export interface LibraryDocument { id: string; group_id: string; filename: string; title?: string | null; status: string; document_kind: string; group_name?: string | null; group_slug?: string | null; }
export interface LibraryHit { chunk_id: string; document_id: string; group_name: string; group_slug: string; filename: string; chunk_index: number; content: string; score: number; }
export interface LibrarySearch { query: string; routing_reason: string; ambiguous_group: boolean; searched_groups: { id: string; name: string; slug: string; score: number }[]; hits: LibraryHit[]; }
export interface LibraryLink { document_id: string; filename: string; url: string; expires_in: number; }
