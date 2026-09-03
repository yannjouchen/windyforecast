#!/usr/bin/env python3
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pygrib
import requests

TARGET_LAT = float(os.environ.get("TARGET_LAT", "22.705864872692686"))
TARGET_LON = float(os.environ.get("TARGET_LON", "120.33468473266137"))
HOURS = [6, 12, 18]
BASE_URL = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Model"
OUT = Path(os.environ.get("OUTPUT_JSON", "wrf-renwu.json"))
WORK = Path(os.environ.get("WORK_DIR", ".wrf_tmp"))
WORK.mkdir(parents=True, exist_ok=True)


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2-lat1)
    dl = math.radians(lon2-lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*r*math.asin(math.sqrt(a))


def download(hour):
    code = f"{hour:03d}"
    url = f"{BASE_URL}/M-A0064-{code}.grb2"
    path = WORK / f"M-A0064-{code}.grb2"
    print(f"Downloading {url}", flush=True)
    with requests.get(url, stream=True, timeout=(30, 300)) as r:
        r.raise_for_status()
        with open(path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024*1024):
                if chunk:
                    f.write(chunk)
    print(f"Downloaded {path.stat().st_size/1024/1024:.1f} MB", flush=True)
    return path, url


def candidate_score(msg):
    name = str(getattr(msg, "name", "")).lower()
    short = str(getattr(msg, "shortName", "")).lower()
    param = str(getattr(msg, "parameterName", "")).lower()
    step_type = str(getattr(msg, "stepType", "")).lower()
    units = str(getattr(msg, "units", "")).lower()
    level_type = str(getattr(msg, "typeOfLevel", "")).lower()
    text = " ".join([name, short, param])

    score = 0
    if "total precipitation" in text:
        score += 100
    if "precipitation" in text:
        score += 50
    if short in {"tp", "apcp", "acpcp"}:
        score += 80
    if step_type in {"accum", "accumulation"}:
        score += 30
    if "surface" in level_type:
        score += 10
    if "kg" in units and ("m-2" in units or "m**-2" in units):
        score += 10
    if units in {"mm", "m"}:
        score += 10
    return score


def choose_precip_message(grbs):
    candidates = []
    for i, msg in enumerate(grbs, start=1):
        s = candidate_score(msg)
        if s > 0:
            candidates.append((s, i, msg))

    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        s, i, msg = candidates[0]
        print(
            f"Precip candidate message={i} score={s} "
            f"name={getattr(msg,'name','')} shortName={getattr(msg,'shortName','')} "
            f"units={getattr(msg,'units','')} stepType={getattr(msg,'stepType','')}",
            flush=True,
        )
        return i, msg

    # Historical CWA WRF 3-km files have sometimes exposed precipitation
    # as an "unknown" GRIB parameter. Older operational examples identify
    # message 62 as the accumulated rainfall field. Keep this only as a
    # fallback, and validate the resulting value below.
    try:
        msg = grbs.message(62)
        print(
            "WARNING: precipitation metadata not recognized; "
            "falling back to GRIB message 62",
            flush=True,
        )
        return 62, msg
    except Exception as e:
        raise RuntimeError("Cannot identify precipitation field") from e


def extract_point(path):
    grbs = pygrib.open(str(path))
    try:
        msg_no, msg = choose_precip_message(grbs)
        values = np.ma.asarray(msg.values)
        lats, lons = msg.latlons()

        # Longitude-aware local-distance approximation for finding nearest cell.
        scale = math.cos(math.radians(TARGET_LAT))
        d2 = (lats - TARGET_LAT)**2 + ((lons - TARGET_LON)*scale)**2
        if np.ma.isMaskedArray(values):
            d2 = np.where(np.ma.getmaskarray(values), np.inf, d2)

        flat = int(np.nanargmin(d2))
        iy, ix = np.unravel_index(flat, d2.shape)

        raw = float(values[iy, ix])
        units = str(getattr(msg, "units", "")).strip()
        u = units.lower()

        if u == "m":
            mm = raw * 1000.0
        else:
            # mm and kg m^-2 are equivalent for liquid-water depth.
            mm = raw

        if not math.isfinite(mm) or mm < -0.01 or mm > 5000:
            raise RuntimeError(
                f"Implausible precipitation {mm} {units} from message {msg_no}"
            )

        anal = getattr(msg, "analDate", None)
        valid = getattr(msg, "validDate", None)
        ftime = getattr(msg, "forecastTime", None)

        return {
            "message_number": msg_no,
            "name": str(getattr(msg, "name", "")),
            "short_name": str(getattr(msg, "shortName", "")),
            "units": units,
            "step_type": str(getattr(msg, "stepType", "")),
            "cumulative_mm": round(mm, 3),
            "grid_lat": float(lats[iy, ix]),
            "grid_lon": float(lons[iy, ix]),
            "analysis_time": anal.isoformat() if anal else None,
            "valid_time": valid.isoformat() if valid else None,
            "forecast_time": int(ftime) if ftime is not None else None,
        }
    finally:
        grbs.close()


def main():
    rows = []
    sources = []
    for hour in HOURS:
        path, url = download(hour)
        x = extract_point(path)
        x["forecast_hour"] = hour
        rows.append(x)
        sources.append(url)

    # Prevent mixing files from two model cycles while CWA is updating S3.
    analyses = {x["analysis_time"] for x in rows if x["analysis_time"]}
    if len(analyses) > 1:
        raise RuntimeError(f"Mixed WRF cycles detected: {sorted(analyses)}")

    # Grid point should be identical across forecast-hour files.
    grid_lat = rows[0]["grid_lat"]
    grid_lon = rows[0]["grid_lon"]

    prev = 0.0
    forecast = []
    for x in sorted(rows, key=lambda z: z["forecast_hour"]):
        cumulative = x["cumulative_mm"]
        period = cumulative - prev
        # A tiny negative value can occur from encoding precision; a real
        # decrease indicates the field is not cumulative or files are inconsistent.
        if period < -0.2:
            raise RuntimeError(
                f"Cumulative precipitation decreased at +{x['forecast_hour']}h: "
                f"{prev} -> {cumulative} mm"
            )
        period = max(0.0, period)
        forecast.append({
            "forecast_hour": x["forecast_hour"],
            "valid_time": x["valid_time"],
            "cumulative_mm": round(cumulative, 1),
            "period_mm": round(period, 1),
        })
        prev = cumulative

    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    result = {
        "status": "ok",
        "generated_at": now,
        "model": "CWA WRF 3 km",
        "model_initial_time": rows[0]["analysis_time"],
        "target": {"lat": TARGET_LAT, "lon": TARGET_LON},
        "grid_point": {
            "lat": round(grid_lat, 6),
            "lon": round(grid_lon, 6),
            "distance_km": round(
                haversine_km(TARGET_LAT, TARGET_LON, grid_lat, grid_lon), 3
            ),
        },
        "forecast": forecast,
        "source_files": sources,
        "grib_field": {
            "message_number": rows[0]["message_number"],
            "name": rows[0]["name"],
            "short_name": rows[0]["short_name"],
            "units": rows[0]["units"],
            "step_type": rows[0]["step_type"],
        },
        "note": (
            "CWA WRF M-A0064 files are forecast-hour GRIB2 products. "
            "period_mm is calculated from differences of accumulated precipitation."
        ),
    }

    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        err = {
            "status": "error",
            "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "message": str(e),
            "target": {"lat": TARGET_LAT, "lon": TARGET_LON},
        }
        OUT.write_text(json.dumps(err, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(err, ensure_ascii=False, indent=2), file=sys.stderr)
        raise
