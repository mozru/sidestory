#!/usr/bin/env python3
"""Generates the diagrams and widget data of the tiny-lsm sidestories.

- SVGs go between `<!-- diagram:NAME -->` and `<!-- /diagram:NAME -->` markers in each sidestory.html,
  and the shared diagram styles between `/* dia-css */` markers in their <style>.
- The overview's geometry goes to .sidestory/lsm-overview/widgets/layout.json, so the static diagram and
  the simulation widget draw the same picture.
- lines.json (next to the widgets) maps each simulation step to the line of Python it "runs", relative
  to the anchor it is shown in, found by searching the code: rerun this after editing the code.
- The SSTable, bloom filter, compaction and merge figures are drawn from real data: the script runs
  tiny_lsm and draws what it wrote.

Run from examples/tiny-lsm with Python 3.11+:

    python3 tools/diagrams.py

Styling lives in each sidestory's <style> (classes .blk, .w-write, .w-read ...), so the diagrams take
the reader's VS Code theme colours; nothing here is a literal colour.
"""
import heapq
import json
import math
import re
import shutil
import sys
import tempfile
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIDESTORY = ROOT / ".sidestory"
sys.path.insert(0, str(ROOT))

from tiny_lsm import DB, Options  # noqa: E402
from tiny_lsm.bloom import BloomFilter  # noqa: E402
from tiny_lsm.encoding import HEADER  # noqa: E402
from tiny_lsm.sstable import FOOTER, SSTable, TableBuilder  # noqa: E402


class Diagram:
    def __init__(self, w, h, label, x0=0, y0=0):
        self.w, self.h, self.label, self.x0, self.y0 = w, h, label, x0, y0
        self.blocks, self.wires, self.extra = [], [], []

    def block(self, id, x, y, w, h, title, sub="", kind="data", ref=None, lines=(), groups=""):
        self.blocks.append(dict(id=id, x=x, y=y, w=w, h=h, title=title, sub=sub, kind=kind, ref=ref, lines=list(lines), groups=groups))

    def wire(self, id, kind, pts, label="", at=None, anchor="middle", both=False, head=True, groups=""):
        """kind: write | read | ctl | rec. label lines split on '|'. at = (x, y) of the label's first line."""
        self.wires.append(dict(id=id, kind=kind, pts=pts, label=label, at=at, anchor=anchor, both=both, head=head, groups=groups))

    @staticmethod
    def head(p, q, size):
        (x1, y1), (x2, y2) = p, q
        a = math.atan2(y2 - y1, x2 - x1)
        l, s = size * 1.6, size
        bx, by = x2 - l * math.cos(a), y2 - l * math.sin(a)
        px, py = -math.sin(a) * s, math.cos(a) * s
        return f"{x2:.1f},{y2:.1f} {bx + px:.1f},{by + py:.1f} {bx - px:.1f},{by - py:.1f}"

    def wire_svg(self, wd):
        size = {"write": 5.5, "read": 4.5, "ctl": 4, "rec": 4}[wd["kind"]]
        pts = wd["pts"]
        d = "M" + " L".join(f"{x},{y}" for x, y in pts)
        groups = " ".join(f"g-{g}" for g in wd["groups"].split())
        out = [f'<g class="w w-{wd["kind"]} {groups}" data-wire="{wd["id"]}">', f'<path class="w-line" d="{d}"/>']
        if wd["head"]:
            out.append(f'<polygon class="w-head" points="{self.head(pts[-2], pts[-1], size)}"/>')
        if wd["both"]:
            out.append(f'<polygon class="w-head" points="{self.head(pts[1], pts[0], size)}"/>')
        if wd["label"]:
            x, y = wd["at"]
            for i, line in enumerate(wd["label"].split("|")):
                out.append(f'<text class="w-label" x="{x}" y="{y + i * 12}" text-anchor="{wd["anchor"]}">{escape(line)}</text>')
        out.append("</g>")
        return "".join(out)

    def block_svg(self, b):
        attrs = f' data-explain-ref="{b["ref"]}" aria-label="{escape(b["title"])}: show its code"' if b["ref"] else ""
        groups = " ".join(f"g-{g}" for g in b["groups"].split())
        out = [f'<g class="blk blk-{b["kind"]} {groups}" data-block="{b["id"]}"{attrs}>',
               f'<rect class="blk-box" x="{b["x"]}" y="{b["y"]}" width="{b["w"]}" height="{b["h"]}" rx="6"/>']
        if b["kind"] == "level":
            out.append(f'<text class="blk-title lvl-title" x="{b["x"] + 14}" y="{b["y"] + 30}">{escape(b["title"])}</text>')
            for i, line in enumerate(b["lines"]):
                out.append(f'<text class="blk-line" x="{b["x"] + 14}" y="{b["y"] + 50 + i * 13}">{escape(line)}</text>')
        else:
            cx = b["x"] + b["w"] / 2
            if b["kind"] in ("data", "ctl"):
                out.append(f'<rect class="blk-bar" x="{b["x"]}" y="{b["y"]}" width="{b["w"]}" height="5" rx="2"/>')
            out.append(f'<text class="blk-title" x="{cx}" y="{b["y"] + 24}" text-anchor="middle">{escape(b["title"])}</text>')
            if b["sub"]:
                out.append(f'<text class="blk-sub" x="{cx}" y="{b["y"] + 40}" text-anchor="middle">{escape(b["sub"])}</text>')
            for i, line in enumerate(b["lines"]):
                out.append(f'<text class="blk-line" x="{cx}" y="{b["y"] + 60 + i * 13}" text-anchor="middle">{escape(line)}</text>')
        out.append("</g>")
        return "".join(out)

    def svg(self, cls="dia"):
        body = "".join(self.wire_svg(w) for w in self.wires) + "".join(self.block_svg(b) for b in self.blocks) + "".join(self.extra)
        return (f'<svg class="{cls}" viewBox="{self.x0} {self.y0} {self.w} {self.h}" role="img" '
                f'aria-label="{escape(self.label)}">{body}</svg>')

    def layout(self):
        return dict(viewBox=[self.x0, self.y0, self.w, self.h], blocks=self.blocks, wires=self.wires, tables=TABLE_AREA)


