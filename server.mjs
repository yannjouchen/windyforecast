import "dotenv/config";
import express from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWrfUpdater } from "./lib/wrf-updater.mjs";
import { createQpeUpdater } from "./lib/qpe-updater.mjs";
import { createCwaGfsUpdater } from "./lib/cwa-gfs-updater.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const PORT = Number(process.env.PORT || 8080);
const CWA_API_KEY = String(process.env.CWA_API_KEY || "").trim();
const TARGET_LAT = Number(process.env.TARGET_LAT || 22.705864872692686);
const TARGET_LON = Number(process.env.TARGET_LON || 120.33468473266137);
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, "data")
);
const WRF_REFRESH_MINUTES = Math.max(
  15,
  Number(process.env.WRF_REFRESH_MINUTES || 60)
);
const QPE_REFRESH_MINUTES = Math.max(
  5,
  Number(process.env.QPE_REFRESH_MINUTES || 10)
);
const QPE_WARN_MINUTES = Math.max(
  10,
  Number(process.env.QPE_WARN_MINUTES || 30)
);
const QPE_EXPIRE_MINUTES = Math.max(
  QPE_WARN_MINUTES + 1,
  Number(process.env.QPE_EXPIRE_MINUTES || 60)
);
const CWA_PROXY_CACHE_MS = Math.max(
  0,
  Number(process.env.CWA_PROXY_CACHE_MS || 120000)
);

const CWA_GFS_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.CWA_GFS_ENABLED || "false").trim()
);
const CWA_GFS_REFRESH_MINUTES = Math.max(
  60,
  Number(process.env.CWA_GFS_REFRESH_MINUTES || 360)
);

await fs.mkdir(DATA_DIR, { recursive: true });

const wrfUpdater = createWrfUpdater({
  cwaApiKey: CWA_API_KEY,
  targetLat: TARGET_LAT,
  targetLon: TARGET_LON,
  dataDir: DATA_DIR,
  refreshMinutes: WRF_REFRESH_MINUTES,
  pythonBin: process.env.PYTHON_BIN || "python3"
});

const qpeUpdater = createQpeUpdater({
  cwaApiKey: CWA_API_KEY,
  targetLat: TARGET_LAT,
  targetLon: TARGET_LON,
  dataDir: DATA_DIR,
  refreshMinutes: QPE_REFRESH_MINUTES,
  warnMinutes: QPE_WARN_MINUTES,
  expireMinutes: QPE_EXPIRE_MINUTES
});

const cwaGfsUpdater = createCwaGfsUpdater({
  enabled: CWA_GFS_ENABLED,
  cwaApiKey: CWA_API_KEY,
  targetLat: TARGET_LAT,
  targetLon: TARGET_LON,
  dataDir: DATA_DIR,
  refreshMinutes: CWA_GFS_REFRESH_MINUTES,
  pythonBin: process.env.PYTHON_BIN || "python3"
});

// Small in-memory CWA proxy cache so multiple cards/users do not spend
// a fresh upstream request for identical query parameters every time.
const cwaCache = new Map();

function jsonError(res, status, error, detail = undefined) {
  res.status(status).json({
    ok: false,
    error,
    ...(detail ? { detail } : {})
  });
}

