const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const SESSION_FILE = path.join(__dirname, "data", "sessions.json");
const DEV_MODE = false;

const players = {
  EU: {},
  US: {},
  AP: {},
  CN: {}
};

const sessions = {};
let lastUpdated = null;

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

function saveSessions() {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify(sessions, null, 2)
  );
}

function cleanupSessions() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  let removed = 0;
  const now = Date.now();

  for (const sessionKey of Object.keys(sessions)) {
    const session = sessions[sessionKey];
    if (!session || typeof session.lastSeen !== "number") {
      continue;
    }

    if (now - session.lastSeen > SIX_HOURS) {
      delete sessions[sessionKey];
      removed++;
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

async function loadLeaderboard() {
  const startTime = Date.now();

  await Promise.all([
    loadRegion("EU"),
    loadRegion("US"),
    loadRegion("AP"),
    loadCNRegion()
  ]);

  console.log("EU Players:", Object.keys(players.EU).length);
  console.log("US Players:", Object.keys(players.US).length);
  console.log("AP Players:", Object.keys(players.AP).length);
  console.log("CN Players:", Object.keys(players.CN).length);

  cleanupSessions();

  lastUpdated = new Date();
  console.log("Updated:", lastUpdated);
  console.log(
    "Load time:",
    Math.round((Date.now() - startTime) / 1000),
    "seconds"
  );
}

async function loadRegion(region) {
  const maxPages = DEV_MODE ? 2 : 166;

  for (let page = 1; page <= maxPages; page++) {
    console.log(`Loading ${region} page:`, page);

    const response = await fetch(
  `https://hearthstone.blizzard.com/en-us/api/community/leaderboardsData?region=${region}&leaderboardId=battlegrounds&page=${page}`,
  {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  }
);

    const text = await response.text();

if (!response.ok) {
  console.log("CN", page, response.status);
  console.log(text.substring(0, 300));
  throw new Error("Request failed");
}

const data = JSON.parse(text);

    for (const row of data.leaderboard.rows) {
      players[region][row.accountid.toLowerCase()] = {
        rank: row.rank,
        rating: row.rating
      };
    }
  }
}

async function loadCNRegion() {
  const maxPages = DEV_MODE ? 2 : 166;

  for (let page = 1; page <= maxPages; page++) {
    console.log(`Loading CN page:`, page);

    const response = await fetch(
  `https://hearthstone.blizzard.com/en-us/api/community/leaderboardsData?region=${region}&leaderboardId=battlegrounds&page=${page}`,
  {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  }
);

    const text = await response.text();

if (!response.ok) {
  console.log("CN", page, response.status);
  console.log(text.substring(0, 300));
  throw new Error("Request failed");
}

const data = JSON.parse(text);

    if (!data.data?.list) {
      console.log("CN stopped at page:", page);
      break;
    }

    for (const row of data.data.list) {
      players.CN[row.battle_tag.toLowerCase()] = {
        rank: row.position,
        rating: row.score
      };
    }
  }
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

const server = http.createServer(async (request, response) => {
  const url = new URL(
    request.url,
    `http://${request.headers.host || "localhost"}`
  );

  if (url.pathname === "/player") {
    const accountName = (url.searchParams.get("account") || "lagshya").toLowerCase();
    const region = url.searchParams.get("region") || "EU";
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

      response.end(JSON.stringify({
        rank: player.rank,
        rating: player.rating,
        sessionRankChange: session.startRank - player.rank,
        sessionMMRChange: player.rating - session.startMMR
      }));
      return;
    }

    response.statusCode = 404;
    response.end("Player not found");
    return;
  }

  serveStaticFile(url.pathname, response);
});

async function startServer() {
  loadSessions();
  await loadLeaderboard();

  setInterval(() => {
    console.log("Refreshing cache...");
    loadLeaderboard();
  }, 15 * 60 * 1000);

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT}/setup.html`);
  });
}

startServer().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});