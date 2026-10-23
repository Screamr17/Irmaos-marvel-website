
 // Cloudflare Pages Function: /api/alliance-data
 // Ficheiro: functions/api/alliance-data.js

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
      ok: false,
      error: "Base de dados indisponível."
    }, 503);
  }

  try {
    const [memberResult, seasonResult] = await Promise.all([
      env.DB.prepare(`
        SELECT id, name, group_no, position
        FROM alliance_members
        ORDER BY group_no ASC, position ASC, name ASC
      `).all(),

      env.DB.prepare(`
        SELECT id, name,
               player_1, points_1,
               player_2, points_2,
               player_3, points_3
        FROM bg_seasons
        ORDER BY id DESC
      `).all()
    ]);

    const members = (memberResult.results || []).map(row => ({
      id: row.id,
      name: row.name,
      group_no: row.group_no,
      position: row.position
    }));

    const bg_seasons = (seasonResult.results || []).map(row => ({
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

    return json({
      ok: true,
      members,
      bg_seasons
    });

  } catch (error) {
    console.error("Alliance data API:", error);

    return json({
      ok: false,
      error: "Não foi possível carregar os dados da aliança. Confirma as tabelas e colunas na D1."
    }, 500);
  }
}
