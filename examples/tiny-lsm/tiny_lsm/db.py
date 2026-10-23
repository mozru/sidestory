"""tiny_lsm: a log-structured merge-tree key-value store.

Writes are cheap because they never update anything in place:

    put/delete -> append to the write-ahead log -> insert into the memtable
               -> (memtable full) flush it as a new L0 SSTable
               -> (a level too big) compact it into the next level down

Reads pay for that: the newest value of a key can be in the memtable or in any
level, so a lookup checks them newest first and stops at the first hit:

    get  -> memtable -> L0 tables, newest first -> one table per deeper level
    scan -> merge the memtable and every overlapping table, newest entry per key
"""
from collections.abc import Iterator
from pathlib import Path
from typing import Self

from . import wal
from .compaction import Compactor
from .encoding import MISSING, Value
from .levels import Levels
from .memtable import Memtable
from .merge import live, merge
from .options import Options
from .sstable import write_table


class DB:
    def __init__(self, path: str | Path, opts: Options = Options()) -> None:
        self.dir = Path(path)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.opts = opts
        self._levels = Levels.load(self.dir, opts.num_levels)
        self._compactor = Compactor(self._levels, opts)
        self._mem = Memtable()
        self.flushed_bytes = 0
        self.torn_bytes = 0
        # Recovery: the live log holds every write since the last flush. Replay it into the memtable.
        log = self._levels.log_path()
        if log.exists():
            entries, self.torn_bytes = wal.replay(log)
            for key, value in entries:
                self._mem.put(key, value)
        self._wal = wal.WriteAheadLog(log, sync=opts.sync)

    # ---- the write path

    def put(self, key: bytes, value: bytes) -> None:
        self._write(key, value)

    def delete(self, key: bytes) -> None:
        self._write(key, None)  # a tombstone: older values of key may still be in the tables

    def _write(self, key: bytes, value: Value) -> None:
        self._wal.append(key, value)  # durable first,
        self._mem.put(key, value)  # then visible
        if self._mem.size >= self.opts.memtable_bytes:
            self.flush()

    def flush(self) -> None:
        """Writes the memtable as a new L0 table, then starts an empty memtable and log."""
        if not len(self._mem):
            return
        table = write_table(self._levels.table_path(), self._mem.items(), self.opts.block_bytes, self.opts.bloom_bits_per_key)
        self.flushed_bytes += table.size
        old_log = self._wal
        self._levels.levels[0].insert(0, table)  # newest first
        self._levels.log_number = self._levels.new_number()
        self._levels.commit()  # the table is in, and the old log is no longer needed
        self._wal = wal.WriteAheadLog(self._levels.log_path(), sync=self.opts.sync)
        old_log.close()
        old_log.path.unlink()
        self._mem = Memtable()
        self._compactor.compact_until_settled()

    # ---- the read path

    def get(self, key: bytes) -> bytes | None:
        """The newest value of key, or None if it was never written or was deleted."""
        found = self._mem.get(key)
        if found is not MISSING:
            return found  # bytes, or None for a tombstone
        for table in self._levels.tables_for_key(key):  # newest first
            found = table.get(key)  # the bloom filter skips most tables without a disk read
            if found is not MISSING:
                return found
        return None

    def scan(self, start: bytes | None = None, end: bytes | None = None) -> Iterator[tuple[bytes, bytes]]:
        """Live (key, value) pairs with start <= key < end, in key order, as of now."""
        sources = [self._mem.items(start, end)]  # newest
        sources += [t.items(start, end) for t in self._levels.tables_for_range(start, end)]
        return live(merge(sources))

    # ---- housekeeping

    def compact(self) -> None:
        """Flushes, then merges every level all the way down (for tests and the CLI)."""
        self.flush()
        self._compactor.compact_all()

    def stats(self) -> dict[str, str]:
        written = self.flushed_bytes + self._compactor.bytes_written
        return {
            "memtable": f"{len(self._mem)} entries, {self._mem.size} bytes",
            **{f"L{n}": f"{len(level)} tables, {self._levels.level_bytes(n)} bytes" for n, level in enumerate(self._levels.levels)},
            "table bytes written per byte flushed": f"{written / self.flushed_bytes:.1f}" if self.flushed_bytes else "-",
        }

    def close(self) -> None:
        self._wal.close()
        self._levels.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
