from dataclasses import dataclass


@dataclass(frozen=True)
class Options:
    """Sizes and limits. The defaults are small, to make the machinery easy to watch."""

    memtable_bytes: int = 64 * 1024  # flush the memtable to L0 once it holds this much
    block_bytes: int = 4096  # an SSTable data block, the unit of disk reads
    table_bytes: int = 64 * 1024  # compaction cuts its output into tables of about this size
    bloom_bits_per_key: int = 10  # about 1% false positives
    l0_limit: int = 4  # compact L0 into L1 when it has this many tables
    level_base_bytes: int = 256 * 1024  # L1's size limit
    level_multiplier: int = 10  # each level below may hold this many times more
    num_levels: int = 4
    sync: bool = False  # fsync the log on every write (slow, but survives power loss)

    def level_limit(self, n: int) -> int:
        """The byte limit of level n >= 1."""
        return self.level_base_bytes * self.level_multiplier ** (n - 1)
