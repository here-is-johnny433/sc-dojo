// Retro-vincula partidas ya ingeridas cuando un alias cambia de dueño en el
// módulo admin. Las observaciones NO se regeneran aquí (hace falta releer el
// JSON del replay): para eso está `pnpm reprocess-observations <email>`.

import { db } from "./db";

export async function relinkAlias(
  userId: number,
  alias: string
): Promise<{ linkedGames: number }> {
  const r = await db().query(
    `UPDATE game_players SET user_id = $1
     WHERE LOWER(name) = LOWER($2) AND user_id IS NULL`,
    [userId, alias]
  );
  return { linkedGames: r.rowCount ?? 0 };
}

export async function unlinkAlias(userId: number, alias: string): Promise<void> {
  await db().query(
    `UPDATE game_players SET user_id = NULL WHERE user_id = $1 AND LOWER(name) = LOWER($2)`,
    [userId, alias]
  );
}
