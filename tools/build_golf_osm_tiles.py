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

def hazard_kind(prop):
    golf = prop.get("golf")
    if golf == "bunker":
        return "bunker"
    if golf in ("water_hazard", "lateral_water_hazard") or prop.get("natural") == "water" or prop.get("waterway") == "riverbank":
        return "water"
    if prop.get("waterway") in ("river", "stream", "canal", "ditch"):
        return "water_line"
    return None

def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: build_golf_osm_tiles.py INPUT.geojson DESTINATION_DIRECTORY")
    input_path = Path(sys.argv[1])
    target = Path(sys.argv[2])
    target.mkdir(parents=True, exist_ok=True)
    source = json.loads(input_path.read_text(encoding="utf-8"))
    grouped = {}
    counts = {"hole": 0, "tee": 0, "green": 0, "bunker": 0, "water": 0, "water_line": 0}
    for i, feat in enumerate(source.get("features", [])):
        prop = feat.get("properties") or {}
        golf = prop.get("golf")
        if golf not in ("hole", "tee", "green"):
            golf = hazard_kind(prop)
        if golf not in counts:
            continue
        coords = geometry_points(feat.get("geometry"))
        if golf in ("bunker", "water") and feat["geometry"]["type"] not in ("Polygon", "MultiPolygon"):
            continue
        if golf == "water_line" and feat["geometry"]["type"] not in ("LineString", "MultiLineString"):
            continue
        if len(coords) < (4 if golf in ("bunker", "water") else 2 if golf in ("hole", "water_line") else 1):
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
    # Retain hazards only near mapped golf routes.
    cells = set()
    for items in grouped.values():
        for item in items:
            if item["tags"]["golf"] in ("hole", "tee", "green"):
                for pt in item["geometry"]:
                    cells.add((math.floor(pt["lat"] * 100), math.floor(pt["lon"] * 100)))
    nearby = {(a+dy,b+dx) for a,b in cells for dy in (-1,0,1) for dx in (-1,0,1)}
    for key in list(grouped):
        kept = []
        for item in grouped[key]:
            kind = item["tags"]["golf"]
            if kind in ("water", "water_line", "bunker") and not any((math.floor(p["lat"]*100), math.floor(p["lon"]*100)) in nearby for p in item["geometry"]):
                counts[kind] -= 1
                continue
            kept.append(item)
        if kept:
            grouped[key] = kept
        else:
            del grouped[key]
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