function buildCwaCacheKey(searchParams) {
  return [...searchParams.entries()]
    .sort(([aK, aV], [bK, bV]) =>
      aK === bK ? String(aV).localeCompare(String(bV)) : aK.localeCompare(bK)
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/health", async (_req, res) => {
  const wrf = wrfUpdater.getStatus();
  const qpe = qpeUpdater.getStatus();
  const cwaGfs = cwaGfsUpdater.getStatus();
  let wrfFile = null;
  let qpeFile = null;
  let cwaGfsFile = null;

  try {
    const raw = await fs.readFile(path.join(DATA_DIR, "wrf-renwu.json"), "utf8");
    const data = JSON.parse(raw);
    wrfFile = {
      status: data?.status || null,
      cwa_initial_time: data?.cwa_initial_time || null,
      generated_at: data?.generated_at || null
    };
  } catch {
    // File may not exist before the first successful WRF update.
  }

  try {
    const raw = await fs.readFile(path.join(DATA_DIR, "qpe-renwu.json"), "utf8");
    const data = JSON.parse(raw);
    qpeFile = {
      status: data?.status || null,
      observation_time: data?.observation_time || null,
      past_1h_qpe_mm: data?.past_1h_qpe_mm ?? null,
      freshness: data?.freshness || null,
      usable_for_judgement: data?.usable_for_judgement ?? null,
      age_minutes: data?.age_minutes ?? null
    };
  } catch {
    // File may not exist before the first successful QPE update.
  }

  try {
    const raw = await fs.readFile(
      path.join(DATA_DIR, "cwa-gfs-renwu.json"),
      "utf8"
    );
    const data = JSON.parse(raw);
    cwaGfsFile = {
      status: data?.status || null,
      cwa_initial_time: data?.cwa_initial_time || null,
      generated_at: data?.generated_at || null,
      forecast_blocks: Array.isArray(data?.forecast)
        ? data.forecast.length
        : 0
    };
  } catch {
    // Experimental CWA GFS file may not exist while disabled.
  }

  res.json({
    ok: true,
    service: "windyforecast-renwu",
    time: new Date().toISOString(),
    target: { lat: TARGET_LAT, lon: TARGET_LON },
    cwa_key_configured: Boolean(CWA_API_KEY),
    data_dir: DATA_DIR,
    wrf_file: wrfFile,
    wrf_updater: wrf,
    qpe_file: qpeFile,
    qpe_updater: qpe,
    cwa_gfs_file: cwaGfsFile,
    cwa_gfs_updater: cwaGfs
  });
});

app.get("/api/cwa", async (req, res) => {
  if (!CWA_API_KEY) {
    return jsonError(
      res,
      503,
      "CWA_API_KEY 尚未設定",
      "本機請放在 .env；Railway 請放在 Variables。"
    );
  }

  try {
    const upstream = new URL(
      "https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001"
    );
    upstream.searchParams.set("Authorization", CWA_API_KEY);
    upstream.searchParams.set("format", "JSON");

    // Only forward harmless dataset filters. Never accept Authorization
    // from the browser.
    const allowed = new Set([
      "StationId",
      "stationId",
      "StationName",
      "stationName",
      "CountyName",
      "TownName",
      "limit",
      "offset"
    ]);

    for (const [key, value] of Object.entries(req.query)) {
      if (!allowed.has(key)) continue;
      if (Array.isArray(value)) {
        value.forEach(v => upstream.searchParams.append(key, String(v)));
      } else if (value !== undefined && value !== null) {
        upstream.searchParams.set(key, String(value));
      }
    }

    const publicParams = new URLSearchParams(upstream.searchParams);
    publicParams.delete("Authorization");
    const cacheKey = buildCwaCacheKey(publicParams);

    const cached = cwaCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CWA_PROXY_CACHE_MS) {
      res.set("X-CWA-Cache", "HIT");
      return res.json(cached.data);
    }

    const response = await fetchWithTimeout(
      upstream,
      {
        headers: {
          "User-Agent": "windyforecast-renwu/1.0"
        },
        cache: "no-store"
      },
      20000
    );

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return jsonError(
        res,
        502,
        `CWA upstream 回傳非 JSON（HTTP ${response.status}）`
      );
    }

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    cwaCache.set(cacheKey, { at: Date.now(), data });

    // Prevent unbounded cache growth if different filter combinations are used.
    if (cwaCache.size > 50) {
      const oldest = [...cwaCache.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, cwaCache.size - 40);
      oldest.forEach(([key]) => cwaCache.delete(key));
    }

    res.set("X-CWA-Cache", "MISS");
    res.json(data);
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "CWA upstream timeout"
        : error instanceof Error
          ? error.message
          : String(error);
    jsonError(res, 502, message);
  }
});

app.get("/api/qpe", async (_req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const raw = await fs.readFile(
      path.join(DATA_DIR, "qpe-renwu.json"),
      "utf8"
    );
    const data = JSON.parse(raw);
    return res.json(data);
  } catch {
    return res.json({
      status: "pending",
      message:
        "尚未產生仁武 QPE。Node 背景更新器會自動抓 O-B0045-001。",
      updater: qpeUpdater.getStatus()
    });
  }
});

