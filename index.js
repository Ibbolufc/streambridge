/**
 * StreamBridge – Emby/Jellyfin → Stremio addon
 * Full Express server with parameterised manifest + stream routes.
 * User data is embedded in the URL path as a base64-url string.
 */

const express      = require("express");
const path         = require("path");
const cors         = require("cors");
const rateLimit    = require("express-rate-limit");
const axios        = require("axios");
const embyClient   = require("./lib/embyClient");
const jellyfinClient = require("./lib/jellyfinClient");
const { redactServerUrl } = require("./lib/redact");
const { version } = require("./package.json");
require("dotenv").config();

const PORT = process.env.PORT || 7000;
const app  = express();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { err: "Too many attempts. Try again later." },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(express.json({ limit: "2kb" }));

// Lightweight health endpoint for Docker/Portainer monitoring.
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "streambridge",
    version,
    backends: ["emby", "jellyfin"]
  });
});

function normalizeServerType(value) {
  return String(value || "emby").toLowerCase() === "jellyfin" ? "jellyfin" : "emby";
}

async function authenticateServer(req, res, forcedServerType = null) {
  const serverType = normalizeServerType(forcedServerType || req.body?.serverType);
  const serverUrl = typeof req.body?.serverUrl === "string" ? req.body.serverUrl.trim() : "";
  const username  = typeof req.body?.username === "string" ? req.body.username : "";
  const password  = typeof req.body?.password === "string" ? req.body.password : "";

  if (!serverUrl || !username) {
    console.warn("Auth: missing serverUrl or username");
    return res.status(400).json({ err: "serverUrl and username are required" });
  }

  const normalizedUrl = serverUrl.replace(/\/+$/, "");
  if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
    console.warn("Auth: invalid URL scheme (must be http:// or https://)");
    return res.status(400).json({ err: "URL must start with http:// or https://" });
  }

  const authUrl = `${normalizedUrl}/Users/AuthenticateByName`;
  const mediaBrowserAuth = `MediaBrowser Client="StreamBridge", Device="WebHelper", DeviceId="streambridge-webhelper", Version="${version}"`;

  const headers = {
    "Content-Type": "application/json"
  };

  if (serverType === "jellyfin") {
    headers.Authorization = mediaBrowserAuth;
  } else {
    headers["X-Emby-Authorization"] = mediaBrowserAuth;
  }

  try {
    const ax = await axios({
      method: "POST",
      url: authUrl,
      headers,
      data: { Username: username, Pw: password || "" },
      timeout: 5000,
      validateStatus: () => true
    });

    if (ax.status !== 200) {
      const msg = ax.data?.Message || ax.data?.message || `HTTP ${ax.status}`;
      console.warn(`${serverType} auth failed:`, redactServerUrl(normalizedUrl), "→", ax.status, msg);
      return res.status(400).json({ err: msg });
    }

    const data = ax.data;
    const userId = data?.User?.Id;
    const accessToken = data?.AccessToken;
    const serverId = data?.ServerId;

    if (!userId || !accessToken) {
      console.warn(`${serverType} auth failed:`, redactServerUrl(normalizedUrl), "→ invalid response (missing User.Id or AccessToken)");
      return res.status(502).json({ err: "Invalid response from server" });
    }

    return res.json({
      Id: userId,
      AccessToken: accessToken,
      ServerId: serverId != null ? serverId : undefined,
      ServerType: serverType
    });
  } catch (e) {
    const msg = e?.response?.data?.Message || e?.response?.data?.message || e?.code || e?.message || "Request failed";
    const code = e?.code || (e?.response?.status ? `HTTP ${e.response.status}` : "");
    console.warn(`${serverType} auth failed:`, redactServerUrl(normalizedUrl), code ? "→" : "", code || "", msg);
    return res.status(502).json({ err: String(msg) });
  }
}

// Backward-compatible Emby helper used by older configure pages/bookmarks.
app.post("/api/get-emby-tokens", authLimiter, (req, res) => authenticateServer(req, res, "emby"));

// New dual-backend helper used by the v1.4 configure page.
app.post("/api/get-server-tokens", authLimiter, (req, res) => authenticateServer(req, res));

