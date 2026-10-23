
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

const limits = { 1: 7, 2: 9, 3: 8 };

function getDB(env) {
  return env.DB;
}

function validGroup(n) {
  return Number.isInteger(n) && n >= 1 && n <= 3;
}

function validTier(n) {
  return Number.isInteger(n) && n >= 1 && n <= 3;
}

function validLine(tier, line) {
  return Number.isInteger(line) &&
    line >= 1 &&
    line <= limits[tier];
}

async function getAssignments(db) {
  const result = await db.prepare(`
    SELECT group_no, tier, line_no, member_id
    FROM aq_assignments
    ORDER BY group_no, tier, line_no
  `).all();

  return result.results || [];
}

export async function onRequestGet({ env }) {
  const db = getDB(env);

  if (!db) {
    return json({ error: "Ligação D1 indisponível." }, 503);
  }

  try {
    return json({
      ok: true,
      items: await getAssignments(db),
      limits
    });
  } catch {
    return json({ error: "Erro ao consultar AQ." }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const db = getDB(env);

  if (!db) {
    return json({ error: "Ligação D1 indisponível." }, 503);
  }

  // IMPORTANTE: a API de escrita deve ser protegida
  // por Cloudflare Access ou validação de sessão
  // no servidor antes de ser utilizada em produção.
  return json({
    error: "Escrita desativada até configurar a autorização dos oficiais."
  }, 403);
}
