#!/usr/bin/env python3
"""Build country-wide, read-only DriveDen golf geometry tiles from an OSM extract.

Input: GeoJSON exported by osmium from Geofabrik South Africa OSM PBF.
Output: 1-degree tiles of golf=hole/tee/green geometries. © OSM contributors,
ODbL. Never publishes or edits OpenStreetMap.
"""
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

def geometry_points(geom):
    if not isinstance(geom, dict):
        return []
    typ = geom.get("type")
    c = geom.get("coordinates")
    if typ == "Point":
        coords = [c]
    elif typ == "LineString":
        coords = c
    elif typ == "Polygon":
        coords = max(c or [], key=len, default=[])
    elif typ == "MultiLineString":
        coords = max(c or [], key=len, default=[])
    elif typ == "MultiPolygon":
        polygons = [ring for poly in (c or []) for ring in (poly[:1] if poly else [])]
        coords = max(polygons, key=len, default=[])
    else:
        return []
    result = []
    for item in coords or []:
        if not isinstance(item, list) or len(item) < 2:
            continue
        lon, lat = item[:2]
        if isinstance(lon, (float, int)) and isinstance(lat, (float, int)) and -36 <= lat <= -20 and 15 <= lon <= 35:
            result.append({"lat": round(lat, 7), "lon": round(lon, 7)})
    return result[:1800]

def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: build_golf_osm_tiles.py INPUT.geojson DESTINATION_DIRECTORY")
    input_path = Path(sys.argv[1])
    target = Path(sys.argv[2])
    target.mkdir(parents=True, exist_ok=True)
    source = json.loads(input_path.read_text(encoding="utf-8"))
    grouped = {}
    counts = {"hole": 0, "tee": 0, "green": 0}
    for i, feat in enumerate(source.get("features", [])):
        prop = feat.get("properties") or {}
        golf = prop.get("golf")
        if golf not in counts:
            continue
        coords = geometry_points(feat.get("geometry"))
        if len(coords) < (2 if golf == "hole" else 1):
            continue
        centre_lat = sum(p["lat"] for p in coords) / len(coords)
        centre_lon = sum(p["lon"] for p in coords) / len(coords)
        key = f"{math.floor(centre_lat)}_{math.floor(centre_lon)}"
        item = {
            "type": "way" if feat["geometry"]["type"] != "Point" else "node",
            "id": str(feat.get("id") or prop.get("@id") or f"generated-{i}"),
            "tags": {"golf": golf, "ref": str(prop.get("ref") or ""), "name": str(prop.get("name") or "")},
            "geometry": coords,
        }
        grouped.setdefault(key, []).append(item)
        counts[golf] += 1
    if counts["hole"] < 20:
        raise SystemExit(f"Refusing to publish unexpectedly sparse golf dataset: {counts}")
    for old in target.glob("*.json"):
        old.unlink()
    for key, items in grouped.items():
        (target / f"{key}.json").write_text(json.dumps(items, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    manifest = {
        "source": "Geofabrik South Africa OpenStreetMap extract",
        "attribution": "© OpenStreetMap contributors",
        "licence": "ODbL 1.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "featureCounts": counts,
        "tileCount": len(grouped),
    }
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))

if __name__ == "__main__":
    main()
