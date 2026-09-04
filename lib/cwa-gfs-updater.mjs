import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const FULL_HOURS = [24, 48, 72, 96, 120];

function isoNow() {
  return new Date().toISOString();
}

function normalizeInitialTime(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 12 ? digits.slice(0, 12) : "";
}

async function fetchJson(url, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "User-Agent": "windyforecast-renwu/1.6"
      }
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`CWA GFS metadata 非 JSON（HTTP ${response.status}）`);
    }

    if (!response.ok) {
      throw new Error(
        data?.message ||
        data?.error ||
        `CWA GFS metadata HTTP ${response.status}`
      );
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function parseMetadata(payload, expectedHour) {
  const root = payload?.cwaopendata || payload;
  const dataset = root?.dataset || payload?.dataset;
  const info = dataset?.datasetInfo;
  const resource = dataset?.resource;

  if (!info) {
    throw new Error(`M-A0060-${String(expectedHour).padStart(3, "0")} 缺少 datasetInfo`);
  }

  const initialTime = normalizeInitialTime(
    info.InitialTime ?? info.initialTime
  );
  const forecastHour = Number(
    info.ForecastHour ?? info.forecastHour
  );
  const resourceUri = String(resource?.uri || "").trim();

  if (!initialTime) {
    throw new Error("CWA GFS metadata 缺少 InitialTime");
  }
  if (forecastHour !== expectedHour) {
    throw new Error(
      `CWA GFS ForecastHour 不符：expected=${expectedHour}, actual=${forecastHour}`
    );
  }
  if (!resourceUri.startsWith("https://")) {
    throw new Error(`CWA GFS +${expectedHour} 缺少 HTTPS resource.uri`);
  }

  return {
    initialTime,
    forecastHour,
    resourceUri,
    gridResolution: String(info.GridResolution || ""),
    gridX: Number(info.GridDimensionX || NaN),
    gridY: Number(info.GridDimensionY || NaN)
  };
}

async function readCurrentJson(jsonPath) {
  try {
    return JSON.parse(await fs.readFile(jsonPath, "utf8"));
  } catch {
    return null;
  }
}

function runPython({ pythonBin, scriptPath, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      const s = chunk.toString();
      stdout += s;
      process.stdout.write(`[cwa-gfs:python] ${s}`);
    });

    child.stderr.on("data", chunk => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(`[cwa-gfs:python] ${s}`);
    });

    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        reject(
          new Error(
            `Python CWA GFS extractor 結束碼 ${code}` +
            (stderr.trim() ? `：${stderr.trim().slice(-1600)}` : "")
          )
        );
      }
    });
  });
}

