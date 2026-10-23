"""SSTables: immutable files of sorted entries.

    table  := block* index bloom footer
    block  := entry* crc32:u32                     about block_bytes of entries
    index  := count:u32 (key_len:u16 key offset:u64 size:u32)*  last_key_len:u16 last_key
    bloom  := num_bits:u32 num_hashes:u8 bits
    footer := index_offset:u64 index_size:u32 bloom_offset:u64 bloom_size:u32
              entries:u64 magic:8s                 a fixed 40 bytes at the very end

The index is sparse: one entry per block, holding the block's first key. To find a
key, a reader opens the footer (at a known place: the end), loads the index and
the bloom filter, and then needs to read just one block. Only data blocks carry a
CRC: they are read again and again, the rest once, when the table is opened.
"""
import os
import struct
import weakref
import zlib
from bisect import bisect_right
from collections.abc import Iterator
from pathlib import Path

from .bloom import BloomFilter
from .encoding import MISSING, CorruptionError, Item, Missing, Value, encode_entry, iter_entries

FOOTER = struct.Struct("<QIQIQ8s")
MAGIC = b"TINYLSM1"
CRC = struct.Struct("<I")
COUNT = struct.Struct("<I")
INDEX_ENTRY = struct.Struct("<QI")  # block offset, block size (after the key)
KEY_LEN = struct.Struct("<H")


class TableBuilder:
    """Writes one SSTable from entries added in increasing key order."""

    def __init__(self, path: Path, block_bytes: int = 4096, bits_per_key: int = 10) -> None:
        self.path = path
        self._file = open(path, "wb")
        self._block_bytes = block_bytes
        self._bits_per_key = bits_per_key
        self._block = bytearray()
        self._index: list[tuple[bytes, int, int]] = []  # (first key, offset, size) per block
        self._keys: list[bytes] = []
        self._offset = 0

    @property
    def size(self) -> int:
        return self._offset + len(self._block)

    def add(self, key: bytes, value: Value) -> None:
        if self._keys and key <= self._keys[-1]:
            raise ValueError("keys must be added in increasing order")
        if not self._block:
            self._index.append((key, self._offset, 0))  # a new block starts with this key
        self._block += encode_entry(key, value)
        self._keys.append(key)
        if len(self._block) >= self._block_bytes:
            self._finish_block()

    def _finish_block(self) -> None:
        self._block += CRC.pack(zlib.crc32(self._block))
        first_key, offset, _ = self._index[-1]
        self._index[-1] = (first_key, offset, len(self._block))
        self._file.write(self._block)
        self._offset += len(self._block)
        self._block = bytearray()

    def finish(self) -> "SSTable":
        """Writes the index, the bloom filter and the footer, syncs, and opens the table."""
        if self._block:
            self._finish_block()
        index = bytearray(COUNT.pack(len(self._index)))
        for first_key, offset, size in self._index:
            index += KEY_LEN.pack(len(first_key)) + first_key + INDEX_ENTRY.pack(offset, size)
        index += KEY_LEN.pack(len(self._keys[-1])) + self._keys[-1]
        bloom = BloomFilter.for_keys(self._keys, self._bits_per_key).to_bytes()
        index_offset, bloom_offset = self._offset, self._offset + len(index)
        footer = FOOTER.pack(index_offset, len(index), bloom_offset, len(bloom), len(self._keys), MAGIC)
        self._file.write(index + bloom + footer)
        self._file.flush()
        os.fsync(self._file.fileno())  # durable before the manifest may name it
        self._file.close()
        return SSTable(self.path)


def write_table(path: Path, items: list[Item], block_bytes: int = 4096, bits_per_key: int = 10) -> "SSTable":
    builder = TableBuilder(path, block_bytes, bits_per_key)
    for key, value in items:
        builder.add(key, value)
    return builder.finish()


class SSTable:
    """An open table: the footer, index and bloom filter in memory, the blocks on disk."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._file = open(path, "rb")
        # A table that a compaction replaced may still be read by a scan: close it when the last user lets go.
        self._closer = weakref.finalize(self, self._file.close)
        self.size = self._file.seek(0, 2)
        if self.size < FOOTER.size:
            raise CorruptionError(f"{path.name}: too short for a footer")
        index_offset, index_size, bloom_offset, bloom_size, self.entry_count, magic = FOOTER.unpack(
            self._read(self.size - FOOTER.size, FOOTER.size)
        )
        if magic != MAGIC:
            raise CorruptionError(f"{path.name}: not a table (bad magic)")
        self._first_keys, self._blocks, self.max_key = _decode_index(self._read(index_offset, index_size))
        self.min_key = self._first_keys[0]
        self.bloom = BloomFilter.from_bytes(self._read(bloom_offset, bloom_size))
        self.block_reads = 0

    def close(self) -> None:
        self._closer()

    def get(self, key: bytes) -> Value | Missing:
        if not self.min_key <= key <= self.max_key or not self.bloom.might_contain(key):
            return MISSING  # without touching the disk
        block = bisect_right(self._first_keys, key) - 1  # the only block that can hold key
        for k, value in self._read_block(block):
            if k == key:
                return value
            if k > key:
                break
        return MISSING

    def items(self, start: bytes | None = None, end: bytes | None = None) -> Iterator[Item]:
        """Entries with start <= key < end, in key order, reading one block at a time."""
        first = 0 if start is None else max(0, bisect_right(self._first_keys, start) - 1)
        for block in range(first, len(self._blocks)):
            for key, value in self._read_block(block):
                if end is not None and key >= end:
                    return
                if start is None or key >= start:
                    yield key, value

    def _read_block(self, block: int) -> list[Item]:
        offset, size = self._blocks[block]
        data = self._read(offset, size)
        body, (crc,) = data[: -CRC.size], CRC.unpack(data[-CRC.size :])
        if zlib.crc32(body) != crc:
            raise CorruptionError(f"{self.path.name}: block {block} fails its checksum")
        self.block_reads += 1
        return list(iter_entries(body))

    def _read(self, offset: int, size: int) -> bytes:
        self._file.seek(offset)
        data = self._file.read(size)
        if len(data) != size:
            raise CorruptionError(f"{self.path.name}: short read at {offset}")
        return data


def _decode_index(data: bytes) -> tuple[list[bytes], list[tuple[int, int]], bytes]:
    """The first key of each block, each block's (offset, size), and the table's last key."""
    (count,), pos = COUNT.unpack_from(data), COUNT.size
    first_keys: list[bytes] = []
    blocks: list[tuple[int, int]] = []
    for _ in range(count):
        key, pos = _read_key(data, pos)
        offset, size = INDEX_ENTRY.unpack_from(data, pos)
        blocks.append((offset, size))
        first_keys.append(key)
        pos += INDEX_ENTRY.size
    last_key, _ = _read_key(data, pos)
    return first_keys, blocks, last_key


def _read_key(data: bytes, pos: int) -> tuple[bytes, int]:
    (length,) = KEY_LEN.unpack_from(data, pos)
    pos += KEY_LEN.size
    return data[pos : pos + length], pos + length
