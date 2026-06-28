const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const SESSION_FILE = path.join(__dirname, "data", "sessions.json");
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const DEV_MODE = false;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

const players = {
  EU: Object.create(null),
  US: Object.create(null),
  AP: Object.create(null),
  CN: Object.create(null)
};

const sessions = Object.create(null);
let lastUpdated = null;
let refreshRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function saveSessions() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));

    console.log(
      "Saved",
      Object.keys(sessions).length,
      "sessions to",
      SESSION_FILE
    );
  } catch (error) {
    console.error("Failed to save sessions:", error.message);
  }
}

function cleanupSessions() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const now = Date.now();
  let removed = 0;

  for (const sessionKey of Object.keys(sessions)) {
    const session = sessions[sessionKey];
    if (!session || typeof session.lastSeen !== "number") {
      continue;
    }

    if (now - session.lastSeen > SIX_HOURS) {
      delete sessions[sessionKey];
      removed += 1;
    }
  }

  if (removed > 0) {
    saveSessions();
    console.log("Expired sessions:", removed);
  }
}

function loadSessions() {
  if (!fs.existsSync(SESSION_FILE)) {
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));

    for (const [sessionKey, session] of Object.entries(raw)) {
      if (!session || typeof session !== "object") {
        continue;
      }

      sessions[sessionKey] = {
        startRank: Number(session.startRank) || 0,
        startMMR: Number(session.startMMR) || 0,
        lastSeen: Number(session.lastSeen) || Date.now()
      };
    }

    console.log("Loaded sessions:", Object.keys(sessions).length);
  } catch (error) {
    console.error("Failed to load sessions:", error.message);
  }
}

function makeHeaders() {
  return {
    "User-Agent": "Mozilla/5.0"
  };
}

async function fetchTextWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: makeHeaders(),
      signal: controller.signal
    });

    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  const { response, text } = await fetchTextWithTimeout(url);

  if (!response.ok) {
    const preview = text ? text.slice(0, 300) : "";
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.body = preview;
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const parseError = new Error("Invalid JSON");
    parseError.cause = error;
    throw parseError;
  }
}

async function retry(fn, label, tries = 3, delayMs = 3000, backoff = 2) {
  let lastError = null;
  let currentDelay = delayMs;

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < tries) {
        console.warn(
          `${label} failed (attempt ${attempt}/${tries}): ${error.message}. Retrying in ${currentDelay}ms`
        );
        await sleep(currentDelay);
        currentDelay *= backoff;
      }
    }
  }

  throw lastError;
}

function buildRegionUrl(region, page) {
  return `https://hearthstone.blizzard.com/en-us/api/community/leaderboardsData?region=${region}&leaderboardId=battlegrounds&page=${page}`;
}

function buildCNUrl(page, seasonId) {
  return `https://webapi.blizzard.cn/hs-rank-api-server/api/game/ranks?page=${page}&page_size=25&mode_name=battlegrounds&season_id=${seasonId}`;
}

async function fetchRegionPage(region, page) {
  const url = buildRegionUrl(region, page);
  return retry(
    () => fetchJson(url),
    `${region} page ${page}`
  );
}

async function fetchCNPage(page, seasonId) {
  const url = buildCNUrl(page, seasonId);
  return retry(
    async () => {
      const data = await fetchJson(url);
      if (data && typeof data === "object" && data.code !== 0) {
        throw new Error(`API code ${data.code}`);
      }
      return data;
    },
    `CN page ${page}`
  );
}

async function updateRegion(region) {
  const startedAt = Date.now();
  try {
    console.log(`Refreshing ${region} leaderboard...`);

    const firstPage = await fetchRegionPage(region, 1);
    const totalPagesRaw = firstPage?.leaderboard?.pagination?.totalPages;
    const totalPages = Number.isFinite(Number(totalPagesRaw))
      ? Number(totalPagesRaw)
      : 166;

    const collectedRows = [];
    const firstRows = Array.isArray(firstPage?.leaderboard?.rows)
      ? firstPage.leaderboard.rows
      : [];
    collectedRows.push(...firstRows);

    const pageTasks = [];
    for (let page = 2; page <= totalPages; page += 1) {
      pageTasks.push(
        fetchRegionPage(region, page)
          .then((data) => ({
            page,
            rows: Array.isArray(data?.leaderboard?.rows) ? data.leaderboard.rows : []
          }))
          .catch((error) => {
            console.error(`${region} page ${page} failed:`, error.message);
            return { page, rows: [] };
          })
      );
    }

    const pageResults = await Promise.all(pageTasks);
    pageResults.sort((a, b) => a.page - b.page);

    for (const result of pageResults) {
      collectedRows.push(...result.rows);
    }

    const nextPlayers = Object.create(null);

    for (const row of collectedRows) {
      const accountId = normalizeName(row?.accountid);
      if (!accountId) {
        continue;
      }

      nextPlayers[accountId] = {
        rank: Number(row?.rank) || 0,
        rating: Number(row?.rating) || 0
      };
    }

    players[region] = nextPlayers;
    console.log(`${region} Players:`, Object.keys(players[region]).length);
    console.log(
      `${region} update complete in`,
      Math.round((Date.now() - startedAt) / 1000),
      "seconds"
    );
  } catch (error) {
    console.error(`${region} update failed:`, error.message);
  }
}

