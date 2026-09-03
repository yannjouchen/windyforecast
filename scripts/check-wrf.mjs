import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWrfUpdater } from "../lib/wrf-updater.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const updater = createWrfUpdater({
  cwaApiKey: String(process.env.CWA_API_KEY || "").trim(),
  targetLat: Number(process.env.TARGET_LAT || 22.705864872692686),
  targetLon: Number(process.env.TARGET_LON || 120.33468473266137),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, "data")),
  refreshMinutes: Number(process.env.WRF_REFRESH_MINUTES || 60),
  pythonBin: process.env.PYTHON_BIN || "python3"
});

const result = await updater.checkAndUpdate({
  reason: "npm-wrf-check",
  force: process.argv.includes("--force")
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