def legend(d, x, y, items):
    out = []
    for i, (kind, text) in enumerate(items):
        lx = x + i * 250
        out.append(f'<g class="w w-{kind} legend"><path class="w-line" d="M{lx},{y} L{lx + 44},{y}"/>'
                   f'<polygon class="w-head" points="{Diagram.head((lx, y), (lx + 52, y), 4.5)}"/>'
                   f'<text class="w-label" x="{lx + 60}" y="{y + 4}">{escape(text)}</text></g>')
    d.extra.append("".join(out))


# ---------------------------------------------------------------------------------------------
# The overview: the whole store. The level blocks' table area is where the widget draws tables
# along a key axis (a .. z).
TABLE_AREA = dict(x0=650, x1=955, top=12, bottom=78)


def key_x(key):
    """A key's position on the a..z axis of the level rows (by its first two letters)."""
    k = (key + "aa")[:2]
    t = (ord(k[0]) - 97 + (ord(k[1]) - 97) / 26) / 26
    return TABLE_AREA["x0"] + max(0.0, min(1.0, t)) * (TABLE_AREA["x1"] - TABLE_AREA["x0"])


def overview():
    d = Diagram(1100, 618, "Block diagram of tiny_lsm. Write path: the client's put goes to DB, which appends it to the "
                "write-ahead log on disk and inserts it into the memtable in memory; a full memtable is flushed as a new "
                "L0 table; compaction merges L0 into L1 and each level into the next. Read path: get asks the memtable, "
                "then the L0 tables newest first, then one table in each deeper level; a scan merges the memtable and every "
                "overlapping table through a heap. Control: flushes and compactions commit the MANIFEST, which names the "
                "live tables and log. Recovery: on open, the MANIFEST is loaded and the log replayed into the memtable.",
                y0=-14)
    d.block("client", 10, 40, 110, 100, "client", "your code", kind="ext", lines=["put · delete", "get · scan"], groups="write read scan")
    d.block("db", 190, 30, 200, 120, "DB", "db.py", kind="ctl", ref="top", lines=["writes: log, then memtable", "reads: newest first"], groups="write read scan ctl rec")
    d.block("wal", 500, 30, 200, 120, "write-ahead log", "wal.py · on disk", kind="data", ref="m-wal", lines=["append-only, CRC'd", "replayed on open"], groups="write rec")
    d.block("manifest", 780, 30, 190, 120, "MANIFEST", "levels.py · on disk", kind="ctl", ref="m-levels", lines=["the live tables, per level", "and the live log"], groups="ctl rec")
    d.block("mem", 190, 220, 200, 130, "memtable", "memtable.py · in memory", kind="data", ref="m-memtable", lines=["sorted keys and a dict", "flush at memtable_bytes"], groups="write read scan rec")
    d.block("l0", 500, 210, 470, 90, "L0", kind="level", ref="m-sstable", lines=["flushed memtables,", "newest first; overlap"], groups="write read scan ctl")
    d.block("l1", 500, 335, 470, 90, "L1", kind="level", ref="m-sstable", lines=["sorted, no overlaps,", "level_base_bytes"], groups="read scan ctl")
    d.block("l2", 500, 460, 470, 90, "L2", kind="level", ref="m-sstable", lines=["sorted, no overlaps,", "× level_multiplier"], groups="read scan ctl")
    d.block("compaction", 1000, 210, 90, 340, "compact", "compaction.py", kind="ctl", ref="m-compaction",
            lines=["", "L0 full:", "L0 → L1", "", "Ln too big:", "Ln → Ln+1", "", "merge,", "drop dead", "tombstones"], groups="ctl")
    d.block("merge", 190, 420, 200, 110, "merge", "merge.py · a heap", kind="data", ref="m-merge", lines=["newest entry per key,", "in key order"], groups="scan")

    # write path (thick)
    d.wire("put", "write", [(120, 70), (190, 70)], "put(k, v)", (155, 62), groups="write")
    d.wire("append", "write", [(390, 70), (500, 70)], "① append", (445, 62), groups="write")
    d.wire("insert", "write", [(250, 150), (250, 220)], "② insert", (243, 190), anchor="end", groups="write")
    d.wire("flush", "write", [(390, 240), (500, 240)], "③ flush", (445, 232), groups="write ctl")
    d.wire("compact-0", "write", [(905, 300), (905, 335)], "compact", (913, 322), anchor="start", groups="ctl")
    d.wire("compact-1", "write", [(905, 425), (905, 460)], "compact", (913, 447), anchor="start", groups="ctl")
    # read path
    d.wire("get", "read", [(120, 112), (190, 112)], "get(k)", (155, 128), both=True, groups="read")
    d.wire("probe-mem", "read", [(330, 150), (330, 220)], "① memtable", (322, 205), anchor="end", groups="read")
    d.wire("probe-l0", "read", [(390, 265), (500, 265)], "② newest first", (445, 258), groups="read")
    d.wire("probe-l1", "read", [(625, 300), (625, 335)], "③ one table", (618, 322), anchor="end", groups="read")
    d.wire("probe-l2", "read", [(625, 425), (625, 460)], "④ one table", (618, 447), anchor="end", groups="read")
    # scan
    d.wire("scan-mem", "read", [(290, 350), (290, 420)], "scan", (298, 390), anchor="start", groups="scan")
    d.wire("scan-tables", "read", [(500, 288), (465, 288), (465, 485), (390, 485)], "every|overlapping|table", (458, 430), anchor="end", groups="scan")
    d.wire("scan-l1", "read", [(500, 400), (465, 400)], head=False, groups="scan")
    d.wire("scan-l2", "read", [(500, 520), (465, 520), (465, 485)], head=False, groups="scan")
    d.wire("scan-out", "read", [(190, 475), (65, 475), (65, 140)], "results,|in key order", (72, 300), anchor="start", groups="scan")
    # control
    d.wire("commit-flush", "ctl", [(350, 30), (350, 6), (875, 6), (875, 30)], "flush: commit the new L0 table and a new log", (612, 0), groups="ctl write")
    d.wire("commit-compact", "ctl", [(1045, 210), (1045, 90), (970, 90)], "commit", (1012, 82), groups="ctl")
    for n, y in enumerate((255, 380, 505)):
        d.wire(f"trigger-{n}", "ctl", [(970, y), (1000, y)], both=True, groups="ctl")
    # recovery
    d.wire("replay", "rec", [(600, 150), (600, 180), (360, 180), (360, 220)], "replay the live log", (480, 174), groups="rec")
    d.wire("load", "rec", [(875, 150), (875, 195), (420, 195), (420, 130), (390, 130)], "open: load the tables and the live log", (720, 189), groups="rec")
    legend(d, 120, 600, (("write", "write path: entries"), ("read", "read path: lookups and results"), ("ctl", "control: commits, triggers"), ("rec", "recovery, on open")))
    # the tables in the static picture: the state the simulation's read and scan steps start from
    for level, ranges in enumerate([[(lo, hi) for _, lo, hi, _ in tables] for tables in preload_levels()]):
        block = d.blocks[[b["id"] for b in d.blocks].index(f"l{level}")]
        rows = len(ranges) if level == 0 else 1
        h = (TABLE_AREA["bottom"] - TABLE_AREA["top"]) / rows
        for i, (lo, hi) in enumerate(ranges):
            row = i if level == 0 else 0
            x0, x1 = key_x(lo), max(key_x(hi) + 10, key_x(lo) + 6.2 * (len(lo) + len(hi) + 1) + 10)
            y = block["y"] + TABLE_AREA["top"] + row * h
            d.extra.append(f'<g class="sst-sample g-ctl g-read g-scan g-write"><rect class="sst" x="{x0:.1f}" y="{y + 2:.1f}" width="{x1 - x0:.1f}" height="{h - 4:.1f}" rx="3"/>'
                           f'<text class="sst-label" x="{(x0 + x1) / 2:.1f}" y="{y + h / 2 + 3.5:.1f}" text-anchor="middle">{lo}…{hi}</text></g>')
    for x, ch in ((TABLE_AREA["x0"], "a"), ((TABLE_AREA["x0"] + TABLE_AREA["x1"]) / 2, "n"), (TABLE_AREA["x1"], "z")):
        d.extra.append(f'<text class="w-label axis" x="{x:.0f}" y="{560 + 2}" text-anchor="middle">{ch}</text>')
    d.extra.append(f'<text class="w-label axis" x="{(TABLE_AREA["x0"] + TABLE_AREA["x1"]) / 2 - 40:.0f}" y="562" text-anchor="end">keys:</text>')
    return d


