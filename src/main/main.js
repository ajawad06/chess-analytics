const { app, BrowserWindow, ipcMain, shell, nativeImage } = require("electron");

const path = require("path");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const QUERY_CACHE_MAX_ENTRIES = 128;
const REDIS_COMMAND_TIMEOUT_MS = 800;
const REDIS_RETRY_AFTER_MS = 30_000;

let pool = null;
let mainWindow = null;
let moveQueryMeta = null;
const rawQueryCache = new Map();
let redisDisabledUntil = 0;
const APP_ICON_PATH = path.join(__dirname, "..", "..", "assets", "icon.png");
const APP_ICON = nativeImage.createFromPath(APP_ICON_PATH);

function buildDefaultDbConfig() {
  return {
    host: process.env.DB_HOST || "",
    port: process.env.DB_PORT || "",
    database: process.env.DB_NAME || "",
    user: process.env.DB_USER || "",
    password: process.env.DB_PASSWORD || "",
  };
}

let dbState = {
  connected: false,
  config: buildDefaultDbConfig(),
  lastError: null,
};

function clearTransientCaches() {
  rawQueryCache.clear();
  moveQueryMeta = null;
}

function normalizeDbConfig(config = {}) {
  const defaults = buildDefaultDbConfig();
  return {
    host: String(config.host || defaults.host).trim() || defaults.host,
    port: Number.parseInt(config.port || defaults.port, 10) || defaults.port,
    database: String(config.database || defaults.database).trim() || defaults.database,
    user: String(config.user || defaults.user).trim() || defaults.user,
    password:
      config.password !== undefined && config.password !== null
        ? String(config.password)
        : defaults.password,
  };
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function getRedisConfig() {
  const rawUrl = String(process.env.REDIS_URL || "").trim();
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") return null;
    const db = Number.parseInt(url.pathname.replace("/", "") || "0", 10);
    return {
      host: url.hostname || "127.0.0.1",
      port: Number.parseInt(url.port || "6379", 10) || 6379,
      password: url.password ? decodeURIComponent(url.password) : "",
      db: Number.isNaN(db) ? 0 : db,
      tls: url.protocol === "rediss:",
    };
  } catch {
    return null;
  }
}

function encodeRedisCommand(args) {
  const parts = [`*${args.length}\r\n`];
  args.forEach((arg) => {
    const value = String(arg);
    parts.push(`$${Buffer.byteLength(value)}\r\n${value}\r\n`);
  });
  return parts.join("");
}

function parseRedisValue(buffer, offset = 0) {
  if (offset >= buffer.length) return null;

  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;

  if (type === "+") return { value: line, offset: next };
  if (type === "-") throw new Error(line);
  if (type === ":") return { value: Number.parseInt(line, 10), offset: next };

  if (type === "$") {
    const length = Number.parseInt(line, 10);
    if (length === -1) return { value: null, offset: next };
    const end = next + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.toString("utf8", next, end), offset: end + 2 };
  }

  if (type === "*") {
    const length = Number.parseInt(line, 10);
    if (length === -1) return { value: null, offset: next };
    const values = [];
    let currentOffset = next;
    for (let i = 0; i < length; i++) {
      const parsed = parseRedisValue(buffer, currentOffset);
      if (!parsed) return null;
      values.push(parsed.value);
      currentOffset = parsed.offset;
    }
    return { value: values, offset: currentOffset };
  }

  throw new Error("Unsupported Redis response.");
}

function runRedisCommand(args) {
  const config = getRedisConfig();
  if (!config || Date.now() < redisDisabledUntil) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const socketFactory = config.tls ? tls.connect : net.createConnection;
    const socket = socketFactory(
      { host: config.host, port: config.port, timeout: REDIS_COMMAND_TIMEOUT_MS },
      () => {
        const commands = [];
        if (config.password) commands.push(["AUTH", config.password]);
        if (config.db) commands.push(["SELECT", config.db]);
        commands.push(args);
        socket.write(commands.map(encodeRedisCommand).join(""));
      },
    );
    socket.setTimeout(REDIS_COMMAND_TIMEOUT_MS);

    let buffer = Buffer.alloc(0);
    let expectedReplies = 1 + (config.password ? 1 : 0) + (config.db ? 1 : 0);
    let lastValue = null;
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };

    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        let offset = 0;
        while (expectedReplies > 0) {
          const parsed = parseRedisValue(buffer, offset);
          if (!parsed) break;
          lastValue = parsed.value;
          offset = parsed.offset;
          expectedReplies -= 1;
        }

        if (offset > 0) buffer = buffer.subarray(offset);
        if (expectedReplies === 0) settle(resolve, lastValue);
      } catch (err) {
        settle(reject, err);
      }
    });

    socket.on("timeout", () => settle(reject, new Error("Redis command timed out.")));
    socket.on("error", (err) => settle(reject, err));
    socket.on("close", () => {
      if (!settled) settle(reject, new Error("Redis connection closed."));
    });
  }).catch(() => {
    redisDisabledUntil = Date.now() + REDIS_RETRY_AFTER_MS;
    return null;
  });
}

function getCacheNamespace() {
  const cfg = dbState.config || buildDefaultDbConfig();
  return sha1(`${cfg.host}:${cfg.port}:${cfg.database}:${cfg.user}`);
}

function getCacheKeys(scope, cacheKey) {
  const namespace = getCacheNamespace();
  const prefix = `chessanalytics:${namespace}:query-cache`;
  return {
    dataKey: `${prefix}:${scope}:entry:${sha1(cacheKey)}`,
    indexKey: `${prefix}:lru`,
  };
}

function getMemoryCache(cacheKey) {
  if (!rawQueryCache.has(cacheKey)) return null;
  const cached = rawQueryCache.get(cacheKey);
  rawQueryCache.delete(cacheKey);
  rawQueryCache.set(cacheKey, cached);
  return cached;
}

function setMemoryCache(cacheKey, payload) {
  if (rawQueryCache.has(cacheKey)) rawQueryCache.delete(cacheKey);
  rawQueryCache.set(cacheKey, payload);
  while (rawQueryCache.size > QUERY_CACHE_MAX_ENTRIES) {
    const oldestKey = rawQueryCache.keys().next().value;
    rawQueryCache.delete(oldestKey);
  }
}

async function touchRedisCacheKey(indexKey, dataKey) {
  await runRedisCommand(["LREM", indexKey, "0", dataKey]);
  await runRedisCommand(["LPUSH", indexKey, dataKey]);
  const overflowKeys = await runRedisCommand([
    "LRANGE",
    indexKey,
    QUERY_CACHE_MAX_ENTRIES,
    "-1",
  ]);
  if (Array.isArray(overflowKeys) && overflowKeys.length) {
    await runRedisCommand(["DEL", ...overflowKeys]);
  }
  await runRedisCommand(["LTRIM", indexKey, "0", String(QUERY_CACHE_MAX_ENTRIES - 1)]);
}

async function getPersistentCache(scope, cacheKey) {
  const { dataKey, indexKey } = getCacheKeys(scope, cacheKey);
  const value = await runRedisCommand(["GET", dataKey]);
  if (!value) return null;

  try {
    const payload = JSON.parse(value);
    setMemoryCache(`${scope}:${cacheKey}`, payload);
    touchRedisCacheKey(indexKey, dataKey);
    return payload;
  } catch {
    await runRedisCommand(["DEL", dataKey]);
    return null;
  }
}

async function setPersistentCache(scope, cacheKey, payload) {
  setMemoryCache(`${scope}:${cacheKey}`, payload);

  const { dataKey, indexKey } = getCacheKeys(scope, cacheKey);
  const value = JSON.stringify(payload);
  await runRedisCommand(["SET", dataKey, value]);
  await touchRedisCacheKey(indexKey, dataKey);
}

async function getQueryCache(scope, cacheKey) {
  const namespacedKey = `${scope}:${cacheKey}`;
  const cached = getMemoryCache(namespacedKey);
  if (cached) return { ...cached, elapsed: 0, cached: true };

  const persistent = await getPersistentCache(scope, cacheKey);
  if (persistent) return { ...persistent, elapsed: 0, cached: true };

  return null;
}

