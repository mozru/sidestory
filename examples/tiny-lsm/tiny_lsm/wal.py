"""The write-ahead log: every write is appended here before the memtable sees it.

    record := crc32:u32  length:u32  entry        (the CRC covers length and entry)

The memtable lives in memory, so after a crash it is rebuilt by replaying the log.
A crash in the middle of an append leaves a torn record at the end of the file:
too short, or with bytes that fail the CRC. Replay stops at the first such record
and cuts the file there, so the next append starts on a clean boundary. Any bad
record is treated as the end of the log: after a flipped bit mid-file, the records
behind it are dropped too, since the length that would find the next one is suspect.
"""
import os
import struct
import zlib
from pathlib import Path

from .encoding import Item, Value, decode_entry, encode_entry
from .levels import sync_dir

RECORD = struct.Struct("<II")  # crc32, length of the entry
LENGTH = struct.Struct("<I")


class WriteAheadLog:
    def __init__(self, path: Path, sync: bool = False) -> None:
        self.path = path
        self._sync = sync
        self._file = open(path, "ab")
        if sync:
            sync_dir(path.parent)  # the new file's name, too, must survive a power loss

    def append(self, key: bytes, value: Value) -> None:
        entry = encode_entry(key, value)
        crc = zlib.crc32(LENGTH.pack(len(entry)) + entry)
        self._file.write(RECORD.pack(crc, len(entry)) + entry)
        self._file.flush()  # in the OS's hands: survives the process crashing
        if self._sync:
            os.fsync(self._file.fileno())  # on the disk: survives the machine crashing

    def close(self) -> None:
        self._file.close()


def replay(path: Path) -> tuple[list[Item], int]:
    """The log's entries, oldest first, and how many bytes of torn tail were cut off."""
    data = path.read_bytes()
    entries: list[Item] = []
    pos = 0
    while pos + RECORD.size <= len(data):
        crc, length = RECORD.unpack_from(data, pos)
        end = pos + RECORD.size + length
        if end > len(data) or zlib.crc32(data[pos + 4 : end]) != crc:
            break  # torn or corrupt: nothing after it can be trusted
        key, value, _ = decode_entry(data[pos + RECORD.size : end], 0)
        entries.append((key, value))
        pos = end
    if pos < len(data):
        with open(path, "r+b") as f:
            f.truncate(pos)
    return entries, len(data) - pos
