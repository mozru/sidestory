"""The levels of SSTables, and the manifest that names them.

L0 holds flushed memtables, newest first; their key ranges overlap. Each deeper
level is sorted by key and its tables don't overlap, so at most one table per
level can hold a given key. Of two entries for one key, the shallower is newer.

The manifest (a small JSON file, replaced atomically) is the single source of
truth: a table belongs to the database once the manifest names it, and a table
file it doesn't name is debris from a crash, deleted on open. It also names the
live write-ahead log, so recovery knows which log still holds unflushed writes;
older logs are deleted on open too.
"""
import json
import os
from bisect import bisect_right
from collections.abc import Iterator
from pathlib import Path

from .sstable import SSTable

MANIFEST = "MANIFEST"


class Levels:
    def __init__(self, directory: Path, num_levels: int) -> None:
        self.dir = directory
        self.levels: list[list[SSTable]] = [[] for _ in range(num_levels)]
        self.next_number = 1  # file numbers: tables and logs share one sequence
        self.log_number = 0  # the live write-ahead log

    @classmethod
    def load(cls, directory: Path, num_levels: int) -> "Levels":
        levels = cls(directory, num_levels)
        path = directory / MANIFEST
        if path.exists():
            state = json.loads(path.read_text())
            levels.next_number, levels.log_number = state["next_number"], state["log_number"]
            for n, names in enumerate(state["levels"]):
                levels.levels[n] = [SSTable(directory / name) for name in names]
        else:
            levels.log_number = levels.new_number()
            levels.commit()
        levels._delete_debris()
        return levels

    def _delete_debris(self) -> None:
        named = {table.path.name for level in self.levels for table in level}
        for path in self.dir.iterdir():
            if path.suffix == ".sst" and path.name not in named:
                path.unlink()  # written by a flush or compaction that never committed
            elif path.suffix == ".log" and path.stem.isdigit() and int(path.stem) < self.log_number:
                path.unlink()  # already flushed to a table

    def new_number(self) -> int:
        self.next_number += 1
        return self.next_number - 1

    def table_path(self) -> Path:
        return self.dir / f"{self.new_number():06d}.sst"

    def log_path(self) -> Path:
        return self.dir / f"{self.log_number:06d}.log"

    def commit(self) -> None:
        """Writes the manifest to a temporary file and renames it over the old one: all or nothing."""
        state = {
            "next_number": self.next_number,
            "log_number": self.log_number,
            "levels": [[table.path.name for table in level] for level in self.levels],
        }
        tmp = self.dir / (MANIFEST + ".tmp")
        with open(tmp, "w") as f:
            json.dump(state, f, indent=1)
            f.flush()
            os.fsync(f.fileno())
        sync_dir(self.dir)  # the new tables' names reach the disk before the manifest names them
        os.replace(tmp, self.dir / MANIFEST)
        sync_dir(self.dir)

    # ---- finding tables

    def tables_for_key(self, key: bytes) -> Iterator[SSTable]:
        """The tables that may hold key, newest first: every L0 table, then at most one per level."""
        yield from self.levels[0]
        for level in self.levels[1:]:
            i = bisect_right([t.min_key for t in level], key) - 1  # (a real store would keep this list)
            if i >= 0 and key <= level[i].max_key:
                yield level[i]

    def tables_for_range(self, start: bytes | None, end: bytes | None) -> list[SSTable]:
        """The tables that overlap start <= key < end, newest first."""
        return [t for level in self.levels for t in level if overlaps(t, start, end)]

    def overlapping(self, n: int, lo: bytes, hi: bytes) -> list[SSTable]:
        """The tables of level n whose keys overlap lo..hi (inclusive)."""
        return [t for t in self.levels[n] if t.min_key <= hi and lo <= t.max_key]

    def level_bytes(self, n: int) -> int:
        return sum(t.size for t in self.levels[n])

    def close(self) -> None:
        for level in self.levels:
            for table in level:
                table.close()


def overlaps(table: SSTable, start: bytes | None, end: bytes | None) -> bool:
    return (end is None or table.min_key < end) and (start is None or table.max_key >= start)


def sync_dir(directory: Path) -> None:
    """Makes a rename or a new file in the directory durable (POSIX; a no-op where unsupported)."""
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
