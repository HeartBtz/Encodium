# Encodium

**Video Encoding Platform** — A standalone web application for scanning, browsing, searching, and batch-encoding video files using hardware-accelerated (GPU) or CPU encoders.

## Features

- **Media Scanner** — Recursively scans a configured directory for video files, indexes them by folder structure, extracts metadata with ffprobe, and generates thumbnails
- **Video Library** — Browse, search, and filter your video collection by filename, folder, codec, resolution, size, and duration
- **Hardware Detection** — Automatically detects NVIDIA GPUs (NVENC), AMD/Intel VA-API, Intel QSV, and CPU encoders
- **Batch Encoding** — Select multiple videos and encode them with H.265/HEVC or AV1 using detected hardware presets
- **Multi-GPU Support** — Distributes encoding jobs across multiple GPUs with automatic load balancing
- **Live Progress** — Real-time encoding progress via Server-Sent Events (SSE)
- **Replace Original** — Option to replace source files with encoded output (cross-filesystem safe)
- **Queue Management** — Configurable worker count, cancel/retry/delete jobs
- **Authentication** — JWT-based login with admin roles
- **Dark Theme UI** — Responsive single-page application

## Requirements

- **Node.js** 18+ (20 LTS recommended)
- **MariaDB** 10.6+ or MySQL 8+
- **ffmpeg** with ffprobe (for metadata extraction, thumbnails, and encoding)
- Optional: NVIDIA GPU with drivers + NVENC support, or VA-API/QSV capable hardware

## Quick Start

```bash
# Clone
git clone git@github.com:HeartBtz/Encodium.git
cd encodium

# Run the install script (installs deps, sets up DB, creates .env and admin account)
bash install.sh

# Start the server
node server.js
```

Open **http://localhost:3001** and log in with:
- Email: `admin@encodium.local`
- Password: `admin`

## Manual Setup

```bash
# 1. Install Node.js dependencies
npm install

# 2. Create the database
mysql -u root -e "CREATE DATABASE encodium CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -e "CREATE USER 'encodium'@'localhost' IDENTIFIED BY 'yourpassword';"
mysql -u root -e "GRANT ALL ON encodium.* TO 'encodium'@'localhost'; FLUSH PRIVILEGES;"

# 3. Create .env from example
cp .env.example .env
# Edit .env with your DB credentials, MEDIA_DIR, ENCODE_DIR, etc.

# 4. Start
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
| `PORT` | `3001` | HTTP server port |
| `MEDIA_DIR` | — | Path to your video library to scan |
| `ENCODE_DIR` | `./data/encoded` | Output directory for encoded files |
| `MAX_WORKERS` | `2` | Concurrent encoding workers |

## CLI

```bash
node cli.js scan      # Scan MEDIA_DIR, enrich metadata, generate thumbnails
node cli.js enrich    # Re-run ffprobe metadata extraction
node cli.js thumbs    # Generate missing thumbnails
node cli.js clear     # Clear all videos from database
node cli.js stats     # Show database statistics
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Login (email + password) |
| GET | `/api/auth/me` | Current user info |
| POST | `/api/scan` | Start media scan |
| GET | `/api/scan/progress` | Scan progress |
| POST | `/api/scan/cancel` | Cancel scan |
| POST | `/api/enrich` | Enrich video metadata |
| POST | `/api/thumbs` | Generate thumbnails |
| GET | `/api/videos` | List/search videos (q, folder, codec, sort, order, page, limit) |
| GET | `/api/videos/:id` | Single video details |
| GET | `/api/folders` | Folder list with counts |
| GET | `/api/codec-stats` | Codec distribution |
| GET | `/api/stats` | Dashboard stats |
| GET | `/api/thumb/:id` | Thumbnail image |
| GET | `/api/encode/capabilities` | Detected hardware + presets |
| GET | `/api/encode/status` | Encoder queue status |
| GET | `/api/encode/history` | Encode job history |
| POST | `/api/encode/enqueue` | Enqueue encoding jobs |
| POST | `/api/encode/cancel/:id` | Cancel a job |
| POST | `/api/encode/cancel-all` | Cancel all pending |
| POST | `/api/encode/retry/:id` | Retry a failed job |
| DELETE | `/api/encode/job/:id` | Delete a job |
| POST | `/api/encode/workers` | Set worker count |
| GET | `/api/events` | SSE stream (live updates) |
| POST | `/api/clear` | Clear database (admin) |

## Supported Codecs

### Hardware (if available)
- **NVIDIA NVENC**: H.265, AV1 (multi-GPU with automatic load balancing)
- **AMD/Intel VA-API**: H.265, AV1
- **Intel QSV**: H.265, AV1

### Software (CPU)
- **libx265**: H.265/HEVC
- **SVT-AV1**: AV1 (recommended CPU encoder)
- **libaom-av1**: AV1 (slow, fallback)

## Architecture

```
encodium/
├── server.js              # Express entry point
├── db.js                  # MariaDB schema + helpers
├── scanner.js             # Media directory scanner
├── cli.js                 # CLI commands
├── install.sh             # Installation script
├── middleware/
│   └── auth.js            # JWT authentication
├── services/
│   ├── encoder.js         # Encoding engine + queue
│   └── gpu-detect.js      # Hardware detection
├── routes/
│   └── api.js             # All API endpoints
├── public/
│   ├── index.html         # SPA shell
│   ├── css/style.css      # Dark theme styles
│   ├── js/app.js          # Frontend application
│   └── img/               # Static assets
└── data/
    ├── thumbs/            # Generated thumbnails
    └── encoded/           # Encoded output files
```

## License

MIT
