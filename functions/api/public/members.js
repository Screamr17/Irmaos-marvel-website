const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });

export async function onRequestGet({ env }) {
  try {
    if (!env.DB) {
      return json({ error: 'Base de dados indisponível.' }, 503);
    }

    const result = await env.DB.prepare(
      'SELECT id, group_no, position, name, prestige, role FROM alliance_members ORDER BY group_no, position, id'
    ).all();

    return json({ items: result.results || [] });
  } catch (error) {
    return json({ error: 'Não foi possível carregar os membros.' }, 500);
  }
}
