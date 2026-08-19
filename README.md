# Starcraft Dojo

Plataforma personal de análisis de replays de **StarCraft: Brood War Remastered**: importa tus `.rep` desde varias máquinas, extrae toda la data con [screp](https://github.com/icza/screp), la visualiza en un dashboard propio (y en Google Looker Studio), y te entrena con un **coach IA con memoria** que sigue la metodología de práctica deliberada del "ciclo dojo".

## Arranque rápido (local)

```bash
docker compose up -d --build
```

La app queda en **http://localhost:3000**. La contraseña inicial está en `.env.initial-password.txt` (cámbiala con `pnpm set-password "nueva"` y reinicia: `docker compose restart web`).

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

## Estructura

- `app/` — Next.js (dashboard, partidas, detalle con gráficas, chat, login)
- `lib/ingest.ts` — pipeline: screp → derivaciones (build orders, observaciones heurísticas, evaluación de objetivo) → Postgres
- `db/schema.sql` — esquema + vistas para Looker Studio (`v_my_games`, `v_matchup_stats`, `v_map_stats`, `v_monthly_trend`)
- `watchers/` — auto-subida por máquina (bash/launchd y PowerShell/Task Scheduler)
- `Dockerfile` + `docker-compose.yml` — stack completo (Caddy + web con screp + Postgres 16)

## Deploy a VPS e integración con Looker Studio

Ver [README-DEPLOY.md](README-DEPLOY.md).

## Seguridad

Single-user: login con bcrypt + cookie HMAC firmada, rate limit, middleware que protege todo; watchers con token secreto; uploads solo `.rep` con límite de tamaño y nombres re-generados por hash; el agente consulta la DB con un rol de **solo lectura**; Postgres sin puerto público por defecto.
