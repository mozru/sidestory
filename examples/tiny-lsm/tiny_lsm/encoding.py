"""How an entry becomes bytes: one layout, shared by the WAL and the SSTables.

    entry := kind:u8  key_len:u16  value_len:u32  key  value

A DELETE entry (a tombstone) has no value. It still has to be written down: it
hides the older values of its key that live in older files.
"""
import enum
import struct
from collections.abc import Iterator
from typing import TypeAlias

PUT = 1
DELETE = 0

HEADER = struct.Struct("<BHI")  # kind, key length, value length
MAX_KEY = 0xFFFF

Value: TypeAlias = bytes | None  # None is a tombstone
Item: TypeAlias = tuple[bytes, Value]


class Missing(enum.Enum):
    """A source has no entry for the key (unlike a tombstone, which says "deleted")."""

    MISSING = enum.auto()


MISSING = Missing.MISSING


class CorruptionError(Exception):
    """Bytes on disk that don't decode: a bad checksum, magic or length."""


def encode_entry(key: bytes, value: Value) -> bytes:
    if len(key) > MAX_KEY:
        raise ValueError(f"key of {len(key)} bytes is longer than {MAX_KEY}")
    if value is None:
        return HEADER.pack(DELETE, len(key), 0) + key
    return HEADER.pack(PUT, len(key), len(value)) + key + value


def decode_entry(buf: bytes, offset: int) -> tuple[bytes, Value, int]:
    """The entry at offset, and the offset just past it."""
    if offset + HEADER.size > len(buf):
        raise CorruptionError("entry header runs past the end")
    kind, key_len, value_len = HEADER.unpack_from(buf, offset)
    key_start = offset + HEADER.size
    value_start = key_start + key_len
    end = value_start + value_len
    if kind not in (PUT, DELETE) or end > len(buf):
        raise CorruptionError(f"bad entry at offset {offset}")
    key = buf[key_start:value_start]
    return key, (buf[value_start:end] if kind == PUT else None), end


def iter_entries(buf: bytes) -> Iterator[Item]:
    offset = 0
    while offset < len(buf):
        key, value, offset = decode_entry(buf, offset)
        yield key, value
