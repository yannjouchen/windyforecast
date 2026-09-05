import "dotenv/config";
import express from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWrfUpdater } from "./lib/wrf-updater.mjs";
import { createQpeUpdater } from "./lib/qpe-updater.mjs";
import { createCwaGfsUpdater } from "./lib/cwa-gfs-updater.mjs";
import { createWaterLevelUpdater } from "./lib/waterlevel-updater.mjs";

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

const WATERLEVEL_ENABLED = !/^(0|false|no|off)$/i.test(
  String(process.env.WATERLEVEL_ENABLED || "true").trim()
);
const WATERLEVEL_REFRESH_MINUTES = Math.max(
  1,
  Number(process.env.WATERLEVEL_REFRESH_MINUTES || 1)
);
const WATERLEVEL_ENDPOINT = String(
  process.env.WATERLEVEL_ENDPOINT ||
  "https://web.fpcitc.com.tw/PIWebAPI/streams/Recorded"
).trim();
const WATERLEVEL_SERVER = String(
  process.env.WATERLEVEL_SERVER || "JWRTPMS"
).trim();
const WATERLEVEL_TAG = String(
  process.env.WATERLEVEL_TAG || "JW_waterlevelmeter"
).trim();
const WATERLEVEL_NAME = String(
  process.env.WATERLEVEL_NAME || "台塑仁四橋"
).trim();
const WATERLEVEL_DISTRICT = String(
  process.env.WATERLEVEL_DISTRICT || "仁武"
).trim();
const WATERLEVEL_BASIN = String(
  process.env.WATERLEVEL_BASIN || "後勁溪"
).trim();
const WATERLEVEL_UNIT = String(
  process.env.WATERLEVEL_UNIT || "m"
).trim();
const WATERLEVEL_LEVEL3 = Number(process.env.WATERLEVEL_LEVEL3 || 11);
const WATERLEVEL_LEVEL2 = Number(process.env.WATERLEVEL_LEVEL2 || 12);
const WATERLEVEL_LEVEL1 = Number(process.env.WATERLEVEL_LEVEL1 || 13);

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

