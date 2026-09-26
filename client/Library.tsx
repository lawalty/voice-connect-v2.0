import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, Download, Search } from 'lucide-react';
import Dialog from './Dialog';
import { api } from './api';
import type { LibraryDocument, LibraryGroup, LibraryLink, LibrarySearch } from '../contract/library';
import './library.css';

export default function Library({onClose}:{onClose:()=>void}) {
  const [groups,setGroups]=useState<LibraryGroup[]>([]),[documents,setDocuments]=useState<LibraryDocument[]>([]);
  const [group,setGroup]=useState(''),[query,setQuery]=useState(''),[includeGenerated,setIncludeGenerated]=useState(false);
  const [result,setResult]=useState<LibrarySearch|null>(null),[link,setLink]=useState<LibraryLink|null>(null);
  const [loading,setLoading]=useState(true),[searching,setSearching]=useState(false),[downloading,setDownloading]=useState(''),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();void api<LibraryGroup[]>('/api/library/groups',{signal:controller.signal}).then(setGroups).catch(reason=>{if(!controller.signal.aborted)setError(reason.message);});return()=>controller.abort();},[]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setResult(null);setLink(null);
    const params=new URLSearchParams({limit:'200'});if(group)params.set('group',group);
    void api<LibraryDocument[]>(`/api/library/documents?${params}`,{signal:controller.signal}).then(setDocuments).catch(reason=>{if(!controller.signal.aborted){setDocuments([]);setError(reason.message);}}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[group]);
  async function search(event:FormEvent) {
    event.preventDefault();if(searching)return;setSearching(true);setError('');setResult(null);setLink(null);
    try {setResult(await api<LibrarySearch>('/api/library/search',{method:'POST',body:JSON.stringify({query,include_generated:includeGenerated,...group?{group}:{}})}));}
    catch(reason){setError(reason instanceof Error?reason.message:'The search could not be completed.');}finally{setSearching(false);}
  }
  async function download(id:string) {
    setDownloading(id);setLink(null);setError('');
    try {setLink(await api<LibraryLink>(`/api/library/documents/${id}/signed-link`,{method:'POST',body:'{}'}));}
    catch(reason){setError(reason instanceof Error?reason.message:'The download could not be prepared.');}finally{setDownloading('');}
  }
  const downloadButton=(id:string)=><button className="text-button library-download" disabled={Boolean(downloading)} onClick={()=>void download(id)}><Download size={15}/>{downloading===id?'Preparing…':'Get download'}</button>;
  return <Dialog title="Library" onClose={onClose} wide><div className="library-content">
    <p className="muted">Your shared documents, ready to explore.</p>
    <form className="library-search" onSubmit={event=>void search(event)}>
      <label>Collection<select value={group} disabled={searching} onChange={event=>setGroup(event.target.value)}><option value="">All collections</option>{groups.map(item=><option key={item.id} value={item.slug}>{item.name}</option>)}</select></label>
      <label>Search your documents<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="What would you like to find?" minLength={2} maxLength={4000} required/></label>
      {!group&&<p className="muted">Search automatically selects the most relevant collections. Choose one above to search it directly.</p>}
      <label className="library-checkbox"><input type="checkbox" checked={includeGenerated} onChange={event=>setIncludeGenerated(event.target.checked)}/>Include generated documents in automatic routing</label>
      <div className="library-actions"><button className="button primary" disabled={searching||query.trim().length<2}><Search size={16}/>{searching?'Searching…':'Search library'}</button>{result&&<button type="button" className="text-button" onClick={()=>setResult(null)}>Browse documents</button>}</div>
    </form>
    {error&&<p role="alert" className="error-text">{error}</p>}
    {link&&<p className="library-ready" role="status"><a href={link.url} target="_blank" rel="noopener noreferrer">Open {link.filename}</a><small>Private link · expires in {Math.round(link.expires_in/60)} minutes</small></p>}
    {result?<section aria-label="Search results"><p className="library-summary">{result.hits.length} passages · {result.searched_groups.map(item=>item.name).join(', ')}</p>{result.ambiguous_group&&<p className="muted">More than one collection matched. Choose a collection to narrow the search.</p>}{result.hits.length===0?<p className="muted">No matching passages were found.</p>:<ul className="library-results">{result.hits.map(hit=><li key={hit.chunk_id}><h3>{hit.filename}</h3><small>{hit.group_name} · Chunk {hit.chunk_index}</small><p className="library-passage">{hit.content}</p>{downloadButton(hit.document_id)}</li>)}</ul>}</section>:<section aria-label="Documents"><p className="library-summary" role="status">{loading?'Loading documents…':`${documents.length} documents${documents.length===200?' · showing the first 200; select a collection to narrow the list':''}`}</p>{!loading&&!documents.length&&!error&&<p className="muted">There are no documents in this collection yet.</p>}<ul className="library-documents">{documents.map(doc=><li key={doc.id}><BookOpen size={18}/><div><strong>{doc.title||doc.filename}</strong><small>{doc.group_name||groups.find(item=>item.id===doc.group_id)?.name||'Document'} · {doc.status==='ready'?'Ready':doc.status}</small></div>{doc.status==='ready'&&downloadButton(doc.id)}</li>)}</ul></section>}
  </div></Dialog>;
}
