# Encodium

**Video Encoding Platform** — A standalone web application for scanning, browsing, and batch-encoding video files using hardware-accelerated (GPU) or CPU encoders.

![Node.js](https://img.shields.io/badge/node-18%2B-green) ![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Linux-lightgrey)

## Screenshots

| Library & Dashboard | Encoding Queue |
|---|---|
| ![Library](Screenshots/Encodium_menu.png) | ![Encoding](Screenshots/Encodium_encodage.png) |

| Library (alternate view) | Logs |
|---|---|
| ![Library 2](Screenshots/encodium_menu2.png) | ![Logs](Screenshots/Encodium_logs.png) |

## Features

### Core
- **Media Scanner** — Recursively scans a configured directory, indexes files by folder, extracts metadata with ffprobe, generates thumbnails
- **Video Library** — Browse, search, filter by filename, folder, codec, resolution, size, and duration
- **Video Streaming** — HTML5 player with HTTP range-request support, directly from the UI
- **Hardware Detection** — Auto-detects NVIDIA NVENC, AMD/Intel VA-API, Intel QSV, and CPU encoders
- **Batch Encoding** — Select multiple videos, encode with H.265/HEVC or AV1 using detected presets
- **Multi-GPU Support** — Automatic load-balanced distribution across multiple GPUs
- **Database Sync** — Remove orphan entries and discover new files without a full rescan

### Encoding Engine
- **Size Guard** — Rejects encodes that are larger than the original, keeping the source intact
- **Skip Flag** — Videos where encoding produced a larger file are flagged (`encode_skip`) to prevent re-encoding; filter by skip status in the library; force re-encode from UI
- **HDR Preservation** — 10-bit/HDR10 color metadata detection and passthrough
- **HDR → SDR Tonemapping** — Optional zscale-based tonemap filter chain
- **Dolby Vision Protection** — Skips DV files to avoid data loss
- **Container Choice** — MKV, MP4, or automatic (MKV for AV1)
- **Downscale Presets** — 1080p, 720p, 480p output resolution options
- **GPU → CPU Fallback** — Automatic retry with software decode on hwaccel failure
- **Output Validation** — Checks codec, duration, file integrity after every encode
- **Per-job Logs** — Detailed ffmpeg logs for every encoding job, accessible from UI
- **Crash Recovery** — Stalled jobs automatically re-queued on server restart; orphan ffmpeg processes killed; stale temp files cleaned up

### Queue & Scheduling
- **Queue Management** — Configurable worker count (1–8), cancel/retry/delete jobs
- **Job Priority & Reorder** — Move jobs up/down in the queue
- **Clear Queue** — Remove finished/errored/cancelled jobs from the queue
- **Schedule Window** — Restrict encoding to a daily time window
- **Persistent Savings** — Encoding savings tracked in a permanent ledger (survives queue clears and rescans)

### Presets & Notifications
- **Custom Presets** — Create reusable encoding presets (codec, CQ, container, downscale, tonemap)
- **Webhook Notifications** — Discord and generic HTTP webhook at queue completion

### UI & Monitoring
- **Real-time Progress** — Server-Sent Events (SSE) for live encode progress, log streaming
- **Stats Dashboard** — Video count, total size, duration, codec distribution, encoding savings
- **Encoding Charts** — Daily savings history and before/after size comparison (Chart.js)
- **Shift-click Range Selection** — Select multiple videos at once with Shift+click
- **Select All (filtered)** — Select all videos matching the current search/filter across all pages
- **Dark Theme** — Responsive single-page application
- **Internationalization** — 14 languages (EN, FR, DE, ES, IT, PT, NL, PL, RU, TR, AR, JA, KO, ZH)
- **Authentication** — JWT-based login with admin roles

## Requirements

- **Node.js** 18+ (20 LTS recommended)
- **MariaDB** 10.6+ or MySQL 8+
- **ffmpeg** 6+ with ffprobe
- Optional: NVIDIA GPU with drivers + NVENC, or VA-API/QSV hardware

## Quick Start

### Bare metal

```bash
git clone git@github.com:HeartBtz/Encodium.git
cd Encodium
bash install.sh
```

The install script handles **everything**: Node.js, MariaDB, ffmpeg, npm dependencies, database creation, `.env` configuration, admin account, PM2 + systemd service.

### Docker

```bash
git clone git@github.com:HeartBtz/Encodium.git
cd Encodium
docker compose up -d                         # CPU only
docker compose --profile gpu up -d           # NVIDIA GPU
docker compose exec encodium node cli.js useradd admin@example.com yourpassword
```

Open **http://localhost:4000** and log in with:
- Email: `admin@encodium.local`
- Password: `admin`

> **Warning:** Change the admin password after first login!

## Process Management

### PM2 (recommended)
```bash
pm2 status
pm2 logs encodium
pm2 restart encodium
pm2 stop encodium

# After editing ecosystem.config.js, you must delete + start (restart won't reload config):
pm2 delete encodium && pm2 start ecosystem.config.js
```

### Systemd
```bash
sudo systemctl status encodium
sudo systemctl restart encodium
journalctl -u encodium -f
```

## Manual Setup

```bash
npm install

mysql -u root -e "CREATE DATABASE encodium CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -e "CREATE USER 'encodium'@'localhost' IDENTIFIED BY 'yourpassword';"
mysql -u root -e "GRANT ALL ON encodium.* TO 'encodium'@'localhost'; FLUSH PRIVILEGES;"

cp .env.example .env   # Edit with your settings
node server.js
```

## Configuration (.env)

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | MariaDB host |
| `DB_PORT` | `3306` | MariaDB port |
| `DB_USER` | `encodium` | Database user |
| `DB_PASS` | — | **Required.** Server exits if not set |
| `DB_NAME` | `encodium` | Database name |
| `JWT_SECRET` | — | **Strongly recommended.** Random ephemeral secret used if not set (tokens lost on restart) |
| `NODE_ENV` | — | Set to `production` to hide error details from clients |
| `PORT` | `4000` | HTTP server port |
| `MEDIA_DIR` | — | Path to your video library |
| `ENCODE_DIR` | `./data/encoded` | Output directory for encoded files |
| `THUMB_DIR` | `./data/thumbs` | Thumbnail storage directory |
| `MAX_WORKERS` | `2` | Concurrent encoding workers |

> **Warning:** `DB_PASS` is **mandatory** — the server refuses to start without it. If `JWT_SECRET` is not set, a random secret is generated at startup and all existing tokens are invalidated on each restart.

## Security

Encodium includes several security measures:

- **Helmet** — HTTP security headers (HSTS, X-Frame-Options, etc.)
- **Rate limiting** — 600 requests/min per IP on API routes + **10 requests/15 min** on login
- **JWT authentication** — All API routes require a valid Bearer token (ephemeral secret generated if `JWT_SECRET` not set)
- **Bcrypt passwords** — User passwords hashed with bcryptjs (cost 10–12)
- **Parameterized SQL** — All database queries use prepared statements (no SQL injection)
- **Input validation** — Sort columns, pagination, route IDs validated & whitelisted
- **Error sanitization** — Internal error messages hidden from clients in production (`NODE_ENV=production`)
- **Webhook SSRF protection** — Only `http(s)` URLs accepted; private/internal IPs blocked
- **Graceful shutdown** — SIGTERM/SIGINT drain active jobs and close DB connections cleanly
- **DB_PASS required** — Server refuses to start without a database password

### Recommendations for production
- Set `NODE_ENV=production` (hides stack traces and internal errors)
- Set a strong, random `JWT_SECRET` (≥ 32 characters) — **tokens are invalidated on restart if not set**
- Set a strong `DB_PASS` — **the server will not start without it**
- Run behind a reverse proxy (nginx/Caddy) with TLS
- Restrict network access to the MariaDB port
- Use firewall rules to limit who can reach port 4000

## CLI

```bash
node cli.js scan      # Full scan + enrich + thumbnails
node cli.js enrich    # Re-run ffprobe metadata extraction
node cli.js thumbs    # Generate missing thumbnails
node cli.js clear     # Clear all videos from database
node cli.js stats     # Show database statistics
node cli.js useradd <email> <password>   # Create admin user
```

## API

| Method | Path | Description |
|---|---|---|
| **Auth** | | |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Current user info |
| **Scanner** | | |
| POST | `/api/scan` | Start media scan |
| GET | `/api/scan/progress` | Scan progress |
| POST | `/api/scan/cancel` | Cancel scan |
| POST | `/api/sync` | Sync database (orphan removal + new file discovery) |
| GET | `/api/sync/progress` | Sync progress |
| POST | `/api/enrich` | Enrich video metadata (ffprobe) |
| GET | `/api/enrich/progress` | Enrich progress |
| POST | `/api/thumbs` | Generate missing thumbnails |
| GET | `/api/thumbs/progress` | Thumbnails progress |
| **Videos** | | |
| GET | `/api/videos` | List / search / filter videos (paginated) |
| GET | `/api/videos/ids` | All video IDs matching current filters |
| GET | `/api/videos/:id` | Single video details |
| POST | `/api/videos/delete` | Bulk delete videos |
| POST | `/api/videos/clear-skip` | Clear encode_skip flag for given IDs |
| GET | `/api/folders` | Folder list with counts |
| GET | `/api/codec-stats` | Codec distribution |
| GET | `/api/stats` | Dashboard stats (videos, jobs, savings) |
| GET | `/api/stats/history` | Daily encoding stats (last 30 days) |
| GET | `/api/thumb/:id` | Thumbnail (on-the-fly generation if missing) |
| GET | `/api/stream/:id` | Video stream (range requests) |
| **Encoding** | | |
| GET | `/api/encode/capabilities` | Detected hardware + presets |
| GET | `/api/encode/status` | Encoder queue status |
| GET | `/api/encode/history` | Encode job history |
| POST | `/api/encode/enqueue` | Enqueue encoding jobs |
| POST | `/api/encode/cancel/:id` | Cancel a job |
| POST | `/api/encode/cancel-all` | Cancel all pending jobs |
| POST | `/api/encode/clear-finished` | Clear finished/errored/cancelled jobs |
| POST | `/api/encode/retry/:id` | Retry a failed job |
| DELETE | `/api/encode/job/:id` | Delete a job |
| GET | `/api/encode/job/:id/log` | View detailed job log |
| POST | `/api/encode/job/:id/priority` | Set job priority |
| POST | `/api/encode/job/:id/move` | Move job up/down in queue |
| POST | `/api/encode/workers` | Set worker count |
| **Settings** | | |
| GET/POST | `/api/settings/schedule` | Encoding schedule window |
| GET/POST | `/api/settings/notifications` | Webhook configuration |
| GET/POST/DELETE | `/api/custom-presets` | Custom preset CRUD |
| **Other** | | |
| GET | `/api/events` | SSE stream (live updates) |
| GET | `/api/logs` | Recent application logs |
| POST | `/api/clear` | Clear database (admin only) |

## Supported Encoders

### Hardware
- **NVIDIA NVENC**: H.265, AV1 (multi-GPU load balancing)
- **AMD/Intel VA-API**: H.265, AV1
- **Intel QSV**: H.265, AV1

### Software
- **libx265**: H.265/HEVC
- **SVT-AV1**: AV1 (recommended CPU encoder)
- **libaom-av1**: AV1 (fallback)

## Architecture

```
Encodium/
├── server.js              # Express entry point
├── db.js                  # MariaDB schema, migrations, helpers
├── scanner.js             # Media scanner, metadata enrichment, sync
├── cli.js                 # CLI commands
├── install.sh             # Installation script
├── Dockerfile             # Multi-stage Docker build
├── docker-compose.yml     # Docker Compose (CPU + GPU profiles)
├── ecosystem.config.js    # PM2 configuration
├── middleware/
│   └── auth.js            # JWT authentication
├── services/
│   ├── encoder.js         # Encoding engine, queue, SSE
│   ├── gpu-detect.js      # Hardware detection
│   └── logger.js          # Centralized logging + SSE
├── routes/
│   └── api.js             # All API endpoints
├── public/
│   ├── index.html         # SPA shell
│   ├── css/style.css      # Dark theme
│   ├── js/app.js          # Frontend application
│   └── img/               # Static assets
└── data/
    ├── logs/              # Per-job ffmpeg logs
    ├── thumbs/            # Generated thumbnails
    └── encoded/           # Encoded output staging
```

## Database Schema

| Table | Purpose |
|---|---|
| `users` | Admin authentication |
| `videos` | Scanned video files & metadata (includes `encode_skip` flag) |
| `encode_jobs` | Encoding queue & job history |
| `settings` | Key-value app settings |
| `encoding_savings` | Permanent encoding savings ledger |
| `custom_presets` | User-defined encoding presets |

## Debugging

1. **Job log** — Click 📋 on any job in the encode queue
2. **Application logs** — Logs tab in the web UI
3. **PM2 logs** — `pm2 logs encodium`
4. **Job log files** — `cat data/logs/job_<id>.log`

## License

MIT