# ---------------------------------------------------------------------------------------------
# Byte layouts. A row of cells, each `bytes` wide on a common scale.
def byte_row(cells, x, y, scale, h=34, cls=""):
    """cells: (label, nbytes, kind, sub). Returns svg and the x after the row."""
    out = []
    for label, n, kind, sub in cells:
        w = max(n * scale, 30)
        out.append(f'<g class="cell cell-{kind} {cls}"><rect x="{x:.1f}" y="{y}" width="{w:.1f}" height="{h}" rx="3"/>'
                   f'<text class="cell-label" x="{x + w / 2:.1f}" y="{y + h / 2 - (2 if sub else -4):.1f}" text-anchor="middle">{escape(label)}</text>'
                   + (f'<text class="cell-sub" x="{x + w / 2:.1f}" y="{y + h / 2 + 11:.1f}" text-anchor="middle">{escape(sub)}</text>' if sub else "")
                   + "</g>")
        x += w
    return "".join(out), x


def wal_record():
    cells = [("crc32", 4, "meta", "u32"), ("length", 4, "meta", "u32"), ("kind", 1, "kind", "u8"), ("key_len", 2, "meta", "u16"),
             ("value_len", 4, "meta", "u32"), ("key", 5, "key", '"apple"'), ("value", 3, "val", '"red"')]
    row, end = byte_row(cells, 20, 40, 34)
    entry_x = 20 + 8 * 34
    brace = (f'<path class="brace" d="M20,86 L20,92 L{end:.0f},92 L{end:.0f},86"/>'
             f'<text class="w-label" x="{(20 + end) / 2:.0f}" y="106" text-anchor="middle">the CRC covers length and entry</text>'
             f'<path class="brace" d="M{entry_x},30 L{entry_x},24 L{end:.0f},24 L{end:.0f},30"/>'
             f'<text class="w-label" x="{(entry_x + end) / 2:.0f}" y="18" text-anchor="middle">entry: the same bytes an SSTable stores (encoding.py)</text>')
    return (f'<svg class="dia bytes" viewBox="0 0 {end + 20:.0f} 116" role="img" aria-label="A WAL record for put apple = red: a 4-byte CRC32, '
            f'a 4-byte length, then the entry: kind (1 byte), key length (2), value length (4), the key and the value. The CRC covers the '
            f'length and the entry.">{row}{brace}</svg>')


def real_table():
    """A small table written by the real code, with its bytes."""
    tmp = Path(tempfile.mkdtemp())
    builder = TableBuilder(tmp / "000007.sst", block_bytes=48, bits_per_key=10)
    for k, v in [("apple", "red"), ("banana", "yellow"), ("cherry", "red"), ("date", "brown"), ("fig", "purple"),
                 ("grape", "green"), ("kiwi", None), ("lemon", "yellow"), ("mango", "orange")]:
        builder.add(k.encode(), None if v is None else v.encode())
    table = builder.finish()
    data = table.path.read_bytes()
    index_offset, index_size, bloom_offset, bloom_size, count, _ = FOOTER.unpack(data[-FOOTER.size:])
    blocks = table._blocks
    first_keys = table._first_keys
    entries = [table._read_block(i) for i in range(len(blocks))]
    table.close()
    shutil.rmtree(tmp)
    return dict(size=len(data), blocks=blocks, first_keys=first_keys, entries=entries, index=(index_offset, index_size),
                bloom=(bloom_offset, bloom_size), count=count, max_key=table.max_key)


