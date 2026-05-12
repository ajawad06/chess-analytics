# Chess Analytics

A desktop application for exploring and analysing large game databases. Built with Electron and PostgreSQL, it lets you filter millions of games, inspect checkmate patterns, chart statistics, and walk through opening trees — all from a local database you populate yourself.

---

## Table of Contents

1. [Overview](#overview)
2. [Requirements](#requirements)
3. [Project Structure](#project-structure)
4. [Database Setup](#database-setup)
   - [Installing PostgreSQL](#installing-postgresql)
   - [Creating the Database](#creating-the-database)
   - [Full Schema](#full-schema)
   - [Indexes](#indexes)
5. [Redis Setup (Optional)](#redis-setup-optional)
   - [Installing Redis on Windows](#installing-redis-on-windows)
   - [Installing Redis on macOS / Linux](#installing-redis-on-macos--linux)
   - [Verifying Redis](#verifying-redis)
6. [Environment Variables](#environment-variables)
7. [Ingesting Lichess Data](#ingesting-lichess-data)
   - [Downloading a Database Dump](#downloading-a-database-dump)
   - [Python Dependencies](#python-dependencies)
   - [Running the Ingest Script](#running-the-ingest-script)
   - [Expected Performance](#expected-performance)
8. [Installing and Running the Application](#installing-and-running-the-application)
9. [Building a Distributable](#building-a-distributable)
10. [Application Features](#application-features)
11. [Troubleshooting](#troubleshooting)

---

## Overview

Chess Analytics is an Electron desktop application that connects to a local PostgreSQL database containing Lichess game records. The data pipeline works as follows:

1. You download a monthly PGN dump from Lichess (compressed `.pgn.zst`).
2. You run the Python ingest script, which streams the file, parses every game and every move, and bulk-inserts rows into PostgreSQL.
3. You launch the Electron app, connect to the database through the Settings page, and start exploring.

Redis is optional but strongly recommended. When running, it acts as a persistent query cache across application restarts, dramatically reducing repeated query times for common filters and opening tree lookups.

---

## Requirements

| Requirement | Minimum Version | Notes |
| --- | --- | --- |
| Node.js | 18.x | 20.x or later recommended |
| npm | 9.x | Comes with Node.js |
| PostgreSQL | 14 | 15 or 16 recommended |
| Python | 3.9 | For the ingest script only |
| Redis | 5.0 | Optional. Windows build linked below |

The OLAP page renders its 3D cubes with the local `three` npm package. Do not remove it from `package.json`, and run `npm install` after pulling changes so `node_modules/three` exists before launching the app.

---

## Project Structure

```text
chess-analytics/
├── assets/
│   ├── icon.ico                  Application icon (Windows)
│   └── pieces/                   SVG chess piece images
│       ├── white_pawn.svg
│       ├── white_knight.svg
│       ├── white_bishop.svg
│       ├── white_rook.svg
│       ├── white_queen.svg
│       ├── white_king.svg
│       ├── black_pawn.svg
│       ├── black_knight.svg
│       ├── black_bishop.svg
│       ├── black_rook.svg
│       ├── black_queen.svg
│       └── black_king.svg
├── scripts/
│   └── ingest.py                 One-time data import script
├── src/
│   ├── main/
│   │   ├── main.js               Electron main process — DB, Redis, IPC
│   │   └── preload.js            Context bridge exposing API to renderer
│   └── renderer/
│       ├── index.html            Game explorer page
│       ├── analytics.html        Statistics and chart page
│       ├── opening.html          Opening tree explorer page
│       ├── olap.html             OLAP cube query and 3D visualization page
│       ├── settings.html         Connection and preferences page
│       ├── settings.js           Theme and preferences logic (shared)
│       └── theme.css             CSS custom property overrides (shared)
├── .env                          Your local config (never committed)
├── .env.example                  Template for .env
├── .gitignore
├── package.json
└── README.md
```

The separation between `src/main/` and `src/renderer/` mirrors Electron's own process model. Code in `src/main/` runs in Node.js with full system access. Code in `src/renderer/` runs in the browser context inside the Electron window, communicating with the main process only through the IPC bridge defined in `preload.js`.

---

## Database Setup

### Installing PostgreSQL

Download and install PostgreSQL from the official site: <https://www.postgresql.org/download/>

During installation, note the password you set for the `postgres` superuser — you will need it later. The default port is `5432`; leave it as-is unless you have a specific reason to change it.

After installation, ensure the PostgreSQL `bin` directory is in your system PATH so the `psql` command is available from your terminal.

On Windows this is typically:

```text
C:\Program Files\PostgreSQL\<version>\bin
```

### Creating the Database

Open a terminal and connect to PostgreSQL as the superuser:

```bash
psql -U postgres
```

Create the database:

```sql
CREATE DATABASE chess;
```

Then connect to it:

```sql
\c chess
```

You are now ready to create the schema.

### Full Schema

Run the following SQL in its entirety while connected to the `chess` database. You can paste it directly into `psql` or save it to a file and run `psql -U postgres -d chess -f schema.sql`.

```sql
-- Players table
-- Stores one row per unique Lichess username.
-- The username column carries a unique constraint so the ingest script
-- can use ON CONFLICT DO UPDATE to keep titles current.
CREATE TABLE IF NOT EXISTS players (
    id       SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    title    TEXT,
    CONSTRAINT players_username_unique UNIQUE (username)
);

-- Games table
-- Each row is one Lichess game. lichess_id is the short alphanumeric
-- identifier from the game URL (e.g. "aAbBcCdD" from lichess.org/aAbBcCdD).
-- white_id and black_id are foreign keys into the players table.
-- result stores the PGN result token, truncated to 10 characters:
--   "1-0"   white won
--   "0-1"   black won
--   "1/2"   draw (stored without the trailing "-1/2" for space)
-- opening_eco is the ECO classification code (e.g. "B20").
-- num_moves is an optional denormalised move count. The application
-- falls back to a subquery against the moves table if this is NULL.
CREATE TABLE IF NOT EXISTS games (
    id              SERIAL PRIMARY KEY,
    lichess_id      TEXT NOT NULL,
    played_at       TIMESTAMP,
    time_control    TEXT,
    variant         TEXT,
    result          TEXT,
    termination     TEXT,
    opening_eco     TEXT,
    opening_name    TEXT,
    white_id        INTEGER REFERENCES players(id),
    black_id        INTEGER REFERENCES players(id),
    white_elo       INTEGER,
    black_elo       INTEGER,
    white_elo_diff  INTEGER,
    black_elo_diff  INTEGER,
    num_moves       INTEGER,
    CONSTRAINT games_lichess_id_unique UNIQUE (lichess_id)
);

-- Moves table
-- Each row is one half-move (ply) in a game.
-- game_id references games(id).
-- move_num is the zero-based ply index within the game:
--   0 = white's first move, 1 = black's first move, 2 = white's second, etc.
-- color is 'w' for white or 'b' for black.
-- uci is the move in UCI notation (e.g. "e2e4", "g1f3").
-- san is the move in Standard Algebraic Notation (e.g. "e4", "Nf3").
-- piece is the uppercase piece symbol of the moving piece:
--   P = pawn, N = knight, B = bishop, R = rook, Q = queen, K = king.
-- from_sq and to_sq are the algebraic square names (e.g. "e2", "e4").
-- is_capture is TRUE when the move captures an enemy piece (including en passant).
-- is_check is TRUE when the move delivers check.
-- is_checkmate is TRUE when the move delivers checkmate.
-- captured_piece is the uppercase piece symbol of the captured piece,
--   or NULL if no capture occurred. En passant captures store 'P'.
-- clock_ms is the player's remaining clock time in milliseconds after
--   the move, parsed from the PGN %clk comment. NULL if not present.
CREATE TABLE IF NOT EXISTS moves (
    id             SERIAL PRIMARY KEY,
    game_id        INTEGER NOT NULL REFERENCES games(id),
    move_num       INTEGER NOT NULL,
    color          CHAR(1) NOT NULL,
    uci            TEXT,
    san            TEXT,
    piece          CHAR(1),
    from_sq        TEXT,
    to_sq          TEXT,
    is_capture     BOOLEAN,
    is_check       BOOLEAN,
    is_checkmate   BOOLEAN,
    captured_piece CHAR(1),
    clock_ms       INTEGER,
    CONSTRAINT moves_game_move_unique UNIQUE (game_id, move_num)
);
```

### Indexes

After the ingest is complete, create the following indexes. Do not create them before ingesting — bulk inserts are significantly faster without indexes present, and PostgreSQL will need to maintain each index on every insert.

```sql
-- Primary lookup path for the game explorer and filter queries
CREATE INDEX IF NOT EXISTS idx_games_played_at     ON games(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_result        ON games(result);
CREATE INDEX IF NOT EXISTS idx_games_termination   ON games(termination);
CREATE INDEX IF NOT EXISTS idx_games_opening_eco   ON games(opening_eco);
CREATE INDEX IF NOT EXISTS idx_games_white_elo     ON games(white_elo);
CREATE INDEX IF NOT EXISTS idx_games_black_elo     ON games(black_elo);

-- Move lookups used heavily by the opening explorer and checkmate filter
CREATE INDEX IF NOT EXISTS idx_moves_game_id       ON moves(game_id);
CREATE INDEX IF NOT EXISTS idx_moves_move_num      ON moves(move_num);
CREATE INDEX IF NOT EXISTS idx_moves_san           ON moves(san);
CREATE INDEX IF NOT EXISTS idx_moves_is_checkmate  ON moves(is_checkmate) WHERE is_checkmate = TRUE;
CREATE INDEX IF NOT EXISTS idx_moves_piece         ON moves(piece);
CREATE INDEX IF NOT EXISTS idx_moves_to_sq         ON moves(to_sq);
CREATE INDEX IF NOT EXISTS idx_moves_color         ON moves(color);

-- Player lookups
CREATE INDEX IF NOT EXISTS idx_players_username    ON players(username);
```

Creating indexes on a table with millions of moves will take several minutes. This is normal.

---

## Redis Setup (Optional)

Redis is used as a persistent LRU query cache. Without it, the application still works correctly — it uses an in-memory cache for the current session only. With Redis running, query results are stored to disk and survive application restarts.

The cache key namespace is scoped to your database connection (host, port, database name, and user), so you can safely point multiple instances at different databases without cache collisions.

### Installing Redis on Windows

Redis is not officially supported on Windows, but a reliable community port is available:

**Download:** <https://github.com/tporadowski/redis/releases/tag/v5.0.14.1>

Download `Redis-x64-5.0.14.1.msi` and run the installer. During installation:

- Accept the default installation path (`C:\Program Files\Redis\`).
- Check the box to add Redis to the PATH.
- Check the box to install Redis as a Windows service so it starts automatically with the system.

After installation, verify Redis is running:

```sh
redis-cli ping
```

The response should be `PONG`. If it is not, open the Services panel (`services.msc`), find the Redis service, and start it manually.

### Installing Redis on macOS / Linux

macOS (using Homebrew):

```bash
brew install redis
brew services start redis
```

Ubuntu / Debian:

```bash
sudo apt update
sudo apt install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

Fedora / RHEL:

```bash
sudo dnf install redis
sudo systemctl enable redis
sudo systemctl start redis
```

### Verifying Redis

From any terminal:

```bash
redis-cli ping
```

Expected output: `PONG`

You can also check what keys the application has written after using it:

```bash
redis-cli keys "chessanalytics:*"
```

---

## Environment Variables

Copy `.env.example` to `.env` in the project root:

```bash
cp .env.example .env
```

Then open `.env` and set your values:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=chess
DB_USER=postgres
DB_PASSWORD=your_password_here

REDIS_URL=redis://127.0.0.1:6379
```

Variable reference:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DB_HOST` | Yes | `localhost` | Hostname or IP of the PostgreSQL server |
| `DB_PORT` | Yes | `5432` | Port the PostgreSQL server is listening on |
| `DB_NAME` | Yes | `chess` | Name of the database created earlier |
| `DB_USER` | Yes | `postgres` | PostgreSQL login role |
| `DB_PASSWORD` | Yes | — | Password for `DB_USER` |
| `REDIS_URL` | No | — | Redis connection URL. Omit the variable entirely to disable caching |

The `.env` file is read by the Electron main process at startup using the `dotenv` package. These values pre-populate the connection form in the Settings page. You can override any value at runtime through the UI without editing the file.

If `REDIS_URL` is present but Redis is not reachable, the application logs the failure silently and disables Redis for 30 seconds before retrying. It continues to function using the in-memory cache only.

**Never commit `.env` to version control.** It is listed in `.gitignore`.

---

## Ingesting Lichess Data

### Downloading a Database Dump

Lichess publishes monthly PGN dumps of all rated standard games at:

<https://database.lichess.org/>

Each file is named in the format `lichess_db_standard_rated_YYYY-MM.pgn.zst`. A single month of data is typically 15–25 GB compressed and expands to several hundred GB of PGN text. You do not need to decompress it — the ingest script reads it in streaming fashion directly from the `.zst` file.

Download one month to start. The January 2025 file is a reasonable choice for a first run.

### Python Dependencies

The ingest script requires Python 3.9 or later. Install its dependencies with pip:

```bash
pip install chess psycopg2-binary zstandard
```

If you are using a virtual environment (recommended):

```bash
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install chess psycopg2-binary zstandard
```

### Running the Ingest Script

Open `scripts/ingest.py` and update the two constants at the top of the file:

```python
PGN_ZST_PATH = r"C:\path\to\lichess_db_standard_rated_2025-01.pgn.zst"
DB_DSN       = "dbname=chess user=postgres password=your_password host=localhost port=5432"
```

Set `PGN_ZST_PATH` to the full path of the downloaded `.pgn.zst` file.
Set `DB_DSN` to match the credentials in your `.env` file.

You can also adjust these constants:

| Constant | Default | Description |
| --- | --- | --- |
| `GAME_LIMIT` | `1_000_000` | Maximum number of games to import. Increase to ingest more, or set to a very large number to import the whole file |
| `BATCH_SIZE` | `5_000` | Number of games per database commit. Higher values are faster but use more memory |

Then run the script:

```bash
python scripts/ingest.py
```

Progress is printed to the terminal every `BATCH_SIZE` games:

```text
Opening C:\...\lichess_db_standard_rated_2025-01.pgn.zst ...
  5,000 games | 1,243 games/sec | ETA 13.4 min
  10,000 games | 1,251 games/sec | ETA 13.2 min
  ...
Done! 1,000,000 games in 13.6 minutes.
```

The script is safe to run multiple times. It uses `ON CONFLICT DO NOTHING` for moves and `ON CONFLICT (lichess_id) DO NOTHING` for games, so duplicate games are silently skipped. If you want to extend an existing import, simply raise `GAME_LIMIT` and re-run — already-imported games are skipped and only new ones are added.

### Expected Performance

On a modern desktop with an NVMe SSD and PostgreSQL tuned for bulk loading:

- 1 million games takes approximately 10–20 minutes
- 1 million games produces approximately 35–40 million move rows
- Total database size for 1 million games is approximately 8–12 GB (data + indexes)

If you are ingesting for the first time and want to maximise speed, temporarily apply these PostgreSQL settings before ingesting and revert them afterward:

```sql
-- Apply before ingesting
ALTER SYSTEM SET synchronous_commit = 'off';
ALTER SYSTEM SET wal_buffers = '64MB';
ALTER SYSTEM SET checkpoint_completion_target = 0.9;
SELECT pg_reload_conf();
```

```sql
-- Revert after ingesting
ALTER SYSTEM RESET synchronous_commit;
ALTER SYSTEM RESET wal_buffers;
ALTER SYSTEM RESET checkpoint_completion_target;
SELECT pg_reload_conf();
```

---

## Installing and Running the Application

Install Node.js dependencies:

```bash
npm install
```

Commit `package-lock.json` with the project. It pins the Electron, database, chess engine, and Three.js dependency versions so every machine installs the same working set. Do not commit `node_modules/`; it is generated by `npm install` and intentionally ignored.

Start the application in development mode:

```bash
npm start
```

Or with the dev flag (enables Chromium DevTools):

```bash
npm run dev
```

On first launch, navigate to the Settings page using the gear icon in the top-right of the title bar. Enter your database credentials and click Connect. If the connection succeeds, the game count will be displayed. You can then navigate to any of the other pages.

---

## Building a Distributable

To build a native installer for your platform:

```bash
# Current platform
npm run build

# Specific platforms
npm run build:win    # Windows NSIS installer + portable exe
npm run build:mac    # macOS DMG + zip
npm run build:linux  # AppImage + deb
```

Output is placed in the `dist/` directory. Cross-platform builds (e.g. building a Windows installer from macOS) require additional tooling. Refer to the electron-builder documentation for details: <https://www.electron.build/multi-platform-build>

---

## Application Features

The application has five pages, accessible from the title bar:

**Game Explorer (`index.html`)**
Filter games by result, termination type, time control, ECO opening code, Elo range, and move count. Results are displayed in a sortable table with links that open the game on Lichess. Checkmate-specific filters allow narrowing by the delivering piece, the square the checkmate landed on, and whether the final move was a capture.

**Statistics (`analytics.html`)**
Charts of aggregate data across the loaded database: result distribution, termination breakdown, most common openings, piece capture frequencies, Elo distribution, and game length histograms. All charts use Chart.js and query the database directly.

**Opening Explorer (`opening.html`)**
An interactive chess board showing the most popular responses at each position. Click a move to advance the board; the move list and popularity percentages update to reflect the new position. The explorer queries the moves table using a parameterised history lookup and samples up to 400,000 matching games per position.

**OLAP (`olap.html`)**
Build a three-dimensional aggregation cube from whitelisted chess dimensions such as opening family, time control, Elo band, result, termination, mating side, and mating piece. Choose a measure, apply filters, run the generated OLAP query, then rotate, zoom, hover, and inspect the resulting 3D cube cells.

The OLAP renderer uses the locally installed Three.js module instead of a CDN, so it works offline inside Electron as long as dependencies have been installed.

**Settings (`settings.html`)**
Manage your database connection, choose a colour theme (Classic, Midnight, or Lichess), select a board colour scheme (Wood, Slate, or Green), and toggle compact layout and animation preferences. Preferences are stored in `localStorage` and applied immediately.

## Repository Hygiene

Keep source, configuration templates, assets, `package.json`, and `package-lock.json` in Git. Do not upload generated folders or local data: `node_modules/`, build outputs such as `dist/`, `.env`, Redis/database dumps, PGN downloads, temporary files, logs, or exported CSV/TSV data. Large Lichess files belong outside the repository or under ignored local folders.

---

## Troubleshooting

**The application opens but the Settings page shows a connection error.**
Verify PostgreSQL is running. On Windows, check the Services panel for a service named `postgresql-x64-<version>`. On macOS/Linux, run `pg_isready`. Double-check that `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` in your `.env` match what you configured in PostgreSQL.

**`psql: error: connection to server on socket failed`**
PostgreSQL is not running or is not listening on the expected port. Start the service and confirm with `pg_isready -p 5432`.

**The ingest script fails with `ImportError: No module named 'chess'`**
You have not installed the Python dependencies, or you are running Python from outside the virtual environment. Run `pip install chess psycopg2-binary zstandard` in the environment where you intend to run the script.

**The ingest script fails with `could not connect to server`**
The `DB_DSN` string in `ingest.py` does not match your PostgreSQL configuration. Confirm the host, port, database name, user, and password are correct.

**The opening explorer shows no moves for any position.**
The `moves` table may be empty, or the column names differ from what the application expects. The application auto-detects the SAN column name (`san`, `move_san`, or `san_move`) and the move ordering column (`ply`, `halfmove`, `move_index`, `move_number`, `move_no`, or `move_num`). If your schema uses different names, the application will return an error visible in the browser console.

**Redis is configured but queries are not being cached across restarts.**
Run `redis-cli ping` to confirm Redis is reachable. Check that `REDIS_URL` in `.env` is correctly formatted (`redis://127.0.0.1:6379`). If Redis is running but unreachable from the application, it may be bound to `127.0.0.1` while you are connecting from a different interface — this is the default and correct for local use.

**Queries on the analytics page are very slow.**
Run the index creation statements from the [Indexes](#indexes) section if you have not done so already. Index creation on large tables takes time but makes subsequent queries orders of magnitude faster. You can monitor index creation progress in PostgreSQL 12+ with:

```sql
SELECT phase, blocks_done, blocks_total
FROM pg_stat_progress_create_index;
```
