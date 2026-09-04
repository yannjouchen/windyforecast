import path from "node:path";
import { promises as fs } from "node:fs";
import { XMLParser } from "fast-xml-parser";

const DATASET_ID = "O-B0045-001";

const VERIFIED_KNOWN_GRID = Object.freeze({
  origin_lon: 118.0,
  origin_lat: 20.0,
  resolution_lon: 0.0125,
  resolution_lat: 0.0125,
  nx: 441,
  ny: 561,
  count: 247401,
  units: "mm",
  nodata: -1,
  data_direction: "west_to_east_then_south_to_north",
  crs: "TWD67 lon/lat grid"
});

function isoNow() {
  return new Date().toISOString();
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}


const AREA_RADII_KM = [5, 10];
const AREA_THRESHOLDS_MM = [5, 10, 20, 40];

function summarizeAreaValues(values) {
  if (!values.length) {
    return {
      valid_cells: 0,
      mean_mm: null,
      max_mm: null,
      p90_mm: null,
      coverage_pct: Object.fromEntries(
        AREA_THRESHOLDS_MM.map(t => [`ge_${t}`, null])
      )
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const qIndex = Math.max(0, Math.ceil(sorted.length * 0.9) - 1);

  return {
    valid_cells: values.length,
    mean_mm: Number(
      (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)
    ),
    max_mm: Number(Math.max(...values).toFixed(1)),
    p90_mm: Number(sorted[qIndex].toFixed(1)),
    coverage_pct: Object.fromEntries(
      AREA_THRESHOLDS_MM.map(t => [
        `ge_${t}`,
        Number(
          (
            values.filter(v => v >= t).length * 100 / values.length
          ).toFixed(1)
        )
      ])
    )
  };
}

function buildQpeAreaStats({
  values, nx, ny, originLon, originLat, resLon, resLat,
  targetLat, targetLon
}) {
  const byRadius = Object.fromEntries(
    AREA_RADII_KM.map(r => [r, []])
  );

  // Restrict loops to a small bounding box around 10 km.
  const latDelta = 10.5 / 111.195;
  const lonScale = Math.max(
    0.1,
    Math.cos(targetLat * Math.PI / 180)
  );
  const lonDelta = 10.5 / (111.195 * lonScale);

  const minX = Math.max(
    0,
    Math.floor((targetLon - lonDelta - originLon) / resLon)
  );
  const maxX = Math.min(
    nx - 1,
    Math.ceil((targetLon + lonDelta - originLon) / resLon)
  );
  const minY = Math.max(
    0,
    Math.floor((targetLat - latDelta - originLat) / resLat)
  );
  const maxY = Math.min(
    ny - 1,
    Math.ceil((targetLat + latDelta - originLat) / resLat)
  );

  const nodataValues = new Set([-1, -99, -999]);

  for (let iy = minY; iy <= maxY; iy++) {
    const lat = originLat + iy * resLat;
    for (let ix = minX; ix <= maxX; ix++) {
      const lon = originLon + ix * resLon;
      const distance = haversineKm(
        targetLat, targetLon, lat, lon
      );
      if (distance > 10.05) continue;

      const raw = values[iy * nx + ix];
      if (
        !Number.isFinite(raw) ||
        raw < 0 ||
        nodataValues.has(raw)
      ) {
        continue;
      }

      for (const radius of AREA_RADII_KM) {
        if (distance <= radius + 0.05) {
          byRadius[radius].push(Number(raw));
        }
      }
    }
  }

  const result = {};
  for (const radius of AREA_RADII_KM) {
    result[`radius_${radius}km`] = {
      radius_km: radius,
      ...summarizeAreaValues(byRadius[radius])
    };
  }

  return result;
}

async function fetchTextWithTimeout(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      redirect: "follow",
      headers: {
        "User-Agent": "windyforecast-renwu/3.0",
        "Accept": "application/json, application/xml, text/xml, */*"
      }
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`CWA QPE HTTP ${response.status}`);
    }
    if (!text.trim()) {
      throw new Error("CWA QPE 回傳空內容");
    }
    return {
      text,
      contentType: response.headers.get("content-type") || "",
      finalUrl: response.url
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeKey(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function scalarNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return NaN;
  const text = value.trim();
  if (!text || text.includes(",")) return NaN;
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

function deepFindScalars(root) {
  const found = [];
  const seen = new Set();

  function walk(node, pathParts = []) {
    if (node === null || node === undefined) return;
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (v && typeof v === "object") walk(v, [...pathParts, String(i)]);
      });
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const path = [...pathParts, key];
      if (
        value === null ||
        value === undefined ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        found.push({ key, norm: normalizeKey(key), value, path: path.join(".") });
      } else {
        walk(value, path);
      }
    }
  }

  walk(root);
  return found;
}