const waterLevelUpdater = createWaterLevelUpdater({
  enabled: WATERLEVEL_ENABLED,
  endpoint: WATERLEVEL_ENDPOINT,
  server: WATERLEVEL_SERVER,
  tag: WATERLEVEL_TAG,
  stationName: WATERLEVEL_NAME,
  district: WATERLEVEL_DISTRICT,
  basin: WATERLEVEL_BASIN,
  unit: WATERLEVEL_UNIT,
  warningLevel3: WATERLEVEL_LEVEL3,
  warningLevel2: WATERLEVEL_LEVEL2,
  warningLevel1: WATERLEVEL_LEVEL1,
  dataDir: DATA_DIR,
  refreshMinutes: WATERLEVEL_REFRESH_MINUTES
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
  const waterLevel = waterLevelUpdater.getStatus();
  let wrfFile = null;
  let qpeFile = null;
  let cwaGfsFile = null;
  let waterLevelFile = null;

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

  try {
    const raw = await fs.readFile(
      path.join(DATA_DIR, "waterlevel-renwu.json"),
      "utf8"
    );
    const data = JSON.parse(raw);
    waterLevelFile = {
      status: data?.status || null,
      latest_timestamp: data?.latest_timestamp || null,
      current_value: data?.current?.value ?? null,
      unit: data?.current?.unit ?? null,
      series_points: Array.isArray(data?.series_5min)
        ? data.series_5min.length
        : 0
    };
  } catch {
    // Water-level file may not exist before the first successful update.
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
    cwa_gfs_updater: cwaGfs,
    waterlevel_file: waterLevelFile,
    waterlevel_updater: waterLevel
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


function parseWaterHistoryLocalTime(value) {
  const text = String(value || "").trim();
  const m = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/
  );
  if (!m) return null;

  const [, y, mo, d, h, mi] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:00+08:00`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;

  // Reject rollover dates such as 2026-02-31.
  const verify = new Date(ms + 8 * 60 * 60 * 1000);
  if (
    verify.getUTCFullYear() !== Number(y) ||
    verify.getUTCMonth() + 1 !== Number(mo) ||
    verify.getUTCDate() !== Number(d) ||
    verify.getUTCHours() !== Number(h) ||
    verify.getUTCMinutes() !== Number(mi)
  ) {
    return null;
  }

  return {
    text: `${y}-${mo}-${d} ${h}:${mi}`,
    ms
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bucketWaterHistory(points, bucketMinutes) {
  const bucketMs = bucketMinutes * 60 * 1000;
  const buckets = new Map();

  for (const point of points) {
    const t = Date.parse(point.time);
    const key = Math.floor(t / bucketMs) * bucketMs;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(point.value);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, values]) => ({
      time: new Date(time).toISOString(),
      value: Number(median(values).toFixed(4))
    }));
}

async function fetchWaterLevelHistoryRange(startInput, endInput) {
  const start = parseWaterHistoryLocalTime(startInput);
  const end = parseWaterHistoryLocalTime(endInput);

  if (!start || !end) {
    const error = new Error("日期格式需為 YYYY-MM-DD HH:mm（台灣時間）");
    error.statusCode = 400;
    throw error;
  }
  if (end.ms <= start.ms) {
    const error = new Error("結束時間必須晚於開始時間");
    error.statusCode = 400;
    throw error;
  }

  const maxRangeMs = 7 * 24 * 60 * 60 * 1000;
  if (end.ms - start.ms > maxRangeMs) {
    const error = new Error("單次歷史水位查詢最多 7 天");
    error.statusCode = 400;
    throw error;
  }

  const response = await fetchWithTimeout(
    WATERLEVEL_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "windyforecast-renwu/10.2"
      },
      body: JSON.stringify({
        server: WATERLEVEL_SERVER,
        tag: WATERLEVEL_TAG,
        starttime: start.text,
        endtime: end.text
      }),
      cache: "no-store"
    },
    30000
  );

  if (!response.ok) {
    throw new Error(`水位歷史 API HTTP ${response.status}`);
  }

  const raw = await response.json();
  if (!Array.isArray(raw)) {
    throw new Error("水位歷史 API 回傳格式不是陣列");
  }

  const parsed = raw
    .map(item => {
      const localTime = String(item?.Timestamp || "").trim();
      const value = Number(item?.Value);
      const match = localTime.match(
        /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
      );
      if (!match || !Number.isFinite(value)) return null;

      const [, y, mo, d, h, mi, sec = "00"] = match;
      const ms = Date.parse(
        `${y}-${mo}-${d}T${h}:${mi}:${sec}+08:00`
      );
      if (!Number.isFinite(ms)) return null;

      return {
        time: new Date(ms).toISOString(),
        value
      };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  const oneMinute = bucketWaterHistory(parsed, 1);

  // Keep the browser responsive on multi-day queries.
  const maxChartPoints = 1500;
  const bucketMinutes = Math.max(
    1,
    Math.ceil(oneMinute.length / maxChartPoints)
  );
  const chartSeries =
    bucketMinutes === 1
      ? oneMinute
      : bucketWaterHistory(oneMinute, bucketMinutes);

  return {
    status: "ok",
    station: {
      district: WATERLEVEL_DISTRICT,
      basin: WATERLEVEL_BASIN,
      name: WATERLEVEL_NAME,
      unit: WATERLEVEL_UNIT,
      warning_levels: {
        level3: WATERLEVEL_LEVEL3,
        level2: WATERLEVEL_LEVEL2,
        level1: WATERLEVEL_LEVEL1
      }
    },
    query: {
      start: start.text,
      end: end.text,
      timezone: "Asia/Taipei",
      max_range_days: 7
    },
    raw_count: parsed.length,
    minute_count: oneMinute.length,
    chart_bucket_minutes: bucketMinutes,
    series: chartSeries
  };
}


app.get("/api/waterlevel/history", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!WATERLEVEL_ENABLED) {
    return jsonError(res, 503, "水位整合目前未啟用");
  }

  try {
    const result = await fetchWaterLevelHistoryRange(
      req.query.start,
      req.query.end
    );
    return res.json(result);
  } catch (error) {
    const status = Number(error?.statusCode) || 502;
    return jsonError(
      res,
      status,
      error instanceof Error ? error.message : String(error)
    );
  }
});

app.get("/api/waterlevel", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const raw = await fs.readFile(
      path.join(DATA_DIR, "waterlevel-renwu.json"),
      "utf8"
    );
    return res.json(JSON.parse(raw));
  } catch {
    return res.json({
      status: "pending",
      enabled: WATERLEVEL_ENABLED,
      message: WATERLEVEL_ENABLED
        ? "尚未取得水位資料；背景更新器會自動向 PI Recorded API 取得過去 1 天資料。"
        : "水位整合目前未啟用。",
      updater: waterLevelUpdater.getStatus()
    });
  }
});

app.get("/api/waterlevel/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(waterLevelUpdater.getStatus());
});

app.post("/api/waterlevel/refresh", async (req, res) => {
  const configured = String(process.env.ADMIN_TOKEN || "").trim();
  const supplied = String(req.get("x-admin-token") || "").trim();
  if (!configured || supplied !== configured) {
    return jsonError(res, 403, "手動水位更新端點未授權");
  }
  const result = await waterLevelUpdater.checkAndUpdate({
    reason: "manual-api"
  });
  res.json(result);
});

app.get("/api/hydro", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  let waterlevel = null;
  let rainfall = null;
  let qpeCurrent = null;

  try {
    waterlevel = JSON.parse(
      await fs.readFile(path.join(DATA_DIR, "waterlevel-renwu.json"), "utf8")
    );
  } catch {}

  try {
    rainfall = JSON.parse(
      await fs.readFile(path.join(DATA_DIR, "qpe-history-renwu.json"), "utf8")
    );
  } catch {}

  try {
    qpeCurrent = JSON.parse(
      await fs.readFile(path.join(DATA_DIR, "qpe-renwu.json"), "utf8")
    );
  } catch {}

  if (!rainfall && qpeCurrent?.observation_time) {
    rainfall = {
      status: "ok",
      schema_version: 1,
      updated_at: new Date().toISOString(),
      retention_hours: 168,
      meaning:
        "Temporary one-point fallback until qpe-history-renwu.json is populated.",
      series: [
        {
          time: qpeCurrent.observation_time,
          point_1h_mm: qpeCurrent.past_1h_qpe_mm ?? null,
          radius_5km_mean_1h_mm:
            qpeCurrent?.area?.radius_5km?.mean_mm ?? null,
          radius_10km_mean_1h_mm:
            qpeCurrent?.area?.radius_10km?.mean_mm ?? null,
          radius_10km_max_1h_mm:
            qpeCurrent?.area?.radius_10km?.max_mm ?? null,
          radius_10km_ge20_pct:
            qpeCurrent?.area?.radius_10km?.coverage_pct?.ge_20 ?? null
        }
      ]
    };
  }

  res.json({
    status: waterlevel || rainfall ? "ok" : "pending",
    generated_at: new Date().toISOString(),
    waterlevel,
    rainfall,
    qpe_current: qpeCurrent
      ? {
          observation_time: qpeCurrent.observation_time || null,
          point_1h_mm: qpeCurrent.past_1h_qpe_mm ?? null,
          radius_10km_mean_1h_mm:
            qpeCurrent?.area?.radius_10km?.mean_mm ?? null
        }
      : null,
    note:
      "Rainfall series contains rolling past-1h QPE snapshots. Adjacent values overlap and must not be summed."
  });
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
  console.log(
    WATERLEVEL_ENABLED
      ? `[server] water level ${WATERLEVEL_SERVER}/${WATERLEVEL_TAG} every ${WATERLEVEL_REFRESH_MINUTES} minutes`
      : "[server] water level integration disabled"
  );

  // Do not block server startup on background data collection.
  wrfUpdater.start();
  qpeUpdater.start();
  cwaGfsUpdater.start();
  waterLevelUpdater.start();
});
