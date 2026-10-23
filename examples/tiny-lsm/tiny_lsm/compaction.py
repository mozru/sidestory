"""Leveled compaction: merging tables down to keep every level under its limit.

    L0 -> L1   when L0 has l0_limit tables: all of L0, plus the L1 tables they overlap.
    Ln -> Ln+1 when Ln holds more than its byte limit: one table of Ln (taken in
               turn, round robin through the key space), plus the Ln+1 tables it overlaps.

The inputs are merged (newest entry per key wins) into new tables of about
table_bytes each, which replace all the inputs in one manifest commit. A tombstone
is kept while an older value of its key might still lie in a deeper level, and
dropped once nothing below can hold the key: there is nothing left for it to hide.
"""
from dataclasses import dataclass

from .levels import Levels
from .merge import merge
from .options import Options
from .sstable import SSTable, TableBuilder


@dataclass
class Compaction:
    level: int  # inputs come from this level and the next
    inputs: list[SSTable]  # from level, newest first
    overlaps: list[SSTable]  # from level + 1, which receives the output


class Compactor:
    def __init__(self, levels: Levels, opts: Options) -> None:
        self.levels = levels
        self.opts = opts
        self.next_key: dict[int, bytes] = {}  # round robin: where each level's next compaction starts
        self.bytes_written = 0

    def compact_until_settled(self) -> None:
        while (c := self.pick()) is not None:
            self.run(c)

    def compact_all(self) -> None:
        """Merges each level, whole, into the next: everything ends up in the bottom level."""
        for n in range(len(self.levels.levels) - 1):
            if tables := list(self.levels.levels[n]):
                lo, hi = min(t.min_key for t in tables), max(t.max_key for t in tables)
                self.run(Compaction(n, tables, self.levels.overlapping(n + 1, lo, hi)))

    def pick(self) -> Compaction | None:
        levels = self.levels.levels
        if len(levels[0]) >= self.opts.l0_limit:
            inputs = list(levels[0])
            lo, hi = min(t.min_key for t in inputs), max(t.max_key for t in inputs)
            return Compaction(0, inputs, self.levels.overlapping(1, lo, hi))
        for n in range(1, len(levels) - 1):
            if self.levels.level_bytes(n) > self.opts.level_limit(n):
                start = self.next_key.get(n, b"")
                table = next((t for t in levels[n] if t.min_key >= start), levels[n][0])
                self.next_key[n] = table.max_key + b"\0"  # just past it
                return Compaction(n, [table], self.levels.overlapping(n + 1, table.min_key, table.max_key))
        return None

    def run(self, c: Compaction) -> None:
        out = c.level + 1
        outputs: list[SSTable] = []
        builder: TableBuilder | None = None
        for key, value in merge(t.items() for t in c.inputs + c.overlaps):  # newest first
            if value is None and not self._deeper_may_hold(out, key):
                continue  # a tombstone with nothing left to hide
            if builder is None:
                builder = TableBuilder(self.levels.table_path(), self.opts.block_bytes, self.opts.bloom_bits_per_key)
            builder.add(key, value)
            if builder.size >= self.opts.table_bytes:
                outputs.append(builder.finish())
                builder = None
        if builder is not None:
            outputs.append(builder.finish())
        self.bytes_written += sum(t.size for t in outputs)

        # Swap inputs for outputs in one commit; until it lands, the old tables are the database.
        levels = self.levels.levels
        levels[c.level] = [t for t in levels[c.level] if t not in c.inputs]
        kept = [t for t in levels[out] if t not in c.overlaps]
        levels[out] = sorted(kept + outputs, key=lambda t: t.min_key)
        self.levels.commit()
        for table in c.inputs + c.overlaps:
            table.path.unlink()  # a scan still reading it keeps its open file (POSIX)

    def _deeper_may_hold(self, level: int, key: bytes) -> bool:
        return any(t.min_key <= key <= t.max_key for deeper in self.levels.levels[level + 1 :] for t in deeper)
