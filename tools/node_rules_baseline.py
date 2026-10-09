#!/usr/bin/env python3
"""Split / merge the node-rules baseline between one monolithic JSON file and
a directory of small files.

Layout of the directory form (default: docs/node-rules-baseline/):

    meta.json                       snapshot metadata + ordered list of entries
    <edition>/<kind>/<slug>/
        entry.json                  slug, name, parent, choices, levels
        level-01.json ...           {"level": N, "sheet": {...}} per snapshot

Usage:
    python3 tools/node_rules_baseline.py split [--src FILE] [--dst DIR]
    python3 tools/node_rules_baseline.py merge [--src DIR] [--dst FILE]
    python3 tools/node_rules_baseline.py check [--src FILE] [--dst DIR]

`check` splits nothing: it merges DIR in memory and compares it with FILE.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FILE = ROOT / "docs" / "node-rules-baseline.json"
DEFAULT_DIR = ROOT / "docs" / "node-rules-baseline"


def _dump(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _load(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def split(src: Path, dst: Path) -> None:
    data = _load(src)
    entries = []
    for edition, body in data["editions"].items():
        for kind in ("races", "classes"):
            for entry in body.get(kind, []):
                slug = entry["slug"]
                rel_dir = f"{edition}/{kind}/{slug}"
                levels = []
                for snap in entry.get("snapshots", []):
                    level = snap["level"]
                    levels.append(level)
                    _dump(dst / rel_dir / f"level-{level:02d}.json",
                          {"level": level, "sheet": snap["sheet"]})
                head = {k: v for k, v in entry.items() if k != "snapshots"}
                head["edition"] = edition
                head["kind"] = kind
                head["levels"] = levels
                _dump(dst / rel_dir / "entry.json", head)
                entries.append(rel_dir)

    meta = dict(data["meta"])
    meta["layout"] = "directory"
    meta["entries"] = entries
    _dump(dst / "meta.json", meta)


def merge(src: Path) -> dict:
    meta = _load(src / "meta.json")
    out_meta = {k: v for k, v in meta.items() if k not in ("entries", "layout")}
    editions: dict = {}
    for rel_dir in meta["entries"]:
        base = src / rel_dir
        head = _load(base / "entry.json")
        edition = head.pop("edition")
        kind = head.pop("kind")
        levels = head.pop("levels")
        snapshots = []
        for level in levels:
            snap = _load(base / f"level-{level:02d}.json")
            snapshots.append({"level": snap["level"], "sheet": snap["sheet"]})
        head["snapshots"] = snapshots
        ed = editions.setdefault(edition, {"races": [], "classes": []})
        ed[kind].append(head)
    # Keep the edition order of the original file (2014 before 2024).
    ordered_editions = {k: editions[k] for k in sorted(editions)}
    return {"meta": out_meta, "editions": ordered_editions}


def check(src: Path, dst: Path) -> bool:
    original = _load(src)
    rebuilt = merge(dst)
    if original == rebuilt:
        print(f"OK: {dst} merges to the same data as {src}")
        return True
    print("MISMATCH: directory form differs from the monolithic file", file=sys.stderr)
    return False


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("split", "merge", "check"):
        sp = sub.add_parser(name)
        sp.add_argument("--src", type=Path)
        sp.add_argument("--dst", type=Path)
    args = p.parse_args(argv)

    if args.cmd == "split":
        split(args.src or DEFAULT_FILE, args.dst or DEFAULT_DIR)
        print(f"split -> {args.dst or DEFAULT_DIR}")
        return 0
    if args.cmd == "merge":
        data = merge(args.src or DEFAULT_DIR)
        out = args.dst or DEFAULT_FILE
        _dump(out, data)
        print(f"merged -> {out}")
        return 0
    return 0 if check(args.src or DEFAULT_FILE, args.dst or DEFAULT_DIR) else 1


if __name__ == "__main__":
    sys.exit(main())
