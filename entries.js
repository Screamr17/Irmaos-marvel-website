const SECTIONS = new Set(['membros','grupos','aw','aq','raid','coliseu','bg','bigthing','avisos']);
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function b64(s){const a=s.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(a+'='.repeat((4-a.length%4)%4)),c=>c.charCodeAt(0))}
function decode(s){return JSON.parse(new TextDecoder().decode(b64(s)))}
async function identity(request,env){
 const token=request.headers.get('Cf-Access-Jwt-Assertion');if(!token||!env.ACCESS_TEAM_DOMAIN||!env.ACCESS_AUD)return null;
 const parts=token.split('.');if(parts.length!==3)return null;
 const [h,p,s]=parts;const header=decode(h),payload=decode(p);
 const domain=env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//,'').replace(/\/$/,'');
 const issuer='https://'+domain;
 if(payload.iss!==issuer||!Array.isArray(payload.aud)||!payload.aud.includes(env.ACCESS_AUD)||!payload.exp||payload.exp<=Date.now()/1000||!payload.email||!header.kid||header.alg!=='RS256')return null;
 const res=await fetch(issuer+'/cdn-cgi/access/certs');if(!res.ok)return null;
 const keys=await res.json();const jwk=(keys.keys||[]).find(k=>k.kid===header.kid&&k.kty==='RSA');if(!jwk)return null;
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,b64(s),new TextEncoder().encode(h+'.'+p));if(!ok)return null;
 const email=payload.email.toLowerCase();const allow=(env.OFFICER_EMAILS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
 if(!allow.includes(email))return null;
 return email;
}
export async function onRequest({request,env}){
 try{
  if(!env.DB)return json({error:'Base de dados D1 ainda não configurada.'},503);
  const email=await identity(request,env);if(!email)return json({error:'Acesso não autorizado. Confirma o Cloudflare Access e os e-mails autorizados.'},403);
  const url=new URL(request.url),section=url.searchParams.get('section');if(!SECTIONS.has(section))return json({error:'Área inválida.'},400);
  if(request.method==='GET'){
   const rows=await env.DB.prepare('SELECT id,section,title,content,group_name,updated_by,updated_at FROM entries WHERE section=? ORDER BY id DESC LIMIT 200').bind(section).all();return json({items:rows.results||[],email});
  }
  if(request.method==='POST'){
   const data=await request.json();const title=String(data.title||'').trim(),content=String(data.content||'').trim(),group=String(data.group_name||'').trim();
   if(!title||title.length>120||content.length>4000||group.length>30)return json({error:'Preenche o título (até 120 caracteres) e o conteúdo (até 4000).'},400);
   const result=await env.DB.prepare('INSERT INTO entries(section,title,content,group_name,updated_by) VALUES(?,?,?,?,?)').bind(section,title,content,group,email).run();return json({ok:true,id:result.meta.last_row_id},201);
  }
  if(request.method==='PUT'){
   const data=await request.json(),id=Number(data.id),title=String(data.title||'').trim(),content=String(data.content||'').trim(),group=String(data.group_name||'').trim();
   if(!Number.isSafeInteger(id)||id<1||!title||title.length>120||content.length>4000||group.length>30)return json({error:'Dados inválidos.'},400);
   const result=await env.DB.prepare('UPDATE entries SET title=?,content=?,group_name=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND section=?').bind(title,content,group,email,id,section).run();return json({ok:result.meta.changes>0});
  }
  if(request.method==='DELETE'){
   const id=Number(url.searchParams.get('id'));if(!Number.isSafeInteger(id)||id<1)return json({error:'ID inválido.'},400);
   const result=await env.DB.prepare('DELETE FROM entries WHERE id=? AND section=?').bind(id,section).run();return json({ok:result.meta.changes>0});
  }
  return json({error:'Método não permitido.'},405);
 }catch(e){return json({error:'Erro no servidor. Confirma a configuração Cloudflare.'},500)}
}