function firstByKeys(scalars, names) {
  const targets = new Set(names.map(normalizeKey));
  for (const item of scalars) {
    if (targets.has(item.norm)) return item.value;
  }
  return undefined;
}

function numericByKeys(scalars, names) {
  const value = firstByKeys(scalars, names);
  return scalarNumber(value);
}

function datasetIdOf(root, scalars) {
  const v = firstByKeys(scalars, ["dataid", "data_id", "resource_id", "datasetid"]);
  return v ? String(v).trim() : "";
}

function normalizeTimeString(value) {
  if (value === null || value === undefined) return null;

  let s;
  if (typeof value === "object") {
    if (value.DateTime !== undefined) s = String(value.DateTime);
    else if (value.dateTime !== undefined) s = String(value.dateTime);
    else return null;
  } else {
    s = String(value);
  }

  s = s.trim();
  if (!s) return null;

  const compact = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/);
  if (compact) {
    const [, y, mo, d, h, mi, sec = "00"] = compact;
    return `${y}-${mo}-${d}T${h}:${mi}:${sec}+08:00`;
  }

  const cwa = s.match(
    /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (cwa) {
    const [, y, mo, d, h, mi, sec = "00"] = cwa;
    return `${y}-${mo}-${d}T${h}:${mi}:${sec}+08:00`;
  }

  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();

  return s;
}

function findObservationTime(root, scalars) {
  const priorities = [
    ["datatime", 100],
    ["obstime", 98],
    ["observationtime", 96],
    ["validtime", 92],
    ["datetime", 85],
    ["time", 60],
    ["sent", 20]
  ];

  let best = null;
  for (const item of scalars) {
    for (const [name, score] of priorities) {
      if (item.norm !== name) continue;
      const normalized = normalizeTimeString(item.value);
      if (!normalized) continue;
      if (!best || score > best.score) {
        best = { score, value: normalized, path: item.path };
      }
    }
  }
  return best;
}

function countCommas(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 44) n++;
  }
  return n;
}

function parseNumberList(text) {
  const tokens = String(text).trim().split(/[\s,]+/).filter(Boolean);
  const values = new Float64Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) {
      throw new Error(`QPE 格點值包含非數字：index=${i}`);
    }
    values[i] = n;
  }
  return values;
}

function collectGridCandidates(root, expectedCounts) {
  const candidates = [];
  const seen = new Set();

  function scorePath(path) {
    const p = path.toLowerCase();
    let score = 0;
    if (p.includes("contentdata")) score += 100;
    if (p.includes("contents")) score += 70;
    if (p.includes("content")) score += 50;
    if (p.includes("data")) score += 40;
    if (p.includes("value")) score += 30;
    return score;
  }

  function walk(node, pathParts = []) {
    if (node === null || node === undefined) return;

    if (typeof node === "string") {
      if (node.length < 1000 || !node.includes(",")) return;
      const approxCount = countCommas(node) + 1;
      if (expectedCounts.size && !expectedCounts.has(approxCount)) return;
      candidates.push({
        type: "string",
        value: node,
        count: approxCount,
        score: scorePath(pathParts.join(".")),
        path: pathParts.join(".")
      });
      return;
    }

    if (Array.isArray(node)) {
      if (
        node.length >= 1000 &&
        (!expectedCounts.size || expectedCounts.has(node.length)) &&
        node.every(v => Number.isFinite(Number(v)))
      ) {
        candidates.push({
          type: "array",
          value: node,
          count: node.length,
          score: scorePath(pathParts.join(".")) + 10,
          path: pathParts.join(".")
        });
        return;
      }

      node.forEach((v, i) => {
        if (v && typeof v === "object") walk(v, [...pathParts, String(i)]);
        else if (typeof v === "string" && v.length >= 1000) {
          walk(v, [...pathParts, String(i)]);
        }
      });
      return;
    }

    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    for (const [key, value] of Object.entries(node)) {
      walk(value, [...pathParts, key]);
    }
  }

  walk(root);
  return candidates.sort((a, b) => b.score - a.score || b.count - a.count);
}

