# Deploy a VPS + Looker Studio

Runbook para poner Starcraft Dojo en internet con HTTPS y conectar Google Looker Studio.

## 1. Requisitos

- Un VPS (Ubuntu 22.04+; 1 GB RAM alcanza) — Hetzner, DigitalOcean, etc.
- Un dominio o subdominio (ej. `dojo.tudominio.com`) apuntando con un registro **A** a la IP del VPS.

## 2. Preparar el VPS

```bash
# como root en el VPS
apt update && apt install -y docker.io docker-compose-v2 git ufw
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

## 3. Subir el proyecto

```bash
git clone <tu-repo> starcraft-dojo && cd starcraft-dojo
cp .env.example .env
```

Edita `.env` de producción:
- Genera secretos nuevos: `openssl rand -base64 32` para `POSTGRES_PASSWORD`, `READONLY_DB_PASSWORD`, `SESSION_SECRET`, `UPLOAD_TOKEN`.
- `ANTHROPIC_API_KEY`: tu key.
- `COOKIE_SECURE=true` y `DOMAIN=dojo.tudominio.com`.

## 4. Levantar

```bash
docker compose --profile prod up -d --build
```

Caddy emite el certificado HTTPS automáticamente (Let's Encrypt). Verifica: `https://dojo.tudominio.com` → login.

## 4b. Crear el usuario admin (bootstrap)

El login es por **correo + contraseña**: la primera cuenta la crea `pnpm migrate:multiuser`, que corre desde tu Mac (la imagen de producción no lleva los scripts) contra la base del VPS por un túnel SSH:

```bash
# terminal 1 — túnel al Postgres del VPS (publica el puerto solo dentro del VPS)
ssh -N -L 5433:127.0.0.1:5432 root@VPS

# terminal 2 — en el repo, en tu Mac
DATABASE_URL=postgres://dojo:POSTGRES_PASSWORD@127.0.0.1:5433/starcraft_dojo \
  pnpm migrate:multiuser --password "tu-contraseña"
```

(El túnel necesita que el servicio `db` publique `127.0.0.1:5432:5432` en `docker-compose.yml` — el mismo mapeo que pide Looker Studio más abajo.)

Crea `stephan.tinschert@gmail.com` con rol admin, registra los alias de `MY_ALIASES` y asigna al admin todo el historial que no tenga dueño. Es idempotente. Los demás jugadores se crean desde **/admin** en la UI; para recuperar una contraseña, por el mismo túnel: `DATABASE_URL=... pnpm set-password <correo> "nueva"`.

### Upgrade de una instalación mono-usuario existente

El esquema solo se aplica en la primera inicialización del volumen, así que en un despliegue que ya existía hay que aplicarlo a mano y luego migrar:

```bash
# en el VPS
docker compose cp db/schema.sql db:/tmp/schema.sql
docker compose exec db psql -U dojo -d starcraft_dojo -f /tmp/schema.sql
# el init del rol readonly tampoco se re-ejecuta: retíralo de las tablas privadas
docker compose exec db psql -U dojo -d starcraft_dojo -c "REVOKE SELECT ON users, player_aliases, agent_notes, training_goals, goal_checks, chat_conversations, chat_messages, game_observations, game_commentary FROM dojo_readonly;"
# después, el bootstrap de arriba (reusa AUTH_PASSWORD_HASH y MY_ALIASES del .env)
docker compose up -d --build   # el servicio web ya no necesita esas dos variables
```

Las cookies de sesión anteriores dejan de ser válidas (el token cambió de formato): todos vuelven a entrar con correo + contraseña.

## 5. Migrar tus datos locales (opcional)

En tu Mac:
```bash
docker compose exec db pg_dump -U dojo starcraft_dojo > dump.sql
docker compose cp web:/data/replays ./replays-backup
scp dump.sql root@VPS:~/starcraft-dojo/ && scp -r replays-backup root@VPS:~/starcraft-dojo/
```
En el VPS:
```bash
cat dump.sql | docker compose exec -T db psql -U dojo starcraft_dojo
docker compose cp ./replays-backup/. web:/data/replays
```
(O simplemente re-corre `pnpm ingest --url https://dojo.tudominio.com` desde tu Mac.)

## 6. Watchers

En cada máquina: `./install.sh https://dojo.tudominio.com TU_UPLOAD_TOKEN` (Mac) o `install.ps1` (Windows). Listo — cada partida que juegues aparece sola.

## 7. Looker Studio

Looker Studio necesita alcanzar Postgres directamente:

1. En `docker-compose.yml`, descomenta el mapeo `"5432:5432"` del servicio `db` y `docker compose --profile prod up -d`.
2. Restringe el puerto a las IPs de Google o al menos actívalo con firewall:
   ```bash
   ufw allow 5432/tcp   # mínimo; ideal: restringir por IP de origen
   ```
3. En [Looker Studio](https://lookerstudio.google.com): **Crear → Fuente de datos → PostgreSQL**:
   - Host: IP del VPS · Puerto: 5432 · Base: `starcraft_dojo`
   - Usuario: `dojo_readonly` · Contraseña: tu `READONLY_DB_PASSWORD`
   - Marca **habilitar SSL** si lo configuraste; el usuario es de solo lectura por diseño.
4. Conecta estas vistas (una fuente de datos por vista):
   - `v_my_games` — partida por partida (para tablas y series temporales)
   - `v_matchup_stats` — winrate por matchup (gráfico de barras)
   - `v_map_stats` — winrate por mapa
   - `v_monthly_trend` — evolución mensual de winrate/APM/EAPM (líneas)

Sugerencia de reporte: página 1 con scorecards (winrate, APM) + serie mensual; página 2 con desgloses por matchup y mapa; filtro de rango de fechas sobre `played_at`.

## 8. Backups

```bash
# cron diario en el VPS (crontab -e)
0 5 * * * cd /root/starcraft-dojo && docker compose exec -T db pg_dump -U dojo starcraft_dojo | gzip > /root/backups/dojo-$(date +\%F).sql.gz
```
Los `.rep` originales viven en el volumen `replays` — cópialo con `docker compose cp web:/data/replays /root/backups/replays` o rsync.

## 9. Actualizar

```bash
git pull && docker compose --profile prod up -d --build
```
