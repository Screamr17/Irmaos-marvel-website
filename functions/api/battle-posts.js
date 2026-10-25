
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });

export async function onRequestGet({ env }) {
  try {
    if (!env.BATTLE_DB) {
      return json({ error: "BATTLE_DB não configurado." }, 503);
    }

    const result = await env.BATTLE_DB.prepare(
      `SELECT id, player_name, title, media_key,
              media_type, created_at
       FROM battle_posts
       WHERE status = 'published'
       ORDER BY created_at DESC
       LIMIT 50`
    ).all();

    return json({ items: result.results || [] });
  } catch (error) {
    return json({ error: "Erro ao carregar publicações." }, 500);
  }
}