function parsePayload(text, contentType) {
  const trimmed = text.trim();

  if (
    contentType.toLowerCase().includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    return { format: "JSON", object: JSON.parse(trimmed) };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    parseTagValue: false,
    trimValues: true
  });
  return { format: "XML", object: parser.parse(trimmed) };
}

export function parseQpeObject(root, { targetLat, targetLon, sourceFormat = "unknown", warnMinutes = 30, expireMinutes = 60 }) {
  const scalars = deepFindScalars(root);
  const dataId = datasetIdOf(root, scalars);

  if (dataId && dataId !== DATASET_ID) {
    throw new Error(`QPE dataset id 不符：${dataId}`);
  }

  let nx = numericByKeys(scalars, ["GridDimensionX", "dimensionX", "nx"]);
  let ny = numericByKeys(scalars, ["GridDimensionY", "dimensionY", "ny"]);

  let originLon = numericByKeys(scalars, [
    "StartPointLongitude", "startLongitude", "originLongitude", "startLon"
  ]);
  let originLat = numericByKeys(scalars, [
    "StartPointLatitude", "startLatitude", "originLatitude", "startLat"
  ]);

  let resLon = numericByKeys(scalars, [
    "GridResolutionLongitude", "LongitudeResolution", "resolutionLongitude",
    "GridResolutionX", "resolutionX"
  ]);
  let resLat = numericByKeys(scalars, [
    "GridResolutionLatitude", "LatitudeResolution", "resolutionLatitude",
    "GridResolutionY", "resolutionY"
  ]);

  const genericResolution = numericByKeys(scalars, [
    "GridResolution", "resolution"
  ]);

  if (!Number.isFinite(resLon) && Number.isFinite(genericResolution)) {
    resLon = genericResolution;
  }
  if (!Number.isFinite(resLat) && Number.isFinite(genericResolution)) {
    resLat = genericResolution;
  }

  // Fail-safe known-schema fallback. It is allowed only for this exact
  // dataset and only when the payload contains exactly the verified grid count.
  const metadataComplete =
    Number.isFinite(nx) &&
    Number.isFinite(ny) &&
    Number.isFinite(originLon) &&
    Number.isFinite(originLat) &&
    Number.isFinite(resLon) &&
    Number.isFinite(resLat);

  const expectedCounts = new Set();
  if (Number.isFinite(nx) && Number.isFinite(ny)) expectedCounts.add(nx * ny);
  expectedCounts.add(VERIFIED_KNOWN_GRID.count);

  const candidates = collectGridCandidates(root, expectedCounts);
  if (!candidates.length) {
    throw new Error("QPE payload 找不到符合網格數量的降雨數值");
  }

  const candidate = candidates[0];
  const values =
    candidate.type === "string"
      ? parseNumberList(candidate.value)
      : Float64Array.from(candidate.value.map(Number));

  let schemaSource = "payload_metadata";

  if (!metadataComplete) {
    if (values.length !== VERIFIED_KNOWN_GRID.count) {
      throw new Error(
        `QPE metadata 不完整且格點數 ${values.length} 不等於已驗證 ${VERIFIED_KNOWN_GRID.count}`
      );
    }

    nx = VERIFIED_KNOWN_GRID.nx;
    ny = VERIFIED_KNOWN_GRID.ny;
    originLon = VERIFIED_KNOWN_GRID.origin_lon;
    originLat = VERIFIED_KNOWN_GRID.origin_lat;
    resLon = VERIFIED_KNOWN_GRID.resolution_lon;
    resLat = VERIFIED_KNOWN_GRID.resolution_lat;
    schemaSource = "verified_known_O-B0045-001";
  }

  nx = Math.round(nx);
  ny = Math.round(ny);

  if (nx <= 0 || ny <= 0 || values.length !== nx * ny) {
    throw new Error(
      `QPE 網格尺寸不一致：values=${values.length}, nx=${nx}, ny=${ny}`
    );
  }

  if (resLon <= 0 || resLat <= 0) {
    throw new Error(`QPE resolution 不合理：${resLon}, ${resLat}`);
  }

  const ix = Math.round((targetLon - originLon) / resLon);
  const iy = Math.round((targetLat - originLat) / resLat);

  if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) {
    throw new Error(
      `仁武座標超出 QPE 網格：ix=${ix}/${nx}, iy=${iy}/${ny}`
    );
  }

  // CWA data direction: west->east first, then south->north.
  const index = iy * nx + ix;
  const raw = values[index];

  const nodataValues = new Set([-1, -99, -999]);
  const valueMm =
    Number.isFinite(raw) && raw >= 0 && !nodataValues.has(raw)
      ? raw
      : null;

  const gridLon = originLon + ix * resLon;
  const gridLat = originLat + iy * resLat;

  const obs = findObservationTime(root, scalars);
  const obsTime = obs?.value || null;

  let ageMinutes = null;
  if (obsTime) {
    const ms = Date.parse(obsTime);
    if (Number.isFinite(ms)) {
      ageMinutes = Math.max(0, (Date.now() - ms) / 60000);
    }
  }

  const units = String(
    firstByKeys(scalars, ["Units", "Unit", "units", "unit"]) ||
    VERIFIED_KNOWN_GRID.units
  );

  const crs = String(
    firstByKeys(scalars, [
      "CoordinateReferenceSystem", "CRS", "coordinateSystem", "datum"
    ]) || VERIFIED_KNOWN_GRID.crs
  );

  const area = buildQpeAreaStats({
    values,
    nx,
    ny,
    originLon,
    originLat,
    resLon,
    resLat,
    targetLat,
    targetLon
  });

  return {
    status: valueMm === null ? "missing" : "ok",
    schema_version: 2,
    generated_at: isoNow(),
    dataset_id: DATASET_ID,
    source_format: sourceFormat,
    observation_time: obsTime,
    observation_time_source: obs?.path || null,
    age_minutes: ageMinutes === null ? null : Number(ageMinutes.toFixed(1)),
    freshness:
      ageMinutes === null
        ? "unknown"
        : ageMinutes <= warnMinutes
          ? "fresh"
          : ageMinutes <= expireMinutes
            ? "warning"
            : "expired",
    usable_for_judgement:
      ageMinutes === null ? false : ageMinutes <= expireMinutes,
    freshness_limits_minutes: {
      warning_after: warnMinutes,
      expire_after: expireMinutes
    },
    target: {
      lat: targetLat,
      lon: targetLon
    },
    grid_point: {
      row: iy,
      column: ix,
      flat_index: index,
      lat: Number(gridLat.toFixed(6)),
      lon: Number(gridLon.toFixed(6)),
      distance_km: Number(
        haversineKm(targetLat, targetLon, gridLat, gridLon).toFixed(3)
      ),
      crs,
      datum_note:
        "QPE source grid is reported as TWD67 lon/lat in verified samples; target WGS84 coordinate is used directly for nearest-cell lookup. Datum offset is small relative to the 0.0125° grid but can matter near cell boundaries."
    },
    past_1h_qpe_mm:
      valueMm === null ? null : Number(valueMm.toFixed(1)),
    raw_value:
      valueMm === null ? null : Number(valueMm.toFixed(4)),
    units,
    area_definition: {
      radii_km: AREA_RADII_KM,
      thresholds_mm: AREA_THRESHOLDS_MM,
      method:
        "all QPE grid-cell centers within 5/10 km of target"
    },
    area,
    grid: {
      origin_lon: originLon,
      origin_lat: originLat,
      resolution_lon: resLon,
      resolution_lat: resLat,
      nx,
      ny,
      count: values.length,
      schema_source: schemaSource,
      values_path: candidate.path,
      data_direction: VERIFIED_KNOWN_GRID.data_direction
    },
    note:
      "QPE is radar + gauge integrated rainfall estimation for the past 1 hour. It is an estimate, not a station measurement and not a future forecast."
  };
}