// ──────────────────────────────────────────────────────────────────────────
// Helper: build a naked manifest (no user-specific data yet)
// ──────────────────────────────────────────────────────────────────────────
function baseManifest(serverType = null) {
  const configuredType = serverType ? normalizeServerType(serverType) : null;
  const label = configuredType === "jellyfin" ? "Jellyfin" : configuredType === "emby" ? "Emby" : "Emby/Jellyfin";

  return {
    // Preserve the historical fallback/Emby ID for backward compatibility.
    id: configuredType === "jellyfin" ? "org.streambridge.jellyfinresolver" : "org.streambridge.embyresolver",
    version,
    name: `StreamBridge: ${label} to Stremio`,
    description: `Stream media from your ${label} server using IMDb/TMDB/Tvdb/Anidb IDs.`,
    catalogs: [],
    resources: [
      {
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["tt", "imdb:", "tmdb:"]
      }
    ],
    types: ["movie", "series"],
    behaviorHints: { configurable: true, configurationRequired: true },
    config: [
      { key: "serverUrl", type: "text", title: `Server URL (${label})`, required: true },
      { key: "userId", type: "text", title: "User ID", required: true },
      { key: "accessToken", type: "text", title: "Access Token", required: true }
    ]
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: decode the cfg string into an object with backward-compatible defaults
// ──────────────────────────────────────────────────────────────────────────
function decodeCfg(str) {
  const cfg = JSON.parse(Buffer.from(str, "base64url").toString("utf8"));

  if (cfg.serverUrl) {
    cfg.serverUrl = cfg.serverUrl.replace(/\/+$/, "");
  }

  cfg.serverType = normalizeServerType(cfg.serverType);
  if (cfg.showServerName === undefined) cfg.showServerName = false;
  if (!cfg.streamName) cfg.streamName = cfg.serverType === "jellyfin" ? "Jellyfin" : "Emby";
  if (!cfg.hideStreamTypes) cfg.hideStreamTypes = [];

  return cfg;
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: check if a stream should be filtered based on hideStreamTypes config
// ──────────────────────────────────────────────────────────────────────────
function shouldFilterStream(stream, hideStreamTypes) {
  if (!hideStreamTypes || hideStreamTypes.length === 0) return false;

  const mediaInfo = stream.mediaInfo || {};
  const qualityTag = mediaInfo.qualityTag || "";
  const hdrTag = mediaInfo.hdrTag || "";

  if (hideStreamTypes.includes("4K")) {
    if (qualityTag.includes("4K") || qualityTag === "2160p") return true;
  }

  if (hideStreamTypes.includes("1080p")) {
    if (qualityTag === "1080p") return true;
  }

  if (hideStreamTypes.includes("DV")) {
    if (hdrTag === "DV" || hdrTag === "DolbyVision") return true;
  }

  if (hideStreamTypes.includes("HDR")) {
    if (hdrTag && (hdrTag.includes("HDR") || hdrTag === "HLG" || hdrTag === "DV" || hdrTag === "DolbyVision")) return true;
  }

  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Parameterised MANIFEST route  →  /<cfg>/manifest.json
// ──────────────────────────────────────────────────────────────────────────
app.get("/:cfg/manifest.json", (req, res) => {
  const cfgString = req.params.cfg;
  let cfg;

  try {
    cfg = decodeCfg(cfgString);
  } catch (err) {
    console.error("[ERROR] Error decoding cfg in manifest route:", err.message);
    console.error("[ERROR] Failed to decode config (cfgString length:", cfgString?.length || 0, ")");
    return res.status(400).json({ err: "Bad config in URL", details: err.message });
  }

  const mf = baseManifest(cfg.serverType);
  mf.id += "." + cfgString.slice(0, 8);

  if (cfg.showServerName === true) {
    const serverHostname = cfg.serverUrl ? cfg.serverUrl.replace(/^https?:\/\//, "") : "Unknown Server";
    mf.name += ` (${serverHostname})`;
  }

  mf.behaviorHints.configurationRequired = false;
  res.json(mf);
});

// ──────────────────────────────────────────────────────────────────────────
// STREAM route  →  /<cfg>/stream/<type>/<id>.json
// ──────────────────────────────────────────────────────────────────────────
app.get("/:cfg/stream/:type/:id.json", async (req, res) => {
  let cfg;

  try {
    cfg = decodeCfg(req.params.cfg);
  } catch {
    return res.json({ streams: [] });
  }

  const { id } = req.params;
  if (!cfg.serverUrl || !cfg.userId || !cfg.accessToken) {
    return res.json({ streams: [] });
  }

  try {
    const client = cfg.serverType === "jellyfin" ? jellyfinClient : embyClient;
    const raw = await client.getStream(id, cfg);
    const streamName = cfg.streamName || (cfg.serverType === "jellyfin" ? "Jellyfin" : "Emby");
    const hideStreamTypes = cfg.hideStreamTypes || [];

    const streams = (raw || [])
      .filter(s => s.directPlayUrl)
      .filter(s => !shouldFilterStream(s, hideStreamTypes))
      .map(s => {
        const behaviorHints = {
          filename: s.mediaInfo?.filename ?? undefined,
          videoSize: s.mediaInfo?.size ?? undefined,
          notWebReady: true,
          bingeGroup: `${streamName}-${(s.qualityTitle || "Direct Play").trim()}`
        };

        return {
          name: streamName,
          description: s.streamDescription || s.qualityTitle || "Direct Play",
          url: s.directPlayUrl,
          behaviorHints,
          subtitles: cfg.includeSubtitles === false ? [] : (s.subtitles || [])
        };
      });

    if (streams.length > 0) {
      res.set("Cache-Control", "public, max-age=120");
    } else {
      res.set("Cache-Control", "no-cache");
    }

    res.json({ streams });
  } catch (e) {
    console.error("Stream handler error:", e?.message || String(e));
    if (e?.stack && process.env.NODE_ENV === "development") {
      console.error("Stack trace:", e.stack);
    }
    res.json({ streams: [] });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// FALLBACK manifest for users who hit /manifest.json with no cfg
// ──────────────────────────────────────────────────────────────────────────
app.get("/manifest.json", (_req, res) => {
  res.json(baseManifest());
});

// ──────────────────────────────────────────────────────────────────────────
// CONFIGURE routes
// ──────────────────────────────────────────────────────────────────────────
app.get("/configure", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "configure.html")));

app.get("/:cfg/configure", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "configure.html"));
});

// ──────────────────────────────────────────────────────────────────────────
// Start the server
// ──────────────────────────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`🚀  StreamBridge v${version} up at http://localhost:${PORT}/<cfg>/manifest.json`)
);