async function setQueryCache(scope, cacheKey, payload) {
  const cachePayload = { ...payload, cached: false };
  await setPersistentCache(scope, cacheKey, cachePayload);
}

async function closePool() {
  if (!pool) return;
  try {
    await pool.end();
  } catch {
    // ignore close errors
  }
  pool = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#07080d",
    icon: APP_ICON.isEmpty() ? APP_ICON_PATH : APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.setIcon(APP_ICON.isEmpty() ? APP_ICON_PATH : APP_ICON);
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.chessanalytics.desktop");
  }
  createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await closePool();
});

ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:maximize", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on("window:close", () => mainWindow?.close());

ipcMain.on("nav:explorer", () =>
  mainWindow?.loadFile(path.join(__dirname, "..", "renderer", "index.html")),
);
ipcMain.on("nav:analytics", () =>
  mainWindow?.loadFile(path.join(__dirname, "..", "renderer", "analytics.html")),
);
ipcMain.on("nav:opening", () =>
  mainWindow?.loadFile(path.join(__dirname, "..", "renderer", "opening.html")),
);
ipcMain.on("nav:olap", () =>
  mainWindow?.loadFile(path.join(__dirname, "..", "renderer", "olap.html")),
);
ipcMain.on("nav:settings", () =>
  mainWindow?.loadFile(path.join(__dirname, "..", "renderer", "settings.html")),
);
ipcMain.on("shell:openUrl", (_event, url) => shell.openExternal(url));

ipcMain.handle("db:getState", async () => ({
  connected: dbState.connected,
  lastError: dbState.lastError,
  config: { ...dbState.config },
}));

ipcMain.handle("db:disconnect", async () => {
  await closePool();
  clearTransientCaches();
  dbState = {
    connected: false,
    config: dbState.config,
    lastError: null,
  };
  return { success: true };
});

ipcMain.handle("db:connect", async (_event, config) => {
  const nextConfig = normalizeDbConfig(config || {});

  try {
    await closePool();

    pool = new Pool({
      host: nextConfig.host,
      port: nextConfig.port,
      database: nextConfig.database,
      user: nextConfig.user,
      password: nextConfig.password,
      max: 10,
      idleTimeoutMillis: 45000,
      connectionTimeoutMillis: 8000,
    });

    await pool.query("SELECT 1");
    clearTransientCaches();

    dbState = {
      connected: true,
      config: nextConfig,
      lastError: null,
    };

    const countRes = await pool.query("SELECT COUNT(*) FROM games");
    return { success: true, gameCount: Number.parseInt(countRes.rows[0].count, 10) };
  } catch (err) {
    await closePool();
    dbState = {
      connected: false,
      config: nextConfig,
      lastError: err.message,
    };
    return { success: false, error: err.message };
  }
});

ipcMain.handle("db:stats", async () => {
  if (!pool) return { error: "Not connected" };
  try {
    const [games, moves, players] = await Promise.all([
      pool.query("SELECT COUNT(*) AS n FROM games"),
      pool.query(
        "SELECT reltuples::bigint AS n FROM pg_class WHERE relname='moves' AND relkind='r'",
      ),
      pool.query(
        "SELECT reltuples::bigint AS n FROM pg_class WHERE relname='players' AND relkind='r'",
      ),
    ]);
    return {
      games: Number(games.rows[0]?.n || 0),
      moves: Number(moves.rows[0]?.n || 0),
      players: Number(players.rows[0]?.n || 0),
    };
  } catch (err) {
    return { error: err.message };
  }
});

function buildRawQueryCacheKey(sql, params) {
  const normalized = String(sql || "")
    .replace(/\s+/g, " ")
    .trim();
  return JSON.stringify([normalized, params || []]);
}

