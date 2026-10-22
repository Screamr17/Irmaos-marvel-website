
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
  if (!env.DB) {
    return json({
      error: "Base de dados indisponível."
    }, 503);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT id, name,
             player_1, points_1,
             player_2, points_2,
             player_3, points_3
      FROM bg_seasons
      ORDER BY id DESC
    `).all();

    const items = (result.results || []).map(row => ({
      id: row.id,
      name: row.name,
      players: [
        {
          position: 1,
          name: row.player_1,
          points: row.points_1
        },
        {
          position: 2,
          name: row.player_2,
          points: row.points_2
        },
        {
          position: 3,
          name: row.player_3,
          points: row.points_3
        }
      ]
    }));

    return json({ items });

  } catch (error) {
    console.error("Public BG seasons API:", error);

    return json({
      error: "Não foi possível carregar as temporadas."
    }, 500);
  }
}
