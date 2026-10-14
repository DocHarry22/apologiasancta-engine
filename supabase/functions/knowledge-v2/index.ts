import { boundedInteger, neighborhood, publicPayload } from "./publicGraph.mjs";
import { createClient } from 'npm:@supabase/supabase-js@2';
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const rawSecrets = Deno.env.get('SUPABASE_SECRET_KEYS');
const key = rawSecrets ? JSON.parse(rawSecrets).default : Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!key) throw new Error('Supabase secret key is not configured');
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(publicPayload(body)), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': status < 400 ? 'public, max-age=30, stale-while-revalidate=120' : 'no-store' } });
const id = (value: string | null) => value && /^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9._:-]*$/.test(value) ? value : null;
async function publishedNode(nodeId: string) { return db.from('knowledge_nodes').select('*').eq('id', nodeId).eq('content_state', 'published').not('published_revision_id', 'is', null).maybeSingle(); }
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const u = new URL(req.url); const path = u.pathname.replace(/^\/functions\/v1\/knowledge-v2/, '').replace(/^\/knowledge-v2/, '').replace(/^\/knowledge/, '') || '/'; let parts: string[]; try { parts = path.split('/').filter(Boolean).map(decodeURIComponent); } catch { return json({error:'Invalid path encoding'},400); }
  try {
    if (parts.length === 0 || parts[0] === 'status') { const { count, error } = await db.from('knowledge_nodes').select('id', { count:'exact', head:true }).eq('content_state','published').not('published_revision_id','is',null); if(error) throw error; return json({ required:true, ready:true, configured:true, nodeCount:count??0, provider:'supabase', service:'knowledge' }); }
    if (parts[0] === 'search') { const q=(u.searchParams.get('q')||'').trim(); if(!q || q.length > 500) return json({error:'q must contain 1 to 500 characters'},400); if(/[(),%\\]/.test(q)) return json({error:'Search contains unsupported filter characters'},400); const limit=boundedInteger(u.searchParams.get('limit'),25,1,100); let query=db.from('knowledge_nodes').select('id,kind,canonical_slug,title,proposition,summary,language,metadata,published_revision_id').eq('content_state','published').not('published_revision_id','is',null).or(`title.ilike.%${q}%,canonical_slug.ilike.%${q}%,proposition.ilike.%${q}%`).limit(limit); const kind=u.searchParams.get('kind'); if(kind) query=query.eq('kind',kind); const {data,error}=await query.order('title'); if(error) throw error; return json({results:data??[]}); }
    if (parts[0] === 'topics' && parts.length === 2) { const {data,error}=await db.from('knowledge_topics').select('*,knowledge_topic_nodes(*)').eq('id',parts[1]).eq('content_state','published').not('published_revision_id','is',null).maybeSingle(); if(error) throw error; if(!data) return json({error:'Knowledge topic not found'},404); return json(data); }
    if (parts[0] === 'topics') { const limit=boundedInteger(u.searchParams.get('limit'),50,1,100); const {data,error}=await db.from('knowledge_topics').select('*').eq('content_state','published').not('published_revision_id','is',null).order('title').limit(limit); if(error) throw error; return json({topics:data??[]}); }
    if (parts[0] === 'paths' && parts.length===2) { const {data,error}=await db.from('knowledge_paths').select('*,knowledge_path_nodes(*)').eq('id',parts[1]).eq('content_state','published').not('published_revision_id','is',null).maybeSingle(); if(error) throw error; if(!data) return json({error:'Knowledge path not found'},404); return json(data); }
    if (parts[0] === 'arguments' && parts[2] === 'coverage') { const {data,error}=await db.from('knowledge_arguments').select('id,title,conclusion_node_id').eq('id',parts[1]).eq('content_state','published').not('published_revision_id','is',null).maybeSingle(); if(error) throw error; if(!data) return json({error:'Knowledge argument not found'},404); return json({argumentId:data.id,conclusionNodeId:data.conclusion_node_id,covered:true}); }
    if (parts[0] === 'arguments' && parts.length===2) { const {data,error}=await db.from('knowledge_arguments').select('*,knowledge_argument_members(*)').eq('id',parts[1]).eq('content_state','published').not('published_revision_id','is',null).maybeSingle(); if(error) throw error; if(!data) return json({error:'Knowledge argument not found'},404); return json(data); }
    if (parts[0] === 'debate' && parts.length===2) { const {data,error}=await db.from('knowledge_arguments').select('*,knowledge_argument_members(*)').eq('id',parts[1]).eq('content_state','published').not('published_revision_id','is',null).maybeSingle(); if(error) throw error; if(!data) return json({error:'Published knowledge argument not found'},404); return json(data); }
    if (parts[0] === 'nodes' && parts[2] === 'assessments') { const nodeId=id(parts[1]); if(!nodeId) return json({error:'Invalid node id'},400); const {data:node,error:ne}=await publishedNode(nodeId); if(ne) throw ne; if(!node) return json({error:'Knowledge node not found'},404); let query=db.from('knowledge_assessments').select('*').eq('node_id',nodeId).eq('node_revision_id',node.published_revision_id).eq('review_state','approved'); const lens=u.searchParams.get('lens'); if(lens) query=query.eq('lens',lens); const {data,error}=await query.order('lens'); if(error) throw error; return json({nodeId,assessments:data??[]}); }
    if (parts[0] === 'nodes' && parts[2] === 'evidence' && parts.length === 3) {
      const nodeId=id(parts[1]); if(!nodeId) return json({error:'Invalid node id'},400);
      const {data:node,error:ne}=await publishedNode(nodeId); if(ne) throw ne; if(!node) return json({error:'Knowledge node not found'},404);
      const {data,error}=await db.from('knowledge_citations').select('*').eq('node_id',nodeId).eq('node_revision_id',node.published_revision_id).eq('review_state','approved').order('id').limit(200);
      if(error) throw error;
      const sourceIds=[...new Set((data??[]).map(c=>c.source_id))];
      const sources=sourceIds.length ? await db.from('knowledge_sources').select('*').in('id',sourceIds).not('published_revision_id','is',null).order('title') : {data:[],error:null};
      if(sources.error) throw sources.error;
      const publishedSources=new Set((sources.data??[]).map(s=>s.id));
      return json({node,citations:(data??[]).filter(c=>publishedSources.has(c.source_id)),sources:sources.data??[]});
    }
    if (parts[0] === 'nodes' && parts[2] === 'arguments') { const nodeId=id(parts[1]); if(!nodeId) return json({error:'Invalid node id'},400); const {data:node,error:ne}=await publishedNode(nodeId); if(ne) throw ne; if(!node) return json({error:'Knowledge node not found'},404); const {data,error}=await db.from('knowledge_argument_members').select('argument_id,role,position,metadata,knowledge_arguments!inner(*)').eq('node_id',nodeId).eq('knowledge_arguments.content_state','published').not('knowledge_arguments.published_revision_id','is',null).order('position'); if(error) throw error; return json({nodeId,arguments:data??[]}); }
    if (parts[0] === 'nodes' && parts.length===2) { const nodeId=id(parts[1]); if(!nodeId) return json({error:'Invalid node id'},400); const {data,error}=await publishedNode(nodeId); if(error) throw error; if(!data) return json({error:'Knowledge node not found'},404); return json(data); }
    if (parts[0] === 'sources' && parts.length===2) { const sourceId=id(parts[1]); if(!sourceId) return json({error:'Invalid source id'},400); const {data,error}=await db.from('knowledge_sources').select('*').eq('id',sourceId).eq('content_state','published').not('published_revision_id','is',null).maybeSingle(); if(error) throw error; if(!data) return json({error:'Knowledge source not found'},404); const citations=await db.from('knowledge_citations').select('*').eq('source_id',sourceId).eq('review_state','approved'); if(citations.error) throw citations.error; return json({...data,citations:citations.data??[]}); }
    if (parts[0] === 'neighborhood' && parts.length === 1) {
      const nodeId=id(u.searchParams.get('nodeId'));
      if(!nodeId) return json({error:'nodeId is required'},400);
      const depth=boundedInteger(u.searchParams.get('depth'),2,0,3);
      const limit=boundedInteger(u.searchParams.get('limit'),120,1,200);
      const {data:root,error:re}=await publishedNode(nodeId);
      if(re) throw re;
      if(!root) return json({error:'Knowledge node not found'},404);
      const payload=await neighborhood(root,depth,limit,
        async (frontier: string[], edgeLimit: number) => {
          const {data,error}=await db.from('knowledge_edges').select('*').not('published_revision_id','is',null)
            .or(`from_node_id.in.(${frontier.join(',')}),to_node_id.in.(${frontier.join(',')})`).order('id').limit(edgeLimit);
          if(error) throw error; return data ?? [];
        },
        async (ids: string[]) => {
          const {data,error}=await db.from('knowledge_nodes').select('*').in('id',ids).not('published_revision_id','is',null).order('id');
          if(error) throw error; return data ?? [];
        });
      const nodeIds=payload.nodes.map((n: {id:string})=>n.id);
      const edgeIds=payload.edges.map((e: {id:string})=>e.id);
      const revisions=new Map(payload.nodes.map((n: {id:string;published_revision_id:string})=>[n.id,n.published_revision_id]));
      const edgeRevisions=new Map(payload.edges.map((e: {id:string;published_revision_id:string})=>[e.id,e.published_revision_id]));
      let assessmentQuery=db.from('knowledge_assessments').select('*').in('node_id',nodeIds).eq('review_state','approved').order('id').limit(limit * 6);
      const lens=u.searchParams.get('lens');
      if(lens && lens !== 'compare') assessmentQuery=assessmentQuery.eq('lens',lens);
      const [assessmentResult, assertionResult]=await Promise.all([
        assessmentQuery,
        edgeIds.length ? db.from('knowledge_edge_assertions').select('*').in('edge_id',edgeIds).eq('review_state','approved').order('id').limit(limit * 6) : Promise.resolve({data:[],error:null})
      ]);
      if(assessmentResult.error) throw assessmentResult.error;
      if(assertionResult.error) throw assertionResult.error;
      return json({...payload,
        assessments:(assessmentResult.data??[]).filter(a=>a.node_revision_id===revisions.get(a.node_id)),
        assertions:(assertionResult.data??[]).filter(a=>a.revision_id===edgeRevisions.get(a.edge_id))});
    }
    if (parts[0] === 'compare' || parts[0] === 'compare' && parts[1] === 'advanced') { const left=id(u.searchParams.get('left')); const right=id(u.searchParams.get('right')); if(!left||!right) return json({error:'left and right canonical node ids are required'},400); const [l,r]=await Promise.all([publishedNode(left),publishedNode(right)]); if(l.error) throw l.error; if(r.error) throw r.error; if(!l.data||!r.data) return json({error:'Both published nodes are required for comparison'},404); const {data,error}=await db.from('knowledge_edges').select('*').eq('content_state','published').not('published_revision_id','is',null).or(`and(from_node_id.eq.${left},to_node_id.eq.${right}),and(from_node_id.eq.${right},to_node_id.eq.${left})`); if(error) throw error; return json({left:l.data,right:r.data,relationships:data??[]}); }
    if (parts[0] === 'timeline') { const limit=boundedInteger(u.searchParams.get('limit'),100,1,200); const {data,error}=await db.from('knowledge_nodes').select('id,kind,title,summary,language,metadata,published_revision_id,updated_at').eq('content_state','published').not('published_revision_id','is',null).eq('kind','event').order('updated_at',{ascending:true}).limit(limit); if(error) throw error; return json({items:data??[]}); }
    return json({error:'Not found'},404);
  } catch(error) { console.error(error); return json({error:'Knowledge service unavailable'},503); }
});
