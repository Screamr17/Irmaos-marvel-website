// Cloudflare Pages Function: /api/public/likes
// Usa a binding D1 existente: env.DB. Não requer login.
const COOKIE='im_like_anon';
const HEADERS={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const reply=(body,status=200,cookie)=>new Response(JSON.stringify(body),{status,headers:{...HEADERS,...(cookie?{'Set-Cookie':cookie}:{})}});
function parseCookies(request){
 const found=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='));
 const val=found?.slice(COOKIE.length+1)||'';
 return /^[a-f0-9]{32}$/.test(val)?val:null;
}
function identity(request){
 let token=parseCookies(request), cookie;
 if(!token){token=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  cookie=`${COOKIE}=${token}; Path=/api/public/likes; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
 }
 return {token,cookie};
}
async function hashToken(token){
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
 return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
function validId(id){return typeof id==='string'&&id.length>0&&id.length<=2048;}
async function state(db,id,voter){
 const row=await db.prepare('SELECT COUNT(*) AS total, MAX(CASE WHEN voter_hash = ? THEN 1 ELSE 0 END) AS liked FROM notice_likes WHERE notice_id = ?').bind(voter,id).first();
 return {count:Number(row?.total||0),liked:!!row?.liked};
}
export async function onRequestGet({request,env}){
 if(!env.DB)return reply({error:'Binding DB em falta'},503);
 try{
  const url=new URL(request.url), raw=url.searchParams.get('ids');
  let ids=JSON.parse(raw||'[]');
  if(!Array.isArray(ids)||ids.length>50||!ids.every(validId))return reply({error:'IDs inválidos'},400);
  ids=[...new Set(ids)];
  const {token,cookie}=identity(request), voter=await hashToken(token), likes={};
  for(const id of ids)likes[id]=await state(env.DB,id,voter);
  return reply({likes},200,cookie);
 }catch(e){return reply({error:'Não foi possível consultar gostos'},500);}
}
export async function onRequestPost({request,env}){
 if(!env.DB)return reply({error:'Binding DB em falta'},503);
 const origin=request.headers.get('Origin');
 if(origin && origin!==new URL(request.url).origin)return reply({error:'Origem não permitida'},403);
 const token=parseCookies(request);
 if(!token)return reply({error:'Atualiza a página antes de votar'},403);
 try{
  const body=await request.json(),id=body?.id;
  if(!validId(id))return reply({error:'ID inválido'},400);
  const voter=await hashToken(token);
  // Toggle por visitante: a chave única impede votos duplicados do mesmo navegador.
  const existing=await env.DB.prepare('SELECT 1 FROM notice_likes WHERE notice_id = ? AND voter_hash = ?').bind(id,voter).first();
  if(existing){await env.DB.prepare('DELETE FROM notice_likes WHERE notice_id = ? AND voter_hash = ?').bind(id,voter).run();}
  else{await env.DB.prepare('INSERT OR IGNORE INTO notice_likes (notice_id,voter_hash) VALUES (?,?)').bind(id,voter).run();}
  return reply(await state(env.DB,id,voter));
 }catch(e){return reply({error:'Não foi possível guardar o gosto'},500);}
}
