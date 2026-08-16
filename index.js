/**
 * StreamBridge – Emby → Stremio addon
 * Full Express server with parameterised manifest + stream routes.
 * User data is embedded in the URL path as a base64-url string.
 */

const express = require("express");
const path = require("path");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const embyClient = require("./lib/embyClient");
const { redactServerUrl } = require("./lib/redact");
const { version } = require("./package.json");
require("dotenv").config();

const PORT = process.env.PORT || 7000;
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "2kb" }));

const embyAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { err: "Too many attempts. Try again later." },
  standardHeaders: true,
  legacyHeaders: false
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "streambridge",
    version,
    backend: "emby"
  });
});

app.post("/api/get-emby-tokens", embyAuthLimiter, async (req, res) => {
  const serverUrl = typeof req.body?.serverUrl === "string" ? req.body.serverUrl.trim() : "";
  const username = typeof req.body?.username === "string" ? req.body.username : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!serverUrl || !username) {
    return res.status(400).json({ err: "serverUrl and username are required" });
  }

  const normalizedUrl = serverUrl.replace(/\/+$/, "");
  if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
    return res.status(400).json({ err: "URL must start with http:// or https://" });
  }

  try {
    const ax = await axios({
      method: "POST",
      url: `${normalizedUrl}/Users/AuthenticateByName`,
      headers: {
        "Content-Type": "application/json",
        "X-Emby-Authorization": `MediaBrowser Client="StreamBridge", Device="WebHelper", DeviceId="webhelper", Version="${version}"`
      },
      data: { Username: username, Pw: password || "" },
      timeout: 5000,
      validateStatus: () => true
    });

    if (ax.status !== 200) {
      const msg = ax.data?.Message || ax.data?.message || `HTTP ${ax.status}`;
      console.warn("Auth failed:", redactServerUrl(normalizedUrl), "→", ax.status, msg);
      return res.status(400).json({ err: msg });
    }

    const userId = ax.data?.User?.Id;
    const accessToken = ax.data?.AccessToken;
    const serverId = ax.data?.ServerId;

    if (!userId || !accessToken) {
      console.warn("Auth failed:", redactServerUrl(normalizedUrl), "→ invalid response");
      return res.status(502).json({ err: "Invalid response from server" });
    }

    return res.json({
      Id: userId,
      AccessToken: accessToken,
      ServerId: serverId != null ? serverId : undefined
    });
  } catch (e) {
    const msg = e?.response?.data?.Message || e?.response?.data?.message || e?.code || e?.message || "Request failed";
    console.warn("Auth failed:", redactServerUrl(normalizedUrl), msg);
    return res.status(502).json({ err: String(msg) });
  }
});

function baseManifest() {
  return {
    id: "org.streambridge.embyresolver",
    version,
    name: "StreamBridge: Emby to Stremio",
    description: "Stream media from your Emby server using IMDb/TMDB/Tvdb/Anidb IDs.",
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
      { key: "serverUrl", type: "text", title: "Server URL (Emby)", required: true },
      { key: "userId", type: "text", title: "User ID", required: true },
      { key: "accessToken", type: "text", title: "Access Token", required: true }
    ]
  };
}

function decodeCfg(str) {
  const cfg = JSON.parse(Buffer.from(str, "base64url").toString("utf8"));

  if (cfg.serverUrl) cfg.serverUrl = cfg.serverUrl.replace(/\/+$/, "");
  if (cfg.showServerName === undefined) cfg.showServerName = false;
  if (!cfg.streamName) cfg.streamName = "Emby";
  if (!cfg.hideStreamTypes) cfg.hideStreamTypes = [];

  return cfg;
}

function shouldFilterStream(stream, hideStreamTypes) {
  if (!hideStreamTypes || hideStreamTypes.length === 0) return false;

  const mediaInfo = stream.mediaInfo || {};
  const qualityTag = mediaInfo.qualityTag || "";
  const hdrTag = mediaInfo.hdrTag || "";

  if (hideStreamTypes.includes("4K") && (qualityTag.includes("4K") || qualityTag === "2160p")) return true;
  if (hideStreamTypes.includes("1080p") && qualityTag === "1080p") return true;
  if (hideStreamTypes.includes("DV") && (hdrTag === "DV" || hdrTag === "DolbyVision")) return true;
  if (hideStreamTypes.includes("HDR") && hdrTag && (hdrTag.includes("HDR") || hdrTag === "HLG" || hdrTag === "DV" || hdrTag === "DolbyVision")) return true;

  return false;
}

app.get("/:cfg/manifest.json", (req, res) => {
  let cfg;
  try {
    cfg = decodeCfg(req.params.cfg);
  } catch (err) {
    console.error("[ERROR] Failed to decode config:", err.message);
    return res.status(400).json({ err: "Bad config in URL" });
  }

  const mf = baseManifest();
  mf.id += "." + req.params.cfg.slice(0, 8);

  if (cfg.showServerName === true) {
    const serverHostname = cfg.serverUrl ? cfg.serverUrl.replace(/^https?:\/\//, "") : "Unknown Server";
    mf.name += ` (${serverHostname})`;
  }

  mf.behaviorHints.configurationRequired = false;
  res.json(mf);
});

app.get("/:cfg/stream/:type/:id.json", async (req, res) => {
  let cfg;
  try {
    cfg = decodeCfg(req.params.cfg);
  } catch {
    return res.json({ streams: [] });
  }

  if (!cfg.serverUrl || !cfg.userId || !cfg.accessToken) {
    return res.json({ streams: [] });
  }

  try {
    const raw = await embyClient.getStream(req.params.id, cfg);
    const streamName = cfg.streamName || "Emby";
    const hideStreamTypes = cfg.hideStreamTypes || [];

    const streams = (raw || [])
      .filter(s => s.directPlayUrl)
      .filter(s => !shouldFilterStream(s, hideStreamTypes))
      .map(s => ({
        name: streamName,
        description: s.streamDescription || s.qualityTitle || "Direct Play",
        url: s.directPlayUrl,
        behaviorHints: {
          filename: s.mediaInfo?.filename ?? undefined,
          videoSize: s.mediaInfo?.size ?? undefined,
          notWebReady: true,
          bingeGroup: `${streamName}-${(s.qualityTitle || "Direct Play").trim()}`
        },
        subtitles: cfg.includeSubtitles === false ? [] : (s.subtitles || [])
      }));

    res.set("Cache-Control", streams.length > 0 ? "public, max-age=120" : "no-cache");
    res.json({ streams });
  } catch (e) {
    console.error("Stream handler error:", e?.message || String(e));
    res.json({ streams: [] });
  }
});

app.get("/manifest.json", (_req, res) => res.json(baseManifest()));

app.get("/configure", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "configure.html")));

app.get("/:cfg/configure", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "configure.html")));

app.listen(PORT, () =>
  console.log(`🚀 StreamBridge v${version} (Emby) up at http://localhost:${PORT}/<cfg>/manifest.json`)
);