async function writeAtomic(pathname, data) {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  const tmp = `${pathname}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, pathname);
}

async function readJson(pathname) {
  try {
    return JSON.parse(await fs.readFile(pathname, "utf8"));
  } catch {
    return null;
  }
}

export function createQpeUpdater({
  cwaApiKey,
  targetLat,
  targetLon,
  dataDir,
  refreshMinutes = 10,
  warnMinutes = 30,
  expireMinutes = 60
}) {
  const jsonPath = path.join(dataDir, "qpe-renwu.json");
  let timer = null;
  let running = false;

  const status = {
    enabled: Boolean(cwaApiKey),
    running: false,
    refresh_minutes: refreshMinutes,
    warning_after_minutes: warnMinutes,
    expire_after_minutes: expireMinutes,
    last_check_at: null,
    last_success_at: null,
    last_error_at: null,
    last_error: null,
    latest_observation_time: null,
    last_action: "尚未檢查"
  };

  async function fetchLatest() {
    if (!cwaApiKey) throw new Error("CWA_API_KEY 尚未設定");

    const attempts = ["JSON", "XML"];
    let lastError = null;

    for (const format of attempts) {
      try {
        const url = new URL(
          `https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/${DATASET_ID}`
        );
        url.searchParams.set("Authorization", cwaApiKey);
        url.searchParams.set("downloadType", "WEB");
        url.searchParams.set("format", format);

        const response = await fetchTextWithTimeout(url, 45000);
        const parsed = parsePayload(response.text, response.contentType);
        const point = parseQpeObject(parsed.object, {
          targetLat,
          targetLon,
          sourceFormat: parsed.format,
          warnMinutes,
          expireMinutes
        });

        return {
          ...point,
          fetched_at: isoNow(),
          source_url: `CWA fileapi ${DATASET_ID} (${parsed.format})`
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("QPE JSON/XML 都讀取失敗");
  }

  async function checkAndUpdate({ reason = "interval" } = {}) {
    if (running) {
      return {
        ok: true,
        skipped: true,
        reason: "already-running",
        status: { ...status }
      };
    }

    running = true;
    status.running = true;
    status.last_check_at = isoNow();
    status.last_action = `QPE 檢查中（${reason}）`;

    try {
      const latest = await fetchLatest();
      status.latest_observation_time = latest.observation_time;

      const current = await readJson(jsonPath);
      const sameObservation =
        current?.status === latest.status &&
        current?.observation_time &&
        latest.observation_time &&
        current.observation_time === latest.observation_time &&
        current?.past_1h_qpe_mm === latest.past_1h_qpe_mm &&
        Number(current?.schema_version || 0) >= 2 &&
        current?.area?.radius_10km;

      if (!sameObservation) {
        await writeAtomic(jsonPath, latest);
        status.last_action =
          `QPE 更新成功：${latest.observation_time || "時間未知"}｜${latest.past_1h_qpe_mm ?? "缺值"} mm`;
      } else {
        status.last_action =
          `QPE 無新資料：${latest.observation_time || "時間未知"}`;
      }

      status.last_success_at = isoNow();
      status.last_error = null;

      return {
        ok: true,
        updated: !sameObservation,
        data: latest,
        status: { ...status }
      };
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "QPE upstream timeout"
          : error instanceof Error
            ? error.message
            : String(error);

      status.last_error_at = isoNow();
      status.last_error = message;
      status.last_action = `QPE 更新失敗：${message}`;
      console.error(`[qpe] ${message}`);

      return {
        ok: false,
        updated: false,
        error: message,
        status: { ...status }
      };
    } finally {
      running = false;
      status.running = false;
    }
  }

  function start() {
    if (timer) return;

    const startup = setTimeout(() => {
      void checkAndUpdate({ reason: "startup" });
    }, 4000);
    startup.unref?.();

    timer = setInterval(() => {
      void checkAndUpdate({ reason: "interval" });
    }, refreshMinutes * 60 * 1000);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    return { ...status };
  }

  return {
    start,
    stop,
    checkAndUpdate,
    getStatus
  };
}
