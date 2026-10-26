
// IRMÃOS MARVEL — Cloudflare Pages Functions /api/members
// D1 binding: DB. Configure ACCESS_TEAM_DOMAIN e ACCESS_AUD.

const reply=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const fail=(message,status=400)=>reply({error:message},status);
const fields='id, group_no, position, name, prestige, role, updated_by, updated_at';
const cleanMember=m=>({id:m.id,group_no:m.group_no,position:m.position,name:m.name,prestige:m.prestige,role:m.role,updated_by:m.updated_by,updated_at:m.updated_at});
const safeId=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const decode=s=>{const x=s.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(x.padEnd(Math.ceil(x.length/4)*4,'=')),c=>c.charCodeAt(0));};

async function authorize(request,env){
 const domain=String(env.ACCESS_TEAM_DOMAIN||'').replace(/^https?:\/\//,'').replace(/\/$/,'');
 const audience=String(env.ACCESS_AUD||'');
 if(!domain||!audience)throw Object.assign(Error('Configura ACCESS_TEAM_DOMAIN e ACCESS_AUD nas variáveis Cloudflare Pages.'),{status:503});
 const token=request.headers.get('Cf-Access-Jwt-Assertion');
 if(!token)throw Object.assign(Error('Inicia sessão através do Cloudflare Access.'),{status:401});
 const parts=token.split('.');if(parts.length!==3)throw Object.assign(Error('Sessão inválida.'),{status:401});
 try{
  const header=JSON.parse(new TextDecoder().decode(decode(parts[0])));
  const payload=JSON.parse(new TextDecoder().decode(decode(parts[1])));
  if(header.alg!=='RS256'||!header.kid)throw Error('Algoritmo inválido');
  const issuer=`https://${domain}`;
  if(payload.iss!==issuer||!Array.isArray(payload.aud)||!payload.aud.includes(audience)||!Number.isFinite(payload.exp)||payload.exp*1000<=Date.now()||!Number.isFinite(payload.iat)||payload.iat*1000>Date.now()+60000)throw Error('Token expirado ou inválido');
  const r=await fetch(`${issuer}/cdn-cgi/access/certs`);
  if(!r.ok)throw Error('Certificados Access indisponíveis');
  const jwks=await r.json();const jwk=(jwks.keys||[]).find(k=>k.kid===header.kid&&k.kty==='RSA');if(!jwk)throw Error('Chave de assinatura não encontrada');
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const verified=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
  if(!verified)throw Error('Assinatura inválida');
  const email=String(payload.email||'').toLowerCase();if(!email)throw Error('Email ausente');
  // Cloudflare Access deve restringir o acesso aos oficiais.
  const allow=String(env.OFFICER_EMAILS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  if(allow.length&&!allow.includes(email))throw Object.assign(Error('Não tens permissão de oficial.'),{status:403});
  return email;
 }catch(e){if(e.status===403)throw e;throw Object.assign(Error('Sessão Cloudflare Access não validada.'),{status:401});}
}

async function all(db){return (await db.prepare(`SELECT ${fields} FROM alliance_members ORDER BY group_no,position,id`).all()).results||[];}
async function one(db,id){return await db.prepare(`SELECT ${fields} FROM alliance_members WHERE id=?`).bind(id).first();}

async function record(db,action,before,after,email,extras={}){
 const m=after||before;
 await db.prepare('INSERT INTO member_history (action,member_id,member_name,details,officer_email) VALUES (?,?,?,?,?)').bind(action,m?.id||null,m?.name||'Jogador',JSON.stringify({before:before?cleanMember(before):null,after:after?cleanMember(after):null,...extras}),email).run();
}

async function bodyOf(request){try{return await request.json()}catch{throw Object.assign(Error('JSON inválido.'),{status:400})}}

function validate(input){
 const name=String(input.name||'').trim(),prestige=Number(input.prestige),group=Number(input.group_no),role=String(input.role||'');
 if(!name||name.length>100||!Number.isSafeInteger(prestige)||prestige<0||prestige>9999999||![1,2,3].includes(group)||!['','OFICIAL','LÍDER'].includes(role))throw Object.assign(Error('Verifica nome, prestígio, grupo e cargo.'),{status:400});
 return {name,prestige,group,role};
}

async function compact(db,group){
 const rows=(await db.prepare('SELECT id,position FROM alliance_members WHERE group_no=? ORDER BY position,id').bind(group).all()).results||[];
 for(let i=0;i<rows.length;i++)if(rows[i].position!==i+1)await db.prepare('UPDATE alliance_members SET position=? WHERE id=?').bind(i+1,rows[i].id).run();
}

async function handle({request,env}){
 if(!env.DB)return fail('Binding D1 DB não configurado.',503);
 const email=await authorize(request,env);
 const db=env.DB,method=request.method;

 if(method==='GET'){
  if(new URL(request.url).searchParams.get('action')==='history')return reply({items:(await db.prepare('SELECT id,action,member_id,member_name,details,officer_email,created_at FROM member_history ORDER BY id DESC LIMIT 100').all()).results||[]});
  return reply({items:await all(db),email});
 }

 const data=await bodyOf(request);

 if(method==='POST'&&data.action==='swap'){
  const a=safeId(data.first_id),b=safeId(data.second_id);if(!a||!b||a===b)return fail('Seleciona dois jogadores diferentes.');
  const beforeA=await one(db,a),beforeB=await one(db,b);if(!beforeA||!beforeB||beforeA.group_no===beforeB.group_no)return fail('A troca exige jogadores de grupos diferentes.');
  await db.batch([
   db.prepare('UPDATE alliance_members SET group_no=?,position=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(beforeB.group_no,beforeB.position,email,a),
   db.prepare('UPDATE alliance_members SET group_no=?,position=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(beforeA.group_no,beforeA.position,email,b)
  ]);
  await record(db,'swap',beforeA,await one(db,a),email,{other_member:beforeB.name});
  await record(db,'swap',beforeB,await one(db,b),email,{other_member:beforeA.name});
  return reply({ok:true});
 }

 if(method==='POST'&&data.action==='undo')return fail('Desfazer pelo histórico requer validação transacional adicional; não está ativado nesta versão.',501);

 if(method==='POST'){
  const x=validate(data);
  const count=await db.prepare('SELECT COUNT(*) AS n FROM alliance_members WHERE group_no=?').bind(x.group).first();
  if(count.n>=10)return fail('O grupo G'+x.group+' já tem 10 jogadores.',409);
  const pos=(await db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM alliance_members WHERE group_no=?').bind(x.group).first()).p;
  const r=await db.prepare('INSERT INTO alliance_members (group_no,position,name,prestige,role,updated_by) VALUES (?,?,?,?,?,?)').bind(x.group,pos,x.name,x.prestige,x.role,email).run();
  await record(db,'create',null,await one(db,r.meta.last_row_id),email);return reply({ok:true},201);
 }

 if(method==='PUT'){
  const id=safeId(data.id),x=validate(data);if(!id)return fail('ID inválido.');
  const before=await one(db,id);if(!before)return fail('Jogador não encontrado.',404);
  let pos=before.position;
  if(x.group!==before.group_no){
   const count=await db.prepare('SELECT COUNT(*) AS n FROM alliance_members WHERE group_no=?').bind(x.group).first();if(count.n>=10)return fail('O grupo G'+x.group+' já tem 10 jogadores.',409);
   pos=(await db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM alliance_members WHERE group_no=?').bind(x.group).first()).p;
  }
  await db.prepare('UPDATE alliance_members SET name=?,prestige=?,group_no=?,position=?,role=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(x.name,x.prestige,x.group,pos,x.role,email,id).run();
  if(x.group!==before.group_no)await compact(db,before.group_no);
  await record(db,'update',before,await one(db,id),email);return reply({ok:true});
 }

 if(method==='DELETE'){
  const id=safeId(data.id);if(!id)return fail('ID inválido.');const before=await one(db,id);if(!before)return fail('Jogador não encontrado.',404);
  await db.prepare('DELETE FROM alliance_members WHERE id=?').bind(id).run();await compact(db,before.group_no);
  await record(db,'delete',before,null,email);return reply({ok:true});
 }

 return fail('Método não permitido.',405);
}

async function route(context){
 try{return await handle(context)}
 catch(e){
  console.error('members API',e);
  return fail(e.status?e.message:'Erro interno na API.',e.status||500);
 }
}

export const onRequestGet=route;
export const onRequestPost=route;
export const onRequestPut=route;
export const onRequestDelete=route;