ipcMain.handle("db:rawQuery", async (_event, sql, params, options) => {
  if (!pool) return { error: "Not connected to database" };

  const safeParams = Array.isArray(params) ? params : [];
  const bypassCache = !!options?.bypassCache;
  const cacheKey = buildRawQueryCacheKey(sql, safeParams);

  if (!bypassCache) {
    const cached = await getQueryCache("raw", cacheKey);
    if (cached) return cached;
  }

  try {
    const start = Date.now();
    const result = await pool.query(sql, safeParams);
    const payload = {
      rows: result.rows,
      count: result.rowCount,
      elapsed: Date.now() - start,
      cached: false,
    };

    await setQueryCache("raw", cacheKey, {
      rows: payload.rows,
      count: payload.count,
    });

    return payload;
  } catch (err) {
    return { error: err.message };
  }
});

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function colorOffsetExpression(alias = "m") {
  return `CASE
    WHEN LOWER(TRIM(${alias}.color::text)) IN ('w', 'white') THEN 0
    WHEN LOWER(TRIM(${alias}.color::text)) IN ('b', 'black') THEN 1
    ELSE 0
  END`;
}

async function numericColumnLooksLikeFullMove(columnName) {
  const res = await pool.query(`
    WITH sampled_games AS (
      SELECT game_id
      FROM moves
      GROUP BY game_id
      ORDER BY game_id DESC
      LIMIT 250
    ),
    slots AS (
      SELECT m.game_id, m.${columnName} AS move_value, COUNT(*)::int AS n
      FROM moves m
      JOIN sampled_games sg ON sg.game_id = m.game_id
      WHERE m.${columnName} IS NOT NULL
      GROUP BY m.game_id, m.${columnName}
    )
    SELECT
      COUNT(*)::int AS slots,
      COUNT(*) FILTER (WHERE n > 1)::int AS duplicated_slots
    FROM slots
  `);

  const slots = Number(res.rows[0]?.slots || 0);
  const duplicatedSlots = Number(res.rows[0]?.duplicated_slots || 0);
  return slots > 0 && duplicatedSlots / slots > 0.25;
}

async function ensureMoveQueryMeta() {
  if (!pool) throw new Error("Not connected to database");
  if (moveQueryMeta) return moveQueryMeta;

  const colRes = await pool.query(`
    SELECT LOWER(column_name) AS column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'moves'
  `);

  const cols = new Set(colRes.rows.map((r) => r.column_name));
  const sanColumn = ["san", "move_san", "san_move"].find((c) => cols.has(c));

  if (!sanColumn) {
    throw new Error("The moves table does not expose a SAN move column.");
  }

  let orderExpr = null;
  let orderKind = null;
  const directPlyColumn = ["ply", "halfmove", "move_index", "ply_index"].find((c) =>
    cols.has(c),
  );

  if (directPlyColumn) {
    orderExpr = `m.${directPlyColumn}`;
    orderKind = "direct";
  } else {
    const ambiguousMoveColumn = ["move_number", "move_no", "move_num"].find((c) =>
      cols.has(c),
    );

    if (ambiguousMoveColumn) {
      const isFullMove =
        cols.has("color") && (await numericColumnLooksLikeFullMove(ambiguousMoveColumn));

      if (isFullMove) {
        const minMoveRes = await pool.query(
          `SELECT MIN(${ambiguousMoveColumn})::int AS min_move FROM moves`,
        );
        const minMove = Number.parseInt(minMoveRes.rows[0]?.min_move, 10);
        const fullMoveBase = Number.isNaN(minMove) ? 1 : minMove;
        orderExpr = `((m.${ambiguousMoveColumn} - ${fullMoveBase}) * 2 + ${colorOffsetExpression("m")})`;
        orderKind = "fullmove";
      } else {
        orderExpr = `m.${ambiguousMoveColumn}`;
        orderKind = "direct";
      }
    }
  }

  if (!orderExpr) {
    throw new Error("The moves table is missing a supported move ordering column.");
  }

  const minPlyRes = await pool.query(`SELECT MIN(${orderExpr})::int AS min_ply FROM moves m`);
  const plyBase = Number.isInteger(minPlyRes.rows[0]?.min_ply)
    ? minPlyRes.rows[0].min_ply
    : Number.parseInt(minPlyRes.rows[0]?.min_ply, 10);

  moveQueryMeta = {
    sanExpr: `TRIM(m.${sanColumn})`,
    orderExpr,
    plyBase: Number.isNaN(plyBase) ? 1 : plyBase,
    orderKind,
  };

  return moveQueryMeta;
}

