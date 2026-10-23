"""Bloom filters: each SSTable's quick "definitely not here" for point lookups.

A key sets k bits of an m-bit array. A lookup checks the same k bits: if any is
clear the key was never added; if all are set it probably was. The k positions
come from one 64-bit hash by double hashing (Kirsch and Mitzenmacher):

    position_i = (h1 + i * h2) mod m      h1, h2 = the hash's low and high 32 bits

With 10 bits per key and k = 7, about 1% of absent keys get a false "maybe".
"""
import math
import struct
from typing import Self

FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3
MASK64 = (1 << 64) - 1
PARAMS = struct.Struct("<IB")  # number of bits, number of hashes


def hash64(data: bytes) -> int:
    """FNV-1a, then MurmurHash3's finalizer: keys that differ in one byte get unrelated bits."""
    h = FNV_OFFSET
    for byte in data:
        h = ((h ^ byte) * FNV_PRIME) & MASK64
    h = ((h ^ (h >> 33)) * 0xFF51AFD7ED558CCD) & MASK64
    h = ((h ^ (h >> 33)) * 0xC4CEB9FE1A85EC53) & MASK64
    return h ^ (h >> 33)


class BloomFilter:
    def __init__(self, num_bits: int, num_hashes: int, bits: bytearray | None = None) -> None:
        self.num_bits = num_bits
        self.num_hashes = num_hashes
        self.bits = bits if bits is not None else bytearray((num_bits + 7) // 8)

    @classmethod
    def for_keys(cls, keys: list[bytes], bits_per_key: int = 10) -> Self:
        num_hashes = max(1, round(bits_per_key * math.log(2)))  # the k that minimises false positives
        bloom = cls(max(64, len(keys) * bits_per_key), num_hashes)
        for key in keys:
            bloom.add(key)
        return bloom

    def positions(self, key: bytes) -> list[int]:
        h = hash64(key)
        h1, h2 = h & 0xFFFFFFFF, (h >> 32) | 1  # never a zero step, which would put all k bits in one place
        return [(h1 + i * h2) % self.num_bits for i in range(self.num_hashes)]

    def add(self, key: bytes) -> None:
        for p in self.positions(key):
            self.bits[p // 8] |= 1 << (p % 8)

    def might_contain(self, key: bytes) -> bool:
        return all(self.bits[p // 8] & (1 << (p % 8)) for p in self.positions(key))

    def to_bytes(self) -> bytes:
        return PARAMS.pack(self.num_bits, self.num_hashes) + bytes(self.bits)

    @classmethod
    def from_bytes(cls, data: bytes) -> Self:
        num_bits, num_hashes = PARAMS.unpack_from(data)
        return cls(num_bits, num_hashes, bytearray(data[PARAMS.size :]))
