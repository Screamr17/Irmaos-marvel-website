
const SECTIONS = new Set([
  'membros', 'grupos', 'aw', 'aq', 'raid',
  'coliseu', 'bg', 'bigthing', 'avisos'
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) {
      return json({ error: 'Base de dados indisponível.' }, 503);
    }

    const url = new URL(request.url);
    const section = url.searchParams.get('section');

    if (!SECTIONS.has(section)) {
      return json({ error: 'Área inválida.' }, 400);
    }

    const result = await env.DB.prepare(
      `SELECT id, section, title, content,
              group_name, updated_at
       FROM entries
       WHERE section = ?
       ORDER BY id DESC
       LIMIT 50`
    ).bind(section).all();

    return json({ items: result.results || [] });

  } catch (error) {
    return json({ error: 'Erro ao carregar informações.' }, 500);
  }
}