def sstable_layout():
    t = real_table()
    W = 1000
    scale = (W - 40) / t["size"]
    cells = [(f"block {i}", size, "block", f"{size} B") for i, (_, size) in enumerate(t["blocks"])]
    cells += [("index", t["index"][1], "index", f"{t['index'][1]} B"), ("bloom", t["bloom"][1], "bloom", f"{t['bloom'][1]} B"),
              ("footer", FOOTER.size, "footer", f"{FOOTER.size} B")]
    out = ['<text class="row-title" x="20" y="22">the file, to scale: '
           f'{t["size"]} bytes, {t["count"]} entries in {len(t["blocks"])} blocks</text>']
    x = 20
    xs = []
    for label, n, kind, sub in cells:
        w = n * scale
        xs.append((x, w))
        out.append(f'<g class="cell cell-{kind}"><rect x="{x:.1f}" y="32" width="{w:.1f}" height="40" rx="3"/>'
                   f'<text class="cell-label" x="{x + w / 2:.1f}" y="49" text-anchor="middle">{escape(label)}</text>'
                   f'<text class="cell-sub" x="{x + w / 2:.1f}" y="63" text-anchor="middle">{escape(sub)}</text></g>')
        x += w
    # offsets under the bar
    for (bx, _), (off, _) in zip(xs, t["blocks"]):
        out.append(f'<text class="w-label" x="{bx + 2:.1f}" y="84">{off}</text>')
    out.append(f'<text class="w-label" x="{xs[-3][0] + 2:.1f}" y="84">{t["index"][0]}</text>')
    out.append(f'<text class="w-label" x="{xs[-2][0] + 2:.1f}" y="84">{t["bloom"][0]}</text>')
    out.append(f'<text class="w-label" x="{xs[-1][0] + 2:.1f}" y="84">{t["size"] - FOOTER.size}</text>')

    # block 0, zoomed
    y = 128
    out.append(f'<text class="row-title" x="20" y="{y - 10}">block 0, byte by byte: entries, then a CRC32 of them</text>')
    cells = []
    for k, v in t["entries"][0]:
        cells.append(("h", HEADER.size, "meta", "7 B"))
        cells.append((k.decode(), len(k), "key", f"{len(k)} B"))
        if v is not None:
            cells.append((v.decode(), len(v), "val", f"{len(v)} B"))
    cells.append(("crc32", 4, "meta", "4 B"))
    bscale = (W - 40) / sum(c[1] for c in cells)
    row, _ = byte_row(cells, 20, y, bscale, h=40)
    out.append(row)
    b0x, b0w = xs[0]
    out.append(f'<path class="zoom" d="M{b0x:.1f},72 L20,{y} M{b0x + b0w:.1f},72 L{W - 20},{y}"/>')
    out.append(f'<text class="w-label" x="20" y="{y + 54}">h = kind · key_len · value_len (encoding.py). Keys are sorted; a block ends once it holds block_bytes.</text>')

    # index, zoomed
    y = 226
    out.append(f'<text class="row-title" x="20" y="{y - 10}">the index: each block\'s first key, offset and size, then the table\'s last key</text>')
    cells = [("count", 4, "meta", str(len(t["blocks"])))]
    for k, (off, size) in zip(t["first_keys"], t["blocks"]):
        cells += [(k.decode(), 2 + len(k), "key", "first key"), (f"@{off}", 8, "meta", "offset"), (f"{size}", 4, "meta", "size")]
    cells.append((t["max_key"].decode(), 2 + len(t["max_key"]), "key", "last key"))
    iscale = (W - 40) / sum(c[1] for c in cells)
    row, _ = byte_row(cells, 20, y, iscale, h=40)
    out.append(row)

    # footer, zoomed
    y = 316
    out.append(f'<text class="row-title" x="20" y="{y - 10}">the footer: a fixed 40 bytes at the end, so a reader can find everything else</text>')
    cells = [("index_offset", 8, "meta", str(t["index"][0])), ("index_size", 4, "meta", str(t["index"][1])),
             ("bloom_offset", 8, "meta", str(t["bloom"][0])), ("bloom_size", 4, "meta", str(t["bloom"][1])),
             ("entries", 8, "meta", str(t["count"])), ("magic", 8, "footer", "TINYLSM1")]
    row, _ = byte_row(cells, 20, y, (W - 40) / 40, h=40)
    out.append(row)
    label = (f"Byte layout of a real {t['size']}-byte SSTable written by tiny_lsm with {t['count']} entries: {len(t['blocks'])} data blocks, "
             f"then the index ({t['index'][1]} bytes), the bloom filter ({t['bloom'][1]} bytes) and a 40-byte footer. Block 0 holds entries, "
             "each a 7-byte header, the key and the value, then a CRC32. The index lists each block's first key, offset and size, "
             "then the table's last key. The footer holds the offsets and sizes of the index and the bloom filter, the entry count and the magic TINYLSM1.")
    return f'<svg class="dia bytes" viewBox="0 0 {W} 370" role="img" aria-label="{escape(label)}">{"".join(out)}</svg>'


# ---------------------------------------------------------------------------------------------
# The bloom filter: a small filter from the real code, three keys in, two lookups.
WORDS = ("date fig grape kiwi lemon mango nut olive pear plum quince melon lime berry apricot avocado blueberry "
         "coconut cranberry currant damson durian elderberry feijoa gooseberry guava jujube kumquat lychee mulberry "
         "nectarine papaya peach persimmon pineapple pomelo raspberry rhubarb satsuma sloe soursop tamarind tangerine "
         "watermelon yuzu almond cashew hazelnut pecan walnut").split()