async function updateCNRegion() {
  const startedAt = Date.now();
  try {
    console.log("Refreshing CN leaderboard...");

    const apFirstPage = await fetchRegionPage("AP", 1);
    const seasonId = apFirstPage?.seasonId;
    if (seasonId === undefined || seasonId === null) {
      throw new Error("seasonId not found");
    }

    const firstPage = await fetchCNPage(1, seasonId);
    const total = Number(firstPage?.data?.total) || 0;
    const totalPages = Math.max(1, Math.ceil(total / 25));

    const collectedRows = [];
    const firstRows = Array.isArray(firstPage?.data?.list) ? firstPage.data.list : [];
    collectedRows.push(...firstRows);

    const pageTasks = [];
    for (let page = 2; page <= totalPages; page += 1) {
      pageTasks.push(
        fetchCNPage(page, seasonId)
          .then((data) => ({
            page,
            rows: Array.isArray(data?.data?.list) ? data.data.list : []
          }))
          .catch((error) => {
            console.error(`CN page ${page} failed:`, error.message);
            return { page, rows: [] };
          })
      );
    }

    const pageResults = await Promise.all(pageTasks);
    pageResults.sort((a, b) => a.page - b.page);

    for (const result of pageResults) {
      collectedRows.push(...result.rows);
    }

    const nextPlayers = Object.create(null);

    for (const row of collectedRows) {
      const accountId = normalizeName(row?.battle_tag);
      if (!accountId) {
        continue;
      }

      nextPlayers[accountId] = {
        rank: Number(row?.position) || 0,
        rating: Number(row?.score) || 0
      };
    }

    players.CN = nextPlayers;
    console.log("CN Players:", Object.keys(players.CN).length);
    console.log(
      "CN update complete in",
      Math.round((Date.now() - startedAt) / 1000),
      "seconds"
    );
  } catch (error) {
    console.error("CN update failed:", error.message);
  }
}

async function refreshAllLeaderboards() {
  console.log("=== Refresh started ===", new Date().toISOString());

  const startedAt = Date.now();

  await Promise.allSettled([
    updateRegion("EU"),
    updateRegion("US"),
    updateRegion("AP"),
    updateCNRegion()
  ]);

  cleanupSessions();
  lastUpdated = new Date();

  console.log("Updated:", lastUpdated.toISOString());
  console.log(
    "Refresh cycle finished in",
    Math.round((Date.now() - startedAt) / 1000),
    "seconds"
  );
  console.log("=== Refresh ended ===", new Date().toISOString());
}

function runRefreshCycle() {
  if (refreshRunning) {
    console.log("Refresh already running, skipping tick");
    return;
  }

  refreshRunning = true;
  void (async () => {
    try {
      await refreshAllLeaderboards();
    } catch (error) {
      console.error("Unexpected refresh failure:", error.message);
    } finally {
      refreshRunning = false;
    }
  })();
}

function startRefreshScheduler() {
  runRefreshCycle();
  setInterval(runRefreshCycle, REFRESH_INTERVAL_MS);
}

function serveStaticFile(requestPath, response) {
  let safePath = requestPath;

  if (safePath === "/" || safePath === "") {
    safePath = "/setup.html";
  }

  const resolvedPath = path.resolve(FRONTEND_DIR, "." + safePath);
  const frontendRoot = path.resolve(FRONTEND_DIR) + path.sep;

  if (
    !resolvedPath.startsWith(frontendRoot) &&
    resolvedPath !== path.resolve(FRONTEND_DIR, "setup.html")
  ) {
    response.statusCode = 403;
    response.end("Forbidden");
    return;
  }

  fs.readFile(resolvedPath, (error, data) => {
    if (error) {
      response.statusCode = 404;
      response.end("File not found");
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      CONTENT_TYPES[ext] || "application/octet-stream"
    );
    response.setHeader("Cache-Control", "no-store");
    response.end(data);
  });
}

const server = http.createServer((request, response) => {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  } catch (error) {
    response.statusCode = 400;
    response.end("Bad Request");
    return;
  }

  if (url.pathname === "/player") {
    const accountName = normalizeName(url.searchParams.get("account") || "lagshya");
    const region = String(url.searchParams.get("region") || "EU").toUpperCase();
    const player = players[region]?.[accountName];

    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");

    if (player) {
      const sessionKey = `${region}:${accountName}`;

      if (!sessions[sessionKey]) {
        sessions[sessionKey] = {
          startRank: player.rank,
          startMMR: player.rating,
          lastSeen: Date.now()
        };
        saveSessions();
        console.log("Session started:", sessionKey);
      }

      const session = sessions[sessionKey];
      session.lastSeen = Date.now();
      saveSessions();

      response.end(
        JSON.stringify({
          rank: player.rank,
          rating: player.rating,
          sessionRankChange: session.startRank - player.rank,
          sessionMMRChange: player.rating - session.startMMR
        })
      );
      return;
    }

    response.statusCode = 404;
    response.end("Player not found");
    return;
  }

  serveStaticFile(url.pathname, response);
});

function startServer() {
  loadSessions();

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT}/setup.html`);
  });

  startRefreshScheduler();
}

startServer();