"""The memtable: the newest writes, sorted by key, in memory.

A dict answers point lookups; a list of its keys, kept sorted with bisect.insort,
gives the key order that a flush and a scan need. A delete is stored as None (a
tombstone): the memtable is newer than every SSTable, so it must be able to say
"this key is gone" and not just "I don't know this key".
"""
import bisect

from .encoding import HEADER, MISSING, Item, Missing, Value


class Memtable:
    def __init__(self) -> None:
        self._values: dict[bytes, Value] = {}
        self._keys: list[bytes] = []  # the dict's keys, sorted
        self.size = 0  # bytes these entries take once encoded: the flush trigger

    def __len__(self) -> int:
        return len(self._keys)

    def put(self, key: bytes, value: Value) -> None:
        if key in self._values:
            self.size -= len(self._values[key] or b"")
        else:
            bisect.insort(self._keys, key)
            self.size += HEADER.size + len(key)
        self._values[key] = value
        self.size += len(value or b"")

    def get(self, key: bytes) -> Value | Missing:
        return self._values.get(key, MISSING)

    def items(self, start: bytes | None = None, end: bytes | None = None) -> list[Item]:
        """Entries with start <= key < end, in key order: a copy, so later writes don't disturb a scan."""
        lo = 0 if start is None else bisect.bisect_left(self._keys, start)
        hi = len(self._keys) if end is None else bisect.bisect_left(self._keys, end)
        return [(key, self._values[key]) for key in self._keys[lo:hi]]