def bloom_figure():
    bloom = BloomFilter(32, 3)
    keys = ["apple", "banana", "cherry"]
    for k in keys:
        bloom.add(k.encode())
    absent = [w for w in WORDS if not bloom.might_contain(w.encode())]
    fps = [w for w in WORDS if bloom.might_contain(w.encode())]
    queries = [absent[0]] + fps[:1]
    set_bits = {p for p in range(32) if bloom.bits[p // 8] >> (p % 8) & 1}
    x0, cw, y = 70, 28, 120
    out = []
    rows = [(k, bloom.positions(k.encode()), "add") for k in keys] + [(q, bloom.positions(q.encode()), "query") for q in queries]
    for p in range(32):
        cls = "bit on" if p in set_bits else "bit"
        out.append(f'<rect class="{cls}" x="{x0 + p * cw}" y="{y}" width="{cw - 3}" height="26" rx="3"/>'
                   f'<text class="bit-label" x="{x0 + p * cw + (cw - 3) / 2}" y="{y + 17}" text-anchor="middle">{1 if p in set_bits else 0}</text>'
                   f'<text class="w-label" x="{x0 + p * cw + (cw - 3) / 2}" y="{y + 40}" text-anchor="middle">{p}</text>')
    for i, (k, ps, kind) in enumerate(rows):
        ry = 20 + i * 18 if kind == "add" else 196 + (i - len(keys)) * 18
        label = f"add {k}" if kind == "add" else f"{k}?"
        out.append(f'<text class="w-label key-{kind}" x="{x0 - 8}" y="{ry + 4}" text-anchor="end">{label}</text>')
        for p in ps:
            px = x0 + p * cw + (cw - 3) / 2
            ok = p in set_bits
            cls = f"probe probe-{kind}" + ("" if kind == "add" or ok else " probe-miss")
            if kind == "add":
                out.append(f'<path class="{cls}" d="M{px},{ry + 6} L{px},{y - 2}"/><circle class="dot-{kind}" cx="{px}" cy="{ry}" r="3.5"/>')
            else:
                out.append(f'<path class="{cls}" d="M{px},{ry - 6} L{px},{y + 28}"/><circle class="dot-{kind}{"" if ok else " dot-miss"}" cx="{px}" cy="{ry}" r="3.5"/>')
        if kind == "query":
            verdict = "maybe: all 3 bits set (a false positive)" if all(p in set_bits for p in ps) else "no: a bit is 0, so it was never added"
            out.append(f'<text class="w-label verdict" x="{x0 + 32 * cw + 6}" y="{ry + 4}">{verdict}</text>')
    label = (f"A 32-bit bloom filter with 3 hashes, from bloom.py. Adding {', '.join(keys)} sets bits {', '.join(map(str, sorted(set_bits)))}. "
             f"Looking up {queries[0]} finds a 0 among its bits {', '.join(map(str, rows[3][1]))}: definitely absent. "
             + (f"Looking up {queries[1]} finds all its bits {', '.join(map(str, rows[4][1]))} set: maybe present, a false positive." if len(queries) > 1 else ""))
    return f'<svg class="dia bloomfig" viewBox="0 0 {x0 + 32 * cw + 230} {196 + 2 * 18 + 6}" role="img" aria-label="{escape(label)}">{"".join(out)}</svg>'


# ---------------------------------------------------------------------------------------------
# Compaction: the levels before and after a real L0 -> L1 compaction (the simulation's workload).
SIM_OPTS = Options(memtable_bytes=48, block_bytes=32, table_bytes=64, l0_limit=3, level_base_bytes=320, level_multiplier=4, num_levels=3)


def sim_workload():
    def puts(words, v):
        return [("put", w, v) for w in words.split()]
    return (puts("apple fig kiwi date", "1") + puts("banana grape lemon cherry", "1") + puts("mango fig nut lemon", "2")
            + [("del", "kiwi", None)] + puts("pear apple quince", "3") + puts("date plum apple berry", "4") + puts("cherry nut", "5")
            + puts("melon lime", "6"))


def levels_snapshot(db):
    return [[(int(t.path.stem), t.min_key.decode(), t.max_key.decode(),
              [(k.decode(), None if v is None else v.decode()) for k, v in t.items()]) for t in level] for level in db._levels.levels]


def preload_levels():
    """The levels after the simulation's PRELOAD (its workload without the last two puts), from the real code."""
    with tempfile.TemporaryDirectory() as tmp, DB(tmp, SIM_OPTS) as db:
        for op, k, v in sim_workload()[:-2]:
            db.put(k.encode(), v.encode()) if op == "put" else db.delete(k.encode())
        return levels_snapshot(db)


def compaction_figure():
    """Runs the workload up to just before the last flush, then flushes with compaction off, and on."""
    snaps = {}
    with tempfile.TemporaryDirectory() as tmp:
        ops = sim_workload()
        with DB(tmp, SIM_OPTS) as db:
            for op, k, v in ops[:-1]:
                db.put(k.encode(), v.encode()) if op == "put" else db.delete(k.encode())
            # the last put fills the memtable: flush without compacting, to draw the "before" picture
            settle = db._compactor.compact_until_settled
            db._compactor.compact_until_settled = lambda: None
            op, k, v = ops[-1]
            db.put(k.encode(), v.encode())
            snaps["before"] = levels_snapshot(db)
            c = db._compactor.pick()
            snaps["picked"] = (c.level, [int(t.path.stem) for t in c.inputs + c.overlaps])
            db._compactor.run(c)
            snaps["after"] = levels_snapshot(db)
            db._compactor.compact_until_settled = settle
    W, ax0, ax1 = 1000, 120, 980

    def x(key):
        k = (key + "aa")[:2]
        return ax0 + ((ord(k[0]) - 97 + (ord(k[1]) - 97) / 26) / 26) * (ax1 - ax0)

    out = []
    picked = set(snaps["picked"][1])
    y = 30
    for name, title in (("before", "before: L0 is full (3 tables)"), ("after", "after: L0 → L1, in one manifest commit")):
        out.append(f'<text class="row-title" x="20" y="{y - 8}">{title}</text>')
        for n, level in enumerate(snaps[name]):
            rows = max(1, len(level)) if n == 0 else 1
            rh = 22
            h = rows * rh + 8
            out.append(f'<rect class="lvl-band" x="20" y="{y}" width="{W - 40}" height="{h}" rx="4"/>'
                       f'<text class="blk-title" x="34" y="{y + h / 2 + 5}">L{n}</text>')
            for i, (num, lo, hi, entries) in enumerate(level):
                row = i if n == 0 else 0
                nxt = level[i + 1][1] if n > 0 and i + 1 < len(level) else None
                x0 = x(lo)
                x1 = max(x(hi) + 12, x0 + 6.4 * (len(lo) + len(hi) + 1) + 14)
                if nxt is not None:
                    x1 = min(x1, x(nxt) - 4)
                ty = y + 4 + row * rh
                cls = "sst in" if name == "before" and num in picked else "sst out" if name == "after" and n == 1 and num not in {t for t in picked} else "sst"
                tomb = [k for k, v in entries if v is None]
                out.append(f'<rect class="{cls}" x="{x0:.1f}" y="{ty}" width="{x1 - x0:.1f}" height="{rh - 4}" rx="3"/>'
                           f'<text class="sst-label" x="{(x0 + x1) / 2:.1f}" y="{ty + 13}" text-anchor="middle"><title>{num:06d}.sst</title>{lo}…{hi}{" ✝" + ",".join(tomb) if tomb else ""}</text>')
            y += h + 6
        y += 26
    for key in "acegikmoqsuwy":
        out.append(f'<text class="w-label axis" x="{x(key):.0f}" y="{y - 14}" text-anchor="middle">{key}</text>')
    b, a = snaps["before"], snaps["after"]
    label = ("Levels before and after a real L0 to L1 compaction. Before: L0 holds three overlapping tables, "
             + ", ".join(f"{lo} to {hi}" for _, lo, hi, _ in b[0]) + "; L1 holds " + ", ".join(f"{lo} to {hi}" for _, lo, hi, _ in b[1])
             + ". The L0 tables and the L1 tables they overlap are merged. After: L0 is empty and L1 holds "
             + ", ".join(f"{lo} to {hi}" for _, lo, hi, _ in a[1]) + ", sorted and not overlapping. kiwi's tombstone is gone: nothing below could hold kiwi.")
    return f'<svg class="dia compfig" viewBox="0 0 {W} {y}" role="img" aria-label="{escape(label)}">{"".join(out)}</svg>', snaps


# ---------------------------------------------------------------------------------------------
# The merge iterator, step by step: real sources, a real heap. One SVG per step for a CSS stepper.
MERGE_SOURCES = [
    ("memtable", [("cherry", "5"), ("kiwi", None)]),
    ("L0 · 000013", [("apple", "4"), ("date", "4"), ("plum", "4")]),
    ("L1 · 000009", [("cherry", "1"), ("date", "1"), ("kiwi", "1"), ("lemon", "2")]),
]


def merge_steps():
    """Replays merge.merge's loop, recording the heap before each pop."""
    its = [iter(s) for _, s in MERGE_SOURCES]
    heap = []
    for rank, it in enumerate(its):
        e = next(it, None)
        if e:
            heapq.heappush(heap, (e[0], rank, e[1]))
    steps = []
    out = []
    while heap:
        before = sorted(heap)
        key, rank, value = heapq.heappop(heap)
        e = next(its[rank], None)
        if e:
            heapq.heappush(heap, (e[0], rank, e[1]))
        shadowed = []
        while heap and heap[0][0] == key:
            _, r, v = heapq.heappop(heap)
            shadowed.append((r, v))
            e = next(its[r], None)
            if e:
                heapq.heappush(heap, (e[0], r, e[1]))
        if value is not None:
            out.append((key, value))
        steps.append(dict(heap=before, pop=(key, rank, value), shadowed=shadowed, out=list(out)))
    return steps


def merge_step_svg(i, steps):
    s = steps[i]
    consumed = {}  # how many entries of each source were taken before this step
    for st in steps[:i]:
        k, r, _ = st["pop"]
        consumed[r] = consumed.get(r, 0) + 1
        for r2, _ in st["shadowed"]:
            consumed[r2] = consumed.get(r2, 0) + 1
    out = []
    W = 760
    for rank, (name, entries) in enumerate(MERGE_SOURCES):
        y = 20 + rank * 36
        out.append(f'<text class="w-label" x="128" y="{y + 17}" text-anchor="end">{rank} · {escape(name)}</text>')
        for j, (k, v) in enumerate(entries):
            done = j < consumed.get(rank, 0)
            head = j == consumed.get(rank, 0)
            popped = head and (rank == s["pop"][1] or rank in [r for r, _ in s["shadowed"]])
            cls = "ent done" if done else "ent head pop" if popped and rank == s["pop"][1] else "ent head shadow" if popped else "ent head" if head else "ent"
            label = f"{k}={v}" if v is not None else f"{k} ✝"
            out.append(f'<g class="{cls}"><rect x="{140 + j * 92}" y="{y}" width="86" height="26" rx="4"/>'
                       f'<text x="{140 + j * 92 + 43}" y="{y + 17}" text-anchor="middle">{escape(label)}</text></g>')
    hx = 460
    out.append(f'<text class="row-title" x="{hx}" y="16">heap: (key, source)</text>')
    for j, (k, r, v) in enumerate(s["heap"]):
        cls = "hp top" if j == 0 else "hp"
        out.append(f'<g class="{cls}"><rect x="{hx}" y="{24 + j * 22}" width="150" height="18" rx="3"/>'
                   f'<text x="{hx + 8}" y="{24 + j * 22 + 13}">({escape(k)}, {r})</text></g>')
    k, r, v = s["pop"]
    what = f"pop ({k}, {r}): " + (f"yield {k}={v}" if v is not None else "a tombstone: the scan skips it")
    if s["shadowed"]:
        what += f"; ({k}, {', '.join(str(x) for x, _ in s['shadowed'])}) is older: skipped"
    out.append(f'<text class="verdict-line" x="20" y="138">{escape(what)}</text>')
    res = ", ".join(f"{a}={b}" for a, b in s["out"]) or "nothing yet"
    out.append(f'<text class="w-label" x="20" y="158">out so far: {escape(res)}</text>')
    label = f"Merge step {i + 1}: the heap holds " + ", ".join(f"{k} from source {r}" for k, r, _ in s["heap"]) + f". {what}. Output so far: {res}."
    return f'<svg class="dia mergefig" viewBox="0 0 {W} 168" role="img" aria-label="{escape(label)}">{"".join(out)}</svg>'


# ---------------------------------------------------------------------------------------------
# lines.json: which line each simulation step highlights, relative to the anchor it's shown in.
LINES = {
    "lsm-overview": {
        "write": ("tiny_lsm/db.py", {
            "w-append": r"self\._wal\.append\(key, value\)", "w-insert": r"self\._mem\.put\(key, value\)  # then visible",
            "w-check": r"if self\._mem\.size >= ", "f-write": r"table = write_table\(",
            "f-commit": (r"levels\[0\]\.insert", 3), "f-newlog": (r"self\._wal = wal\.WriteAheadLog\(self\._levels", 3),
            "f-compact": (r"self\._mem = Memtable\(\)$", 2),
        }),
        "read": ("tiny_lsm/db.py", {
            "g-mem": r"found = self\._mem\.get\(key\)", "g-mem-hit": (r"if found is not MISSING:", 2),
            "g-tables": r"for table in self\._levels\.tables_for_key", "g-table": r"found = table\.get\(key\)",
            "g-hit": (r"            if found is not MISSING:", 2), "g-none": r"        return None$",
        }),
        "scan": ("tiny_lsm/db.py", {"s-mem": r"sources = \[self\._mem\.items", "s-tables": r"sources \+= ", "s-merge": r"return live\(merge"}),
        "compaction": ("tiny_lsm/compaction.py", {
            "c-pick0": (r"if len\(levels\[0\]\) >= ", 4), "c-pickn": (r"if self\.levels\.level_bytes\(n\) > ", 5),
            "c-merge": (r"for key, value in merge\(", 11), "c-commit": (r"# Swap inputs for outputs", 8),
        }),
    },
    "lsm-bloom": {
        "bl-play": ("tiny_lsm/bloom.py", {"positions": (r"def positions", 4), "add": (r"def add", 3), "query": (r"def might_contain", 2)}),
    },
    "lsm-compaction": {
        "live": ("tiny_lsm/compaction.py", {
            "c-pick0": (r"if len\(levels\[0\]\) >= ", 4), "c-pickn": (r"if self\.levels\.level_bytes\(n\) > ", 5),
            "c-merge": (r"for key, value in merge\(", 11), "c-commit": (r"# Swap inputs for outputs", 8),
        }),
    },
}


def anchor_start(folder, anchor, path):
    """The anchor's first line in the file: from its pinned quote if it has one, else its range."""
    manifest = json.loads((SIDESTORY / folder / "manifest.json").read_text())
    a = manifest["anchors"][anchor]
    text = (ROOT / path).read_text()
    quote = a.get("quote", {}).get("exact")
    if quote and text.count(quote) == 1:
        return text[: text.index(quote)].count("\n") + 1
    return a["range"][0]


def lines_json(folder):
    out = {}
    for anchor, (path, keys) in LINES[folder].items():
        lines = (ROOT / path).read_text().split("\n")
        start = anchor_start(folder, anchor, path)
        out[anchor] = {}
        for key, spec in keys.items():
            pattern, count = spec if isinstance(spec, tuple) else (spec, 1)
            hits = [i + 1 for i, line in enumerate(lines) if re.search(pattern, line)]
            hits = [h for h in hits if h >= start]
            if not hits:
                raise SystemExit(f"{path}: no line matches {pattern!r} for {anchor}.{key}")
            first = hits[0] - start + 1
            out[anchor][key] = first if count == 1 else [first, first + count - 1]
    (SIDESTORY / folder / "widgets" / "lines.json").write_text(json.dumps(out, indent=1) + "\n")


# ---------------------------------------------------------------------------------------------
DIA_CSS = """
  .dia { display: block; width: 100%; height: auto; font-family: var(--vscode-editor-font-family); overflow: visible; }
  .dia text { fill: var(--vscode-editor-foreground); }
  .dia.bytes, .dia.mergefig, .dia.memfig { max-width: 820px; }
  .dia.bloomfig, .dia.compfig { max-width: 1000px; }
  .dia .w-line { fill: none; stroke-linejoin: round; }
  .dia .w-write .w-line { stroke: var(--vscode-charts-blue); stroke-width: 5; }
  .dia .w-write .w-head { fill: var(--vscode-charts-blue); }
  .dia .w-read .w-line { stroke: var(--vscode-charts-green); stroke-width: 2.5; }
  .dia .w-read .w-head { fill: var(--vscode-charts-green); }
  .dia .w-ctl .w-line { stroke: var(--vscode-charts-orange); stroke-width: 1.5; stroke-dasharray: 5 4; }
  .dia .w-ctl .w-head { fill: var(--vscode-charts-orange); }
  .dia .w-rec .w-line { stroke: var(--vscode-charts-red); stroke-width: 1.5; stroke-dasharray: 2 3; }
  .dia .w-rec .w-head { fill: var(--vscode-charts-red); }
  .dia text.w-label { font-size: 10.5px; fill: var(--vscode-descriptionForeground); }
  .dia .blk-box { fill: var(--vscode-editorWidget-background, var(--vscode-editor-background)); stroke: var(--vscode-editorWidget-border, var(--vscode-panel-border)); stroke-width: 1.2; }
  .dia .blk-data .blk-bar { fill: var(--vscode-charts-blue); }
  .dia .blk-ctl .blk-bar { fill: var(--vscode-charts-orange); }
  .dia .blk-level .blk-box { stroke: var(--vscode-charts-blue); stroke-width: 1.2; }
  .dia .blk-ext .blk-box { fill: none; stroke: var(--vscode-descriptionForeground); stroke-dasharray: 3 3; }
  .dia text.blk-title { font-weight: 600; font-size: 13px; }
  .dia text.lvl-title { font-size: 20px; }
  .dia text.blk-sub, .dia text.blk-line { font-size: 10.5px; fill: var(--vscode-descriptionForeground); }
  .dia [data-explain-ref] { cursor: pointer; text-decoration: none; }
  .dia [data-explain-ref]:hover .blk-box, .dia [data-explain-ref]:focus-visible .blk-box { stroke: var(--vscode-focusBorder); stroke-width: 2.5; }
  .dia [data-explain-ref]:focus-visible { outline: none; }
  .dia .sst { fill: color-mix(in srgb, var(--vscode-charts-blue) 18%, transparent); stroke: var(--vscode-charts-blue); stroke-width: 1; }
  .dia .sst.in { stroke: var(--vscode-charts-orange); stroke-width: 2.5; }
  .dia .sst.out { stroke: var(--vscode-charts-green); stroke-width: 2.5; }
  .dia text.sst-label { font-size: 10px; }
  .dia text.row-title { font-size: 11.5px; font-weight: 600; }
  .dia .lvl-band { fill: none; stroke: var(--vscode-panel-border); }
  .dia .cell rect { fill: var(--vscode-editorWidget-background, var(--vscode-editor-background)); stroke: var(--vscode-panel-border); }
  .dia .cell-key rect { fill: color-mix(in srgb, var(--vscode-charts-blue) 22%, transparent); stroke: var(--vscode-charts-blue); }
  .dia .cell-val rect { fill: color-mix(in srgb, var(--vscode-charts-green) 22%, transparent); stroke: var(--vscode-charts-green); }
  .dia .cell-kind rect, .dia .cell-footer rect { fill: color-mix(in srgb, var(--vscode-charts-orange) 22%, transparent); stroke: var(--vscode-charts-orange); }
  .dia .cell-block rect { fill: color-mix(in srgb, var(--vscode-charts-blue) 22%, transparent); stroke: var(--vscode-charts-blue); }
  .dia .cell-index rect { fill: color-mix(in srgb, var(--vscode-charts-purple) 22%, transparent); stroke: var(--vscode-charts-purple); }
  .dia .cell-bloom rect { fill: color-mix(in srgb, var(--vscode-charts-green) 22%, transparent); stroke: var(--vscode-charts-green); }
  .dia text.cell-label { font-size: 11px; }
  .dia text.cell-sub { font-size: 9.5px; fill: var(--vscode-descriptionForeground); }
  .dia .zoom, .dia .brace { fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 1; stroke-dasharray: 3 3; }
  .dia .brace { stroke-dasharray: none; }
  .dia .bit { fill: none; stroke: var(--vscode-panel-border); stroke-width: 1.2; }
  .dia .bit.on { fill: color-mix(in srgb, var(--vscode-charts-blue) 35%, transparent); stroke: var(--vscode-charts-blue); }
  .dia text.bit-label { font-size: 11px; }
  .dia .probe { stroke: var(--vscode-charts-blue); stroke-width: 1; fill: none; }
  .dia .probe-query { stroke: var(--vscode-charts-green); stroke-dasharray: 3 2; }
  .dia .probe-miss { stroke: var(--vscode-charts-red); }
  .dia .dot-add { fill: var(--vscode-charts-blue); }
  .dia .dot-query { fill: var(--vscode-charts-green); }
  .dia .dot-miss { fill: var(--vscode-charts-red); }
  .dia .ent rect { fill: var(--vscode-editorWidget-background, var(--vscode-editor-background)); stroke: var(--vscode-panel-border); }
  .dia .ent text, .dia .hp text { font-size: 11px; }
  .dia .ent.done { opacity: .35; }
  .dia .ent.head rect { stroke: var(--vscode-charts-green); stroke-width: 1.5; }
  .dia .ent.pop rect { fill: color-mix(in srgb, var(--vscode-charts-green) 30%, transparent); stroke-width: 2.5; }
  .dia .ent.shadow rect { stroke: var(--vscode-charts-red); stroke-dasharray: 3 2; }
  .dia .hp rect { fill: none; stroke: var(--vscode-panel-border); }
  .dia .hp.top rect { stroke: var(--vscode-charts-green); stroke-width: 2; }
  .dia text.verdict-line { font-size: 12px; font-weight: 600; }
  /* one path in focus: the rest fades */
  .focus-write .dia .w:not(.legend):not(.g-write), .focus-read .dia .w:not(.legend):not(.g-read),
  .focus-scan .dia .w:not(.legend):not(.g-scan), .focus-ctl .dia .w:not(.legend):not(.g-ctl),
  .focus-rec .dia .w:not(.legend):not(.g-rec) { opacity: .15; }
  .focus-write .dia .blk:not(.g-write), .focus-read .dia .blk:not(.g-read), .focus-scan .dia .blk:not(.g-scan),
  .focus-ctl .dia .blk:not(.g-ctl), .focus-rec .dia .blk:not(.g-rec), .focus-rec .dia .sst-sample { opacity: .4; }
  .focus-write .dia .g-write .w-line, .focus-read .dia .g-read .w-line, .focus-scan .dia .g-scan .w-line,
  .focus-ctl .dia .g-ctl.w-ctl .w-line, .focus-rec .dia .g-rec .w-line { stroke-width: 3; }
  .focus-write .dia .g-write.w-write .w-line { stroke-width: 6; }
  @media (forced-colors: active) { .dia .w-ctl .w-line, .dia .w-rec .w-line { stroke-dasharray: 5 4; } }
"""


def splice_css(path):
    text = path.read_text()
    pat = re.compile(r"(/\* dia-css \*/)(.*?)(/\* /dia-css \*/)", re.S)
    if pat.search(text):
        path.write_text(pat.sub(lambda m: m.group(1) + DIA_CSS + "  " + m.group(3), text))


def splice(path, name, svg):
    text = path.read_text()
    pat = re.compile(rf"(<!-- diagram:{name} -->)(.*?)(<!-- /diagram:{name} -->)", re.S)
    if not pat.search(text):
        raise SystemExit(f"{path}: no diagram:{name} markers")
    path.write_text(pat.sub(lambda m: m.group(1) + "\n" + svg + "\n" + m.group(3), text))


def main():
    ov = overview()
    (SIDESTORY / "lsm-overview" / "widgets" / "layout.json").write_text(json.dumps(ov.layout(), separators=(",", ":")) + "\n")
    # The compaction visualizer runs the same model as the simulation: one source, copied (widgets can't import across sidestories).
    shutil.copyfile(SIDESTORY / "lsm-overview" / "widgets" / "model.ts", SIDESTORY / "lsm-compaction" / "widgets" / "model.ts")
    for folder in LINES:
        if (SIDESTORY / folder / "manifest.json").exists():
            lines_json(folder)
    pages = {p.parent.name: p for p in SIDESTORY.glob("*/sidestory.html")}
    for page in pages.values():
        splice_css(page)
    if "lsm-overview" in pages:
        for name in ("overview", "write", "read", "scan", "compaction", "recovery"):
            if f"<!-- diagram:{name} -->" in pages["lsm-overview"].read_text():
                splice(pages["lsm-overview"], name, ov.svg())
    figs = {"lsm-wal": {"record": wal_record}, "lsm-sstable": {"layout": sstable_layout}, "lsm-bloom": {"bits": bloom_figure},
            "lsm-compaction": {"levels": lambda: compaction_figure()[0]}}
    for folder, items in figs.items():
        if folder in pages:
            for name, fn in items.items():
                if f"<!-- diagram:{name} -->" in pages[folder].read_text():
                    splice(pages[folder], name, fn())
    if "lsm-merge" in pages:
        steps = merge_steps()
        for i in range(len(steps)):
            if f"<!-- diagram:merge-{i} -->" in pages["lsm-merge"].read_text():
                splice(pages["lsm-merge"], f"merge-{i}", merge_step_svg(i, steps))


if __name__ == "__main__":
    main()