ipcMain.handle("db:popularMoves", async (_event, payload) => {
  if (!pool) return { error: "Not connected to database" };

  try {
    const history = Array.isArray(payload?.history)
      ? payload.history.map((v) => String(v || "").trim()).filter(Boolean)
      : [];

    const moveLimit = clampInt(payload?.moveLimit, 3, 20, 8);
    const { sanExpr, orderExpr, plyBase } = await ensureMoveQueryMeta();
    const nextPly = plyBase + history.length;
    const bypassCache = !!payload?.forceRefresh;

    // Normalize SAN: handle castling notation variants (O-O vs 0-0)
    const normSan = (san) => san.replace(/0-0-0/g, "O-O-O").replace(/0-0/g, "O-O");
    const normalizedHistory = history.map(normSan);
    const cacheKey = JSON.stringify({
      history: normalizedHistory,
      moveLimit,
      nextPly,
      orderExpr,
      plyBase,
    });

    if (!bypassCache) {
      const cached = await getQueryCache("popular", cacheKey);
      if (cached) return cached;
    }

    // Escape a string for safe inline SQL single-quoted literal
    const lit = (s) => `'${s.replace(/'/g, "''")}'`;

    // Build a self-contained query that inlines history as a VALUES list.
    // This avoids the "could not determine datatype of parameter $1" error
    // that occurs when passing JS arrays as pg parameters.
    const buildSql = (hist, plBase, npPly, limit) => {
      if (hist.length === 0) {
        // No history: sample latest games and get first-move frequencies
        return {
          sql: `
            WITH sample_games AS (
              SELECT g.id AS game_id FROM games g ORDER BY g.id DESC LIMIT ${limit}
            ),
            sample_stats AS (SELECT COUNT(*)::int AS sampled_games FROM sample_games),
            next_moves AS (
              SELECT ${sanExpr} AS san, COUNT(*)::int AS n
              FROM moves m
              JOIN sample_games sg ON sg.game_id = m.game_id
              WHERE ${orderExpr} = ${npPly}
              GROUP BY ${sanExpr}
            )
            SELECT nm.san, nm.n,
              ROUND(100.0 * nm.n / NULLIF(SUM(nm.n) OVER (), 0), 2) AS pct,
              ss.sampled_games
            FROM next_moves nm CROSS JOIN sample_stats ss
            ORDER BY nm.n DESC, nm.san
            LIMIT ${moveLimit}`,
          params: [],
        };
      }

      // Build VALUES rows: each entry is (ply_int, 'san_literal')
      const rows = hist.map((san, i) => `(${plBase + i}, ${lit(san)})`).join(", ");

      return {
        sql: `
          WITH history(ply, san) AS (VALUES ${rows}),
          matched_games AS (
            SELECT m.game_id
            FROM moves m
            JOIN history h
              ON h.ply = ${orderExpr}
             AND (h.san = ${sanExpr}
                  OR REPLACE(h.san, 'O', '0') = REPLACE(${sanExpr}, 'O', '0'))
            GROUP BY m.game_id
            HAVING COUNT(*) = ${hist.length}
          ),
          sample_games AS (
            SELECT game_id FROM matched_games ORDER BY game_id DESC LIMIT ${limit}
          ),
          sample_stats AS (SELECT COUNT(*)::int AS sampled_games FROM sample_games),
          next_moves AS (
            SELECT ${sanExpr} AS san, COUNT(*)::int AS n
            FROM moves m
            JOIN sample_games sg ON sg.game_id = m.game_id
            WHERE ${orderExpr} = ${npPly}
            GROUP BY ${sanExpr}
          )
          SELECT nm.san, nm.n,
            ROUND(100.0 * nm.n / NULLIF(SUM(nm.n) OVER (), 0), 2) AS pct,
            ss.sampled_games
          FROM next_moves nm CROSS JOIN sample_stats ss
          ORDER BY nm.n DESC, nm.san
          LIMIT ${moveLimit}`,
        params: [],
      };
    };

    const attemptLimits = [400_000, 200_000, 100_000, 50_000, 20_000, 10_000];
    let result = null;

    for (const limit of attemptLimits) {
      const { sql, params } = buildSql(normalizedHistory, plyBase, nextPly, limit);
      try {
        result = await pool.query({ text: sql, values: params, statement_timeout: 6000 });
        break;
      } catch (err) {
        if (err.code === "57014") continue;
        throw err;
      }
    }

    if (!result) {
      return { error: "Popular move query timed out." };
    }

    const sampledGames = Number(result.rows[0]?.sampled_games || 0);

    const responsePayload = {
      moves: result.rows.map((r) => ({
        san: r.san,
        count: Number(r.n || 0),
        pct: Number(r.pct || 0),
      })),
      matchedGames: sampledGames,
      sampledGames,
      nextPly,
      sideToMove: (nextPly - plyBase) % 2 === 0 ? "w" : "b",
    };

    await setQueryCache("popular", cacheKey, responsePayload);

    return responsePayload;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("db:query", async (_event, filters) => {
  if (!pool) return { error: "Not connected to database" };

  try {
    const { sql, countSql, params } = buildQuery(filters);
    const cacheKey = buildRawQueryCacheKey(`${sql}\n${countSql}`, params);
    const cached = await getQueryCache("filter", cacheKey);
    if (cached) return cached;

    const start = Date.now();
    const [result, countResult] = await Promise.all([
      pool.query(sql, params),
      pool.query(countSql, params),
    ]);
    const elapsed = Date.now() - start;
    const payload = {
      rows: result.rows,
      count: result.rowCount,
      total: Number.parseInt(countResult.rows[0].total, 10),
      elapsed,
      sql: sql.replace(/\s+/g, " ").trim(),
    };
    await setQueryCache("filter", cacheKey, {
      rows: payload.rows,
      count: payload.count,
      total: payload.total,
      sql: payload.sql,
    });
    return payload;
  } catch (err) {
    return { error: err.message };
  }
});

function buildQuery(f) {
  const gameConds = [];
  const moveConds = [];
  const params = [];
  let pi = 1;

  const addGame = (cond, val) => {
    gameConds.push(cond.replace("?", `$${pi++}`));
    params.push(val);
  };
  const addMove = (cond, val) => {
    moveConds.push(cond.replace("?", `$${pi++}`));
    params.push(val);
  };

  if (f.termination && f.termination !== "any") {
    switch (f.termination) {
      case "Checkmate":
        addGame("TRIM(g.termination) = ?", "Normal");
        moveConds.push("TRUE");
        break;
      case "Resign":
        addGame("TRIM(g.termination) = ?", "Normal");
        gameConds.push(
          "NOT EXISTS (SELECT 1 FROM moves rx WHERE rx.game_id = g.id AND rx.is_checkmate = TRUE)",
        );
        break;
      case "Timeout":
        addGame("TRIM(g.termination) ILIKE ?", "%time%");
        break;
      case "Draw":
        addGame("TRIM(g.result) = ?", "1/2");
        break;
      case "Stalemate":
        addGame("TRIM(g.termination) ILIKE ?", "%stalemate%");
        break;
      case "Abandoned":
        addGame("TRIM(g.termination) ILIKE ?", "%abandon%");
        break;
      default:
        break;
    }
  }

  if (f.result && f.result !== "any") {
    const dbResult = f.result === "1/2-1/2" ? "1/2" : f.result;
    addGame("TRIM(g.result) = ?", dbResult);
  }

  if (f.checkmatePiece && f.checkmatePiece !== "any") {
    addMove("m.piece = ?", f.checkmatePiece.toUpperCase());
  }

  if (f.checkmatedColor && f.checkmatedColor !== "any") {
    const moverColor = f.checkmatedColor === "white" ? "b" : "w";
    addMove("m.color = ?", moverColor);
  }

  if (f.checksquare && f.checksquare !== "any") {
    addMove("m.to_sq = ?", f.checksquare);
  } else {
    if (f.checkFile && f.checkFile !== "any") addMove("m.to_sq LIKE ?", `${f.checkFile}%`);
    if (f.checkRank && f.checkRank !== "any") addMove("m.to_sq LIKE ?", `%${f.checkRank}`);
  }

  if (f.checkmateCapture && f.checkmateCapture !== "any") {
    addMove("m.is_capture = ?", f.checkmateCapture === "yes");
  }

  if (f.capturedPiece && f.capturedPiece !== "any") {
    addMove("m.captured_piece = ?", f.capturedPiece.toUpperCase());
  }

  if (f.timeControl && f.timeControl !== "any") {
    const safe = `CASE WHEN g.time_control ~ '^[0-9]+\\+[0-9]+$'
                  THEN SPLIT_PART(g.time_control,'+',1)::int + SPLIT_PART(g.time_control,'+',2)::int * 40
                  ELSE NULL END`;
    if (f.timeControl === "bullet") gameConds.push(`(${safe}) < 180`);
    else if (f.timeControl === "blitz") gameConds.push(`(${safe}) BETWEEN 180 AND 599`);
    else if (f.timeControl === "rapid") gameConds.push(`(${safe}) BETWEEN 600 AND 1799`);
    else if (f.timeControl === "classical") gameConds.push(`(${safe}) >= 1800`);
  }

  if (f.openingEco && f.openingEco !== "any") {
    addGame("g.opening_eco ILIKE ?", `${f.openingEco}%`);
  }

  if (f.minElo && f.minElo !== "") addGame("LEAST(g.white_elo, g.black_elo) >= ?", Number.parseInt(f.minElo, 10));
  if (f.maxElo && f.maxElo !== "") addGame("GREATEST(g.white_elo, g.black_elo) <= ?", Number.parseInt(f.maxElo, 10));

  if (f.minMoves && f.minMoves !== "") {
    gameConds.push(
      `COALESCE(g.num_moves, (SELECT COUNT(*) FROM moves mv WHERE mv.game_id = g.id)) >= $${pi++}`,
    );
    params.push(Number.parseInt(f.minMoves, 10));
  }
  if (f.maxMoves && f.maxMoves !== "") {
    gameConds.push(
      `COALESCE(g.num_moves, (SELECT COUNT(*) FROM moves mv WHERE mv.game_id = g.id)) <= $${pi++}`,
    );
    params.push(Number.parseInt(f.maxMoves, 10));
  }

  const needsMovesJoin = moveConds.length > 0;
  const lim = Math.min(Number.parseInt(f.limit, 10) || 500, 5000);

  if (needsMovesJoin) {
    const extraMoveConds = moveConds.filter((c) => c !== "TRUE");
    const moveFilter = extraMoveConds.length > 0 ? "AND " + extraMoveConds.join("\n  AND ") : "";
    const gameFilter = gameConds.length > 0 ? "AND " + gameConds.join("\n  AND ") : "";

    const sql = `
SELECT
  g.lichess_id, g.result, g.white_elo, g.black_elo,
  g.opening_eco, g.opening_name, g.time_control, g.termination,
  COALESCE(g.num_moves, (SELECT COUNT(*) FROM moves mc WHERE mc.game_id = g.id)) AS num_moves,
  g.played_at,
  m.piece AS checkmate_piece, m.color AS checkmate_by,
  m.san AS checkmate_move, m.to_sq AS checkmate_square,
  m.from_sq AS piece_from, m.is_capture AS was_capture, m.captured_piece
FROM moves m
JOIN games g ON g.id = m.game_id
WHERE m.is_checkmate = TRUE
  ${gameFilter}
  ${moveFilter}
ORDER BY g.played_at DESC NULLS LAST
LIMIT ${lim}`;

    const countSql = `SELECT COUNT(*) AS total FROM moves m JOIN games g ON g.id = m.game_id WHERE m.is_checkmate = TRUE ${gameFilter} ${moveFilter}`;
    return { sql, countSql, params };
  }

  const whereClause = gameConds.length > 0 ? "WHERE " + gameConds.join("\n  AND ") : "";
  const sql = `
SELECT
  g.lichess_id, g.result, g.white_elo, g.black_elo,
  g.opening_eco, g.opening_name, g.time_control, g.termination,
  COALESCE(g.num_moves, (SELECT COUNT(*) FROM moves mc WHERE mc.game_id = g.id)) AS num_moves,
  g.played_at
FROM games g
${whereClause}
ORDER BY g.played_at DESC NULLS LAST
LIMIT ${lim}`;

  const countSql = `SELECT COUNT(*) AS total FROM games g ${whereClause}`;
  return { sql, countSql, params };
}
