"""Merging sorted sources into one sorted stream, newest entry per key.

A scan reads the memtable and every table that overlaps its range; a compaction
reads its input tables. Each source is sorted, so a heap holding the next entry of
every source yields them all in key order. The heap orders by (key, rank), and
rank 0 is the newest source: of several entries for one key, the newest pops first
and the older ones, now shadowed, are skipped.
"""
import heapq
from collections.abc import Iterable, Iterator
from typing import TypeAlias

from .encoding import Item, Value

Head: TypeAlias = tuple[bytes, int, Value, Iterator[Item]]  # a source's next entry: key, rank, value, the source


def merge(sources: Iterable[Iterable[Item]]) -> Iterator[Item]:
    """One entry per key, in key order, from sources listed newest first. Tombstones pass through."""
    heap: list[Head] = []
    for rank, source in enumerate(sources):
        _push_next(heap, rank, iter(source))
    while heap:
        key, rank, value, source = heapq.heappop(heap)
        _push_next(heap, rank, source)
        while heap and heap[0][0] == key:  # older entries for the same key: shadowed
            _, older_rank, _, older = heapq.heappop(heap)
            _push_next(heap, older_rank, older)
        yield key, value


def _push_next(heap: list[Head], rank: int, source: Iterator[Item]) -> None:
    entry = next(source, None)
    if entry is not None:
        heapq.heappush(heap, (entry[0], rank, entry[1], source))


def live(items: Iterable[Item]) -> Iterator[tuple[bytes, bytes]]:
    """Drops tombstones: what a reader should see."""
    return ((key, value) for key, value in items if value is not None)
