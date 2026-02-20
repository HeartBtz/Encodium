# Encodium

**Video Encoding Platform** — A standalone web application for scanning, browsing, and batch-encoding video files using hardware-accelerated (GPU) or CPU encoders.

![Node.js](https://img.shields.io/badge/node-18%2B-green) ![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Linux-lightgrey)

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
- **HDR Preservation** — 10-bit/HDR10 color metadata detection and passthrough
- **HDR → SDR Tonemapping** — Optional zscale-based tonemap filter chain
- **Dolby Vision Protection** — Skips DV files to avoid data loss
- **Container Choice** — MKV, MP4, or automatic (MKV for AV1)
- **Downscale Presets** — 1080p, 720p, 480p output resolution options
- **GPU → CPU Fallback** — Automatic retry with software decode on hwaccel failure
- **Output Validation** — Checks codec, duration, file integrity after every encode
- **Per-job Logs** — Detailed ffmpeg logs for every encoding job, accessible from UI
- **Crash Recovery** — Stalled jobs automatically re-queued on server restart

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
- **Dark Theme** — Responsive single-page application
- **Authentication** — JWT-based login with admin roles

## Requirements

- **Node.js** 18+ (20 LTS recommended)
- **MariaDB** 10.6+ or MySQL 8+
- **ffmpeg** 6+ with ffprobe
- Optional: NVIDIA GPU with drivers + NVENC, or VA-API/QSV hardware

## Quick Start

```bash
git clone git@github.com:HeartBtz/Encodium.git
cd Encodium
bash install.sh
```

Open **http://localhost:4000** and log in with:
- Email: `admin@encodium.local`
- Password: `admin`

The install script handles dependencies, database creation, `.env` configuration, admin account setup, and PM2 + systemd service registration.

## Process Management

### PM2 (recommended)
```bash
pm2 status
pm2 logs encodium
pm2 restart encodium
pm2 stop encodium
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
| `DB_PASS` | — | Database password |
| `DB_NAME` | `encodium` | Database name |
| `JWT_SECRET` | — | Secret for JWT token signing |
| `PORT` | `4000` | HTTP server port |
| `MEDIA_DIR` | — | Path to your video library |
| `ENCODE_DIR` | `./data/encoded` | Output directory for encoded files |
| `MAX_WORKERS` | `2` | Concurrent encoding workers |

## CLI

```bash
node cli.js scan      # Full scan + enrich + thumbnails
node cli.js enrich    # Re-run ffprobe metadata extraction
node cli.js thumbs    # Generate missing thumbnails
node cli.js clear     # Clear all videos from database
node cli.js stats     # Show database statistics
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
| POST | `/api/enrich` | Enrich video metadata (ffprobe) |
| POST | `/api/thumbs` | Generate missing thumbnails |
| **Videos** | | |
| GET | `/api/videos` | List / search / filter videos |
| GET | `/api/videos/:id` | Single video details |
| POST | `/api/videos/delete` | Bulk delete videos |
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
├── ecosystem.config.js    # PM2 configuration
├── middleware/
│   └── auth.js            # JWT authentication
├── services/
│   ├── encoder.js         # Encoding engine, queue
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
| `videos` | Scanned video files & metadata |
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
