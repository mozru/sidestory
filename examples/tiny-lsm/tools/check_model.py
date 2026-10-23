#!/usr/bin/env python3
"""Checks the simulation widget's model against the real code.

Runs every scenario of .explain/lsm-overview/widgets/model.ts through tiny_lsm with the
model's limits, and compares what each ends with: the tables of every level (file
number, key range, size, entries and bloom filter bits), the memtable, the live log,
and what each get and scan returned. From examples/tiny-lsm (Python 3.11+, Node 22.18+):

    node tools/model_trace.mjs | python3 tools/check_model.py
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tiny_lsm import DB, Options  # noqa: E402


def main() -> int:
    model = json.load(sys.stdin)
    o = model["opts"]
    opts = Options(
        memtable_bytes=o["memtableBytes"], block_bytes=o["blockBytes"], table_bytes=o["tableBytes"],
        bloom_bits_per_key=o["bloomBitsPerKey"], l0_limit=o["l0Limit"], level_base_bytes=o["levelBaseBytes"],
        level_multiplier=o["levelMultiplier"], num_levels=o["numLevels"],
    )
    failures = 0
    for name, scenario in model["scenarios"].items():
        before = failures
        with tempfile.TemporaryDirectory() as tmp, DB(tmp, opts) as db:
            results = []
            for i, op in enumerate(scenario["ops"]):
                if op["kind"] == "put":
                    db.put(op["key"].encode(), op["value"].encode())
                elif op["kind"] == "del":
                    db.delete(op["key"].encode())
                elif op["kind"] == "get":
                    value = db.get(op["key"].encode())
                    results.append({"op": i, "value": None if value is None else value.decode()})
                else:
                    start, end = (None if b is None else b.encode() for b in (op["start"], op["end"]))
                    results.append({"op": i, "out": [{"key": k.decode(), "value": v.decode()} for k, v in db.scan(start, end)]})
            real = {
                "levels": [
                    [
                        {
                            "num": int(t.path.stem), "min": t.min_key.decode(), "max": t.max_key.decode(), "size": t.size,
                            "entries": [{"key": k.decode(), "value": None if v is None else v.decode()} for k, v in t.items()],
                            "bloom": [p for p in range(t.bloom.num_bits) if t.bloom.bits[p // 8] >> (p % 8) & 1],
                        }
                        for t in level
                    ]
                    for level in db._levels.levels
                ],
                "mem": [{"key": k.decode(), "value": None if v is None else v.decode()} for k, v in db._mem.items()],
                "log": db._levels.log_number,
            }
            for field in ("levels", "mem", "log"):
                if real[field] != scenario[field]:
                    failures += 1
                    print(f"{name}: {field} differs\n  model: {scenario[field]}\n  code:  {real[field]}")
            for got, want in zip(results, scenario["results"]):
                expected = want["out"] if "out" in got else _value(want["result"])
                actual = got.get("out", got.get("value"))
                if actual != expected:
                    failures += 1
                    print(f"{name}: op {got['op']} returned {actual!r}, the model says {expected!r}")
        print(f"{name}: {'same as the code' if failures == before else 'DIFFERENT'}")
    return 1 if failures else 0


def _value(result: str) -> str | None:
    """The model's result text for a get: a JSON string, or None."""
    return json.loads(result) if result.startswith('"') else None


if __name__ == "__main__":
    sys.exit(main())