app.get("/api/qpe/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(qpeUpdater.getStatus());
});

app.post("/api/qpe/refresh", async (req, res) => {
  const configured = String(process.env.ADMIN_TOKEN || "").trim();
  const supplied = String(req.get("x-admin-token") || "").trim();

  if (!configured || supplied !== configured) {
    return jsonError(res, 403, "手動 QPE 更新端點未授權");
  }

  const result = await qpeUpdater.checkAndUpdate({
    reason: "manual-api"
  });
  res.json(result);
});

app.get("/api/cwa-gfs", async (_req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const raw = await fs.readFile(
      path.join(DATA_DIR, "cwa-gfs-renwu.json"),
      "utf8"
    );
    return res.json(JSON.parse(raw));
  } catch {
    return res.json({
      status: "pending",
      enabled: CWA_GFS_ENABLED,
      message: CWA_GFS_ENABLED
        ? "尚未產生 CWA 官方 GFS 直讀資料；背景更新器會自動嘗試。"
        : "CWA 官方 GFS 直讀實驗目前未啟用。先執行 npm run gfs:cwa:probe 驗證，再設定 CWA_GFS_ENABLED=true。",
      updater: cwaGfsUpdater.getStatus()
    });
  }
});

app.get("/api/cwa-gfs/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(cwaGfsUpdater.getStatus());
});

app.post("/api/cwa-gfs/refresh", async (req, res) => {
  const configured = String(process.env.ADMIN_TOKEN || "").trim();
  const supplied = String(req.get("x-admin-token") || "").trim();

  if (!configured || supplied !== configured) {
    return jsonError(res, 403, "手動 CWA GFS 更新端點未授權");
  }

  const result = await cwaGfsUpdater.checkAndUpdate({
    reason: "manual-api",
    force: true
  });
  res.json(result);
});

app.get("/api/wrf", async (_req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const raw = await fs.readFile(
      path.join(DATA_DIR, "wrf-renwu.json"),
      "utf8"
    );
    const data = JSON.parse(raw);
    return res.json(data);
  } catch (error) {
    return res.json({
      status: "pending",
      message:
        "尚未產生 WRF 仁武資料。Node 背景更新器會自動檢查並嘗試產生。",
      updater: wrfUpdater.getStatus()
    });
  }
});

app.get("/api/wrf/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(wrfUpdater.getStatus());
});

// Optional manual endpoint. Disabled unless ADMIN_TOKEN is configured.
// This avoids a public visitor forcing repeated large GRIB2 downloads.
app.post("/api/wrf/refresh", async (req, res) => {
  const configured = String(process.env.ADMIN_TOKEN || "").trim();
  const supplied = String(req.get("x-admin-token") || "").trim();

  if (!configured || supplied !== configured) {
    return jsonError(res, 403, "手動 WRF 更新端點未授權");
  }

  const result = await wrfUpdater.checkAndUpdate({
    reason: "manual-api",
    force: true
  });
  res.json(result);
});

// Only public/ is exposed. .env, source code and runtime data cannot be
// downloaded through Express static hosting.
app.use(
  express.static(path.join(__dirname, "public"), {
    index: "index.html",
    etag: true,
    maxAge: 0
  })
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] http://0.0.0.0:${PORT}`);
  console.log(`[server] target=${TARGET_LAT},${TARGET_LON}`);
  console.log(`[server] dataDir=${DATA_DIR}`);
  console.log(
    `[server] WRF background check every ${WRF_REFRESH_MINUTES} minutes`
  );
  console.log(
    `[server] QPE background check every ${QPE_REFRESH_MINUTES} minutes`
  );
  console.log(
    `[server] QPE freshness: warning>${QPE_WARN_MINUTES}m, expire>${QPE_EXPIRE_MINUTES}m`
  );
  console.log(
    CWA_GFS_ENABLED
      ? `[server] CWA GFS direct background check every ${CWA_GFS_REFRESH_MINUTES} minutes`
      : "[server] CWA GFS direct experiment disabled (CWA_GFS_ENABLED=false)"
  );

  // Do not block server startup on background data collection.
  wrfUpdater.start();
  qpeUpdater.start();
  cwaGfsUpdater.start();
});
