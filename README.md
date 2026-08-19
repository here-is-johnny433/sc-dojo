# Starcraft Dojo

Plataforma personal de análisis de replays de **StarCraft: Brood War Remastered**: importa tus `.rep` desde varias máquinas, extrae toda la data con [screp](https://github.com/icza/screp), la visualiza en un dashboard propio (y en Google Looker Studio), y te entrena con un **coach IA con memoria** que sigue la metodología de práctica deliberada del "ciclo dojo".

## Arranque rápido (local)

```bash
docker compose up -d --build
```

La app queda en **http://localhost:3000**. El primer arranque crea la base vacía: para tener con qué entrar, crea el usuario admin (una sola vez) con

```bash
pnpm migrate:multiuser --password "tu-contraseña"
```

que además migra el historial de la etapa mono-usuario (ver "Multi-usuario"). Después se entra con **correo + contraseña**; para cambiar una contraseña: `pnpm set-password <correo> "nueva"`.

## Multi-usuario

Cada jugador tiene su cuenta (correo + contraseña, rol `admin` o `player`) y una o más **cuentas de Battle.net** (alias) registradas. Al importar un replay, cada jugador se vincula por alias, así que una partida entre dos usuarios registrados aparece en el dojo de ambos con su propia perspectiva (victoria/derrota, APM, matchup).

- **Estadísticas** (dashboard, lista de partidas): visibles entre jugadores, con un selector de jugador.
- **Privado por usuario**: objetivos, notas del coach, chat, observaciones y comentarios del replay. El admin ve todo.
- **Módulo admin** (`/admin`, solo rol admin): crear jugadores, cambiar rol, activar/desactivar y gestionar alias. Al añadir un alias, las partidas ya importadas con ese nombre se revinculan al instante (te dice cuántas). Para regenerar además sus observaciones: `pnpm reprocess-observations <correo>`.
- Un alias pertenece a un solo jugador; el correo es la llave de la cuenta.

### Importar tus replays existentes (esta Mac)

```bash
pnpm ingest
```

Escanea `~/Library/Application Support/Blizzard/StarCraft/Maps/Replays` (incluye AutoSave) y sube todo a la plataforma. Los duplicados se detectan por hash — puedes correrlo cuantas veces quieras.

### El coach

Necesitas una API key de Anthropic ([console.anthropic.com](https://console.anthropic.com)) en el `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Reinicia (`docker compose restart web`) y visita **/chat**. El coach:
- consulta tus partidas con SQL y lee replays a fondo,
- guarda notas persistentes sobre tus patrones y progreso,
- gestiona tu **objetivo de entrenamiento activo** (un solo foco a la vez, medible),
- y cada replay que entra se evalúa automáticamente contra ese objetivo.

## Watchers (subida automática desde cada máquina)

En cada máquina donde juegas, instala el watcher para que los replays nuevos se suban solos:

**macOS**
```bash
cd watchers/mac && ./install.sh https://TU-URL TU_UPLOAD_TOKEN
```

**Windows** (PowerShell)
```powershell
cd watchers\windows
.\install.ps1 -Url https://TU-URL -Token TU_UPLOAD_TOKEN
```

El `UPLOAD_TOKEN` está en tu `.env`. Corre cada 5 minutos; el servidor deduplica por hash.

## Capa B — re-simulación (OpenBW)

screp te da los **comandos** de la partida. La capa B te da el **estado del juego**:
cada replay se vuelve a simular con [OpenBW](https://github.com/OpenBW/openbw) (el
build WASM de [titan-reactor](https://github.com/alexpineda/titan-reactor)) y se
muestrea **cada 12 frames** (~2 muestras por segundo de juego), guardando posición,
tipo, dueño y vida de cada unidad viva, más minerales/gas/supply por jugador. Eso es
lo que reproduce el visor de replays.

### Flujo

1. **Extraer los datos del juego** (una sola vez por máquina, necesita SC:R instalado):

   ```bash
   pnpm extract-bwdata                     # lee el CASC de /Applications/StarCraft
   pnpm extract-bwdata --sc-dir "C:\Program Files (x86)\StarCraft"
   ```

   Deja ~46 MB (1149 archivos) en `./data/bwdata/`. Requiere el addon nativo
   `casclib`, que solo hace falta para este paso — mira la cabecera de
   `scripts/extract-bwdata.ts` para la receta de compilación en macOS. Si ya tienes
   un volcado crudo de otra máquina: `pnpm extract-bwdata --from-dir <dir>`.

2. **Levantar el worker**:

   ```bash
   docker compose up -d --build resim
   docker compose logs -f resim
   ```

   Cada 15 s toma una partida con `resim_status = 'pending'`, la simula (~1-4 s por
   replay, timeout duro de 120 s en un proceso hijo aparte) y escribe
   `/data/replays/resim/<gameId>.bin.gz`. Estados en la tabla `games`:
   `pending → running → done | failed` (`resim_error` guarda el motivo), y `skipped`
   para las partidas de práctica: **OpenBW no implementa la IA de computadora**, así
   que cualquier replay con un jugador Computer aborta y se descarta antes de simular.

   ```sql
   SELECT resim_status, COUNT(*) FROM games GROUP BY 1;
   ```

   Para re-simular todo tras un cambio de formato:
   `UPDATE games SET resim_status='pending' WHERE NOT is_practice;`

3. **Comprobar un archivo** (decodificador de referencia del formato):

   ```bash
   node resim/verify.js data/.../<gameId>.bin.gz 9000
   ```

### Formato `DJR1`

Gzip de un buffer little-endian: magic `"DJR1"`, `uint32 headerLen`, header JSON
(`version`, `gameId`, `frames`, `fps`, `sampleStep`, `sampleCount`, `players[]` con
el **PlayerID de screp**, y `types` con nombre/edificio/tamaño de cada typeId que
aparece), y luego una muestra por sample: `uint32 frame`, un bloque de
`uint16 minerals, gas, supplyUsed, supplyMax` por jugador (supply en medias
unidades, como internamente en BW), `uint16 unitCount` y un registro de 10 bytes por
unidad (`tag, typeId, ownerIdx, x, y, hpPct`). Las muertes no se guardan: se derivan
diffeando los `tag` entre muestras consecutivas. Una partida de 33 min ocupa ~1 MB.

### ⚠️ Licencia de los assets

`./data/bwdata` contiene fragmentos de GRP/DAT/tilesets **propiedad de Blizzard**,
extraídos de tu propia instalación de SC:R. Están en `.gitignore`, **no** se copian a
ninguna imagen Docker (se montan read-only en runtime) y **no se pueden
redistribuir**. Cada máquina que corra el worker necesita generar los suyos con
`pnpm extract-bwdata` desde una copia con licencia del juego.

## Estructura

- `app/` — Next.js (dashboard, partidas, detalle con gráficas, chat, login)
- `lib/ingest.ts` — pipeline: screp → derivaciones (build orders, observaciones heurísticas, evaluación de objetivo) → Postgres
- `db/schema.sql` — esquema (incluye `users`, `player_aliases` y la vista por jugador `v_player_games`) + vistas para Looker Studio (`v_my_games`, `v_matchup_stats`, `v_map_stats`, `v_monthly_trend`)
- `resim/` — worker de re-simulación OpenBW (capa B) + `verify.js`, el decodificador de referencia del formato `DJR1`
- `watchers/` — auto-subida por máquina (bash/launchd y PowerShell/Task Scheduler)
- `Dockerfile` + `docker-compose.yml` — stack completo (Caddy + web con screp + Postgres 16)

## Deploy a VPS e integración con Looker Studio

Ver [README-DEPLOY.md](README-DEPLOY.md).

## Seguridad

Login por usuario con bcrypt + cookie HMAC firmada (lleva id y rol; los datos privados se filtran por `user_id` en el servidor), rate limit por IP+correo, middleware que protege todo y bloquea `/admin` a quien no sea admin; watchers con token secreto; uploads solo `.rep` con límite de tamaño y nombres re-generados por hash; el agente consulta la DB con un rol de **solo lectura**; Postgres sin puerto público por defecto.