export function createCwaGfsUpdater({
  enabled = false,
  cwaApiKey,
  targetLat,
  targetLon,
  dataDir,
  refreshMinutes = 360,
  pythonBin = "python3"
}) {
  const jsonPath = path.join(dataDir, "cwa-gfs-renwu.json");
  const probePath = path.join(dataDir, "cwa-gfs-probe.json");
  const scriptPath = path.join(
    PROJECT_ROOT,
    "scripts",
    "extract_cwa_gfs.py"
  );

  let timer = null;
  let running = false;

  const status = {
    enabled: Boolean(enabled && cwaApiKey),
    configured: Boolean(cwaApiKey),
    running: false,
    refresh_minutes: refreshMinutes,
    last_check_at: null,
    last_success_at: null,
    last_error_at: null,
    last_error: null,
    latest_cwa_initial_time: null,
    local_initial_time: null,
    last_action: enabled
      ? "尚未檢查"
      : "CWA GFS 直讀實驗尚未啟用"
  };

  async function getMetadata(hour) {
    if (!cwaApiKey) {
      throw new Error("CWA_API_KEY 尚未設定");
    }

    const code = String(hour).padStart(3, "0");
    const url = new URL(
      `https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/M-A0060-${code}`
    );
    url.searchParams.set("Authorization", cwaApiKey);
    url.searchParams.set("format", "JSON");

    const payload = await fetchJson(url);
    return parseMetadata(payload, hour);
  }

  async function probe() {
    if (running) {
      return { ok: true, skipped: true, reason: "already-running", status: { ...status } };
    }

    running = true;
    status.running = true;
    status.last_check_at = isoNow();
    status.last_action = "CWA GFS probe：檢查 +024";

    try {
      await fs.mkdir(dataDir, { recursive: true });
      const meta = await getMetadata(24);
      status.latest_cwa_initial_time = meta.initialTime;

      await runPython({
        pythonBin,
        scriptPath,
        env: {
          CWA_GFS_MODE: "probe",
          CWA_EXPECTED_INITIAL_TIME: meta.initialTime,
          CWA_GFS_SOURCES_JSON: JSON.stringify({
            "24": meta.resourceUri
          }),
          TARGET_LAT: String(targetLat),
          TARGET_LON: String(targetLon),
          OUTPUT_JSON: probePath
        }
      });

      const result = await readCurrentJson(probePath);
      if (!result || result.status !== "ok") {
        throw new Error("probe 完成，但 cwa-gfs-probe.json 無效");
      }

      status.last_success_at = isoNow();
      status.last_error = null;
      status.last_action =
        `probe 成功：${meta.initialTime}，usable=${Boolean(result.usable_for_5day)}`;

      return {
        ok: true,
        probe: result,
        status: { ...status }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.last_error_at = isoNow();
      status.last_error = message;
      status.last_action = `probe 失敗：${message}`;
      return {
        ok: false,
        error: message,
        status: { ...status }
      };
    } finally {
      running = false;
      status.running = false;
    }
  }

  async function checkAndUpdate({
    reason = "interval",
    force = false
  } = {}) {
    if (!enabled) {
      return {
        ok: true,
        skipped: true,
        reason: "disabled",
        status: { ...status }
      };
    }

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
    status.last_action = `CWA GFS 檢查中（${reason}）`;

    try {
      await fs.mkdir(dataDir, { recursive: true });

      // +024 is the cycle marker. Avoid five metadata calls when nothing changed.
      const marker = await getMetadata(24);
      status.latest_cwa_initial_time = marker.initialTime;

      const current = await readCurrentJson(jsonPath);
      const localInitial = normalizeInitialTime(
        current?.cwa_initial_time
      );
      status.local_initial_time = localInitial || null;

      if (
        !force &&
        current?.status === "ok" &&
        localInitial &&
        localInitial === marker.initialTime
      ) {
        status.last_error = null;
        status.last_action =
          `無新批次：${marker.initialTime}，沿用 CWA GFS JSON`;
        return {
          ok: true,
          updated: false,
          initial_time: marker.initialTime,
          status: { ...status }
        };
      }

      status.last_action =
        `發現 CWA GFS ${marker.initialTime}，驗證 +024/+048/+072/+096/+120 metadata`;

      const metas = await Promise.all(
        FULL_HOURS.map(hour => getMetadata(hour))
      );

      const cycles = new Set(metas.map(x => x.initialTime));
      if (cycles.size !== 1 || !cycles.has(marker.initialTime)) {
        throw new Error(
          `CWA GFS forecast-hour 檔案尚未同步到同一 cycle：${[...cycles].join(", ")}`
        );
      }

      const sources = {};
      metas.forEach(meta => {
        sources[String(meta.forecastHour)] = meta.resourceUri;
      });

      status.last_action =
        `CWA GFS ${marker.initialTime} metadata 一致，啟動 Python 解析 1–5 天`;

      await runPython({
        pythonBin,
        scriptPath,
        env: {
          CWA_GFS_MODE: "full",
          CWA_EXPECTED_INITIAL_TIME: marker.initialTime,
          CWA_GFS_SOURCES_JSON: JSON.stringify(sources),
          TARGET_LAT: String(targetLat),
          TARGET_LON: String(targetLon),
          OUTPUT_JSON: jsonPath
        }
      });

      const updated = await readCurrentJson(jsonPath);
      if (!updated || updated.status !== "ok") {
        throw new Error("Python 完成，但 cwa-gfs-renwu.json 無效");
      }

      if (
        normalizeInitialTime(updated.cwa_initial_time) !== marker.initialTime
      ) {
        throw new Error(
          `CWA GFS JSON cycle 不一致：expected=${marker.initialTime} actual=${updated.cwa_initial_time}`
        );
      }

      if (!Array.isArray(updated.forecast) || updated.forecast.length !== 5) {
        throw new Error("CWA GFS JSON 缺少完整 5 個 24h 區段");
      }

      status.last_success_at = isoNow();
      status.last_error = null;
      status.local_initial_time = marker.initialTime;
      status.last_action = `更新成功：${marker.initialTime}`;

      return {
        ok: true,
        updated: true,
        initial_time: marker.initialTime,
        status: { ...status }
      };
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "CWA GFS upstream timeout"
          : error instanceof Error
            ? error.message
            : String(error);

      status.last_error_at = isoNow();
      status.last_error = message;
      status.last_action = `更新失敗：${message}`;
      console.error(`[cwa-gfs] ${message}`);

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
    if (!enabled || timer) return;

    const startup = setTimeout(() => {
      void checkAndUpdate({ reason: "startup" });
    }, 12000);
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
    probe,
    checkAndUpdate,
    getStatus
  };
}
