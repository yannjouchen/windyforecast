import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createQpeUpdater } from "../lib/qpe-updater.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const updater = createQpeUpdater({
  cwaApiKey: String(process.env.CWA_API_KEY || "").trim(),
  targetLat: Number(process.env.TARGET_LAT || 22.705864872692686),
  targetLon: Number(process.env.TARGET_LON || 120.33468473266137),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, "data")),
  refreshMinutes: Number(process.env.QPE_REFRESH_MINUTES || 10),
  warnMinutes: Number(process.env.QPE_WARN_MINUTES || 30),
  expireMinutes: Number(process.env.QPE_EXPIRE_MINUTES || 60)
});

const result = await updater.checkAndUpdate({
  reason: "npm-qpe-check"
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
