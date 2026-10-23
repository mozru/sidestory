"""Tests: python -m tiny_lsm.tests, or python -m unittest from examples/tiny-lsm."""
import random
import tempfile
import unittest
from pathlib import Path

from . import wal
from .bloom import BloomFilter
from .db import DB
from .encoding import MISSING, CorruptionError
from .memtable import Memtable
from .merge import merge
from .options import Options
from .sstable import SSTable, write_table

# Tiny sizes, so a few hundred writes exercise flushes, every level and compaction.
SMALL = Options(memtable_bytes=512, block_bytes=128, table_bytes=512, l0_limit=3, level_base_bytes=1024, level_multiplier=4)


class TempDirTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()


def crash(db: DB) -> None:
    """Drops the database like a dying process would: no flush, nothing more written."""
    db._wal.close()  # every append already reached the OS, so closing adds nothing
    db._levels.close()


def key(n: int) -> bytes:
    return f"key{n:05d}".encode()


class TestWal(TempDirTest):
    def test_replays_what_was_appended(self) -> None:
        log = wal.WriteAheadLog(self.dir / "1.log")
        log.append(b"a", b"1")
        log.append(b"b", None)
        log.close()
        self.assertEqual(wal.replay(self.dir / "1.log"), ([(b"a", b"1"), (b"b", None)], 0))

    def test_cuts_a_torn_tail_and_appends_after_it(self) -> None:
        path = self.dir / "1.log"
        log = wal.WriteAheadLog(path)
        log.append(b"a", b"1")
        log.append(b"b", b"2")
        log.close()
        path.write_bytes(path.read_bytes()[:-3])  # the crash came mid-append
        self.assertEqual(wal.replay(path), ([(b"a", b"1")], 17 - 3))  # a 17-byte record lost 3 bytes
        log = wal.WriteAheadLog(path)
        log.append(b"c", b"3")
        log.close()
        self.assertEqual(wal.replay(path)[0], [(b"a", b"1"), (b"c", b"3")])

    def test_stops_at_a_corrupt_record(self) -> None:
        path = self.dir / "1.log"
        log = wal.WriteAheadLog(path)
        for k in (b"a", b"b", b"c"):
            log.append(k, b"v")
        log.close()
        data = bytearray(path.read_bytes())
        data[len(data) // 2] ^= 0xFF  # flip a bit in the middle record
        path.write_bytes(data)
        self.assertEqual(wal.replay(path)[0], [(b"a", b"v")])


class TestMemtable(unittest.TestCase):
    def test_sorted_with_tombstones(self) -> None:
        mem = Memtable()
        for k, v in [(b"c", b"3"), (b"a", b"1"), (b"b", b"2"), (b"a", b"one"), (b"b", None)]:
            mem.put(k, v)
        self.assertEqual(mem.items(), [(b"a", b"one"), (b"b", None), (b"c", b"3")])
        self.assertEqual(mem.items(b"b", b"c"), [(b"b", None)])
        self.assertIsNone(mem.get(b"b"))
        self.assertIs(mem.get(b"z"), MISSING)
        self.assertEqual(mem.size, 3 * 7 + 3 + len(b"one") + len(b"3"))


class TestBloom(unittest.TestCase):
    def test_no_false_negatives_and_few_false_positives(self) -> None:
        keys = [key(n) for n in range(0, 20_000, 2)]
        bloom = BloomFilter.from_bytes(BloomFilter.for_keys(keys).to_bytes())
        self.assertTrue(all(bloom.might_contain(k) for k in keys))
        false_positives = sum(bloom.might_contain(key(n)) for n in range(1, 20_000, 2))
        self.assertLess(false_positives / 10_000, 0.02)


class TestSSTable(TempDirTest):
    def test_round_trip_across_many_blocks(self) -> None:
        items = [(key(n), None if n % 7 == 0 else f"v{n}".encode()) for n in range(500)]
        table = write_table(self.dir / "t.sst", items, block_bytes=128)
        self.assertGreater(len(table._blocks), 20)
        self.assertEqual(list(table.items()), items)
        self.assertEqual(list(table.items(key(100), key(110))), items[100:110])
        self.assertEqual(table.get(key(43)), b"v43")
        self.assertIsNone(table.get(key(49)))  # a tombstone
        self.assertIs(table.get(b"key00043x"), MISSING)
        self.assertEqual((table.min_key, table.max_key, table.entry_count), (key(0), key(499), 500))

    def test_bloom_filter_spares_disk_reads(self) -> None:
        table = write_table(self.dir / "t.sst", [(key(n), b"v") for n in range(0, 1000, 2)], block_bytes=128)
        for n in range(1, 1000, 2):
            self.assertIs(table.get(key(n)), MISSING)
        self.assertLess(table.block_reads, 20)  # for 500 lookups of absent keys

    def test_detects_a_corrupt_block(self) -> None:
        path = self.dir / "t.sst"
        write_table(path, [(key(n), b"value") for n in range(100)], block_bytes=128).close()
        data = bytearray(path.read_bytes())
        data[10] ^= 0xFF
        path.write_bytes(data)
        with self.assertRaises(CorruptionError):
            SSTable(path).get(key(0))


class TestMerge(unittest.TestCase):
    def test_newest_source_wins(self) -> None:
        newest = [(b"a", b"new"), (b"c", None)]
        older = [(b"a", b"old"), (b"b", b"2"), (b"c", b"3")]
        self.assertEqual(list(merge([newest, older])), [(b"a", b"new"), (b"b", b"2"), (b"c", None)])


class TestDB(TempDirTest):
    def check_against(self, db: DB, model: dict[bytes, bytes], keys: range) -> None:
        for n in keys:
            self.assertEqual(db.get(key(n)), model.get(key(n)), key(n))
        self.assertEqual(list(db.scan()), sorted(model.items()))
        self.assertEqual(list(db.scan(key(100), key(200))), sorted((k, v) for k, v in model.items() if key(100) <= k < key(200)))

    def random_workload(self, db: DB, model: dict[bytes, bytes], ops: int, seed: int) -> None:
        rng = random.Random(seed)
        for i in range(ops):
            k = key(rng.randrange(400))
            if rng.random() < 0.2:
                db.delete(k)
                model.pop(k, None)
            else:
                db.put(k, f"value-{i}".encode())
                model[k] = f"value-{i}".encode()

    def test_matches_a_dict_through_flushes_and_compactions(self) -> None:
        model: dict[bytes, bytes] = {}
        with DB(self.dir, SMALL) as db:
            self.random_workload(db, model, 3000, seed=1)
            levels = db._levels.levels
            self.assertLess(len(levels[0]), SMALL.l0_limit)
            self.assertTrue(levels[1] and levels[2], "data reached L1 and L2")
            for level in levels[1:]:  # sorted and non-overlapping
                for a, b in zip(level, level[1:]):
                    self.assertLess(a.max_key, b.min_key)
            self.check_against(db, model, range(400))

    def test_recovers_unflushed_writes_after_a_crash(self) -> None:
        model: dict[bytes, bytes] = {}
        db = DB(self.dir, SMALL)
        self.random_workload(db, model, 1000, seed=2)
        self.assertTrue(len(db._mem), "some writes are only in the memtable and the log")
        crash(db)
        with DB(self.dir, SMALL) as reopened:
            self.check_against(reopened, model, range(400))

    def test_recovers_from_a_torn_log_write(self) -> None:
        db = DB(self.dir, SMALL)
        db.put(b"a", b"1")
        db.put(b"b", b"2")
        log = db._levels.log_path()
        crash(db)
        log.write_bytes(log.read_bytes()[:-2])  # the last append was cut short
        with DB(self.dir, SMALL) as reopened:
            self.assertEqual((reopened.get(b"a"), reopened.get(b"b")), (b"1", None))
            self.assertGreater(reopened.torn_bytes, 0)
            reopened.put(b"c", b"3")
        with DB(self.dir, SMALL) as again:
            self.assertEqual(list(again.scan()), [(b"a", b"1"), (b"c", b"3")])

    def test_ignores_a_table_from_a_flush_that_never_committed(self) -> None:
        with DB(self.dir, SMALL) as db:
            db.put(b"a", b"1")
        stray = self.dir / "000999.sst"
        write_table(stray, [(b"zzz", b"debris")]).close()
        with DB(self.dir, SMALL) as db:
            self.assertFalse(stray.exists())
            self.assertEqual(list(db.scan()), [(b"a", b"1")])

    def test_a_tombstone_hides_older_values_until_compacted_away(self) -> None:
        with DB(self.dir, SMALL) as db:
            for n in range(200):
                db.put(key(n), b"old")
            db.compact()  # all in the bottom level
            db.delete(key(7))
            db.flush()  # the tombstone is in L0, the value far below
            self.assertIsNone(db.get(key(7)))
            self.assertNotIn(key(7), dict(db.scan()))
            db.compact()  # tombstone meets the value at the bottom: both go
            self.assertIsNone(db.get(key(7)))
            entries = [k for level in db._levels.levels for t in level for k, _ in t.items()]
            self.assertNotIn(key(7), entries)
            self.assertEqual(len(entries), 199)

    def test_survives_reopen_after_compactions(self) -> None:
        model: dict[bytes, bytes] = {}
        with DB(self.dir, SMALL) as db:
            self.random_workload(db, model, 2000, seed=3)
        with DB(self.dir, SMALL) as db:
            self.check_against(db, model, range(400))
            self.random_workload(db, model, 500, seed=4)
            self.check_against(db, model, range(400))
        names = {p.name for p in self.dir.iterdir()}
        with DB(self.dir, SMALL) as db:
            live = {t.path.name for level in db._levels.levels for t in level}
        self.assertEqual({n for n in names if n.endswith(".sst")}, live, "no stray tables")

    def test_a_scan_sees_a_snapshot(self) -> None:
        with DB(self.dir, SMALL) as db:
            for n in range(300):
                db.put(key(n), b"v")
            scan = db.scan()
            first = next(scan)
            for n in range(300, 600):  # flushes and compactions replace the tables the scan reads
                db.put(key(n), b"w")
            rest = list(scan)
            self.assertEqual([first[0]] + [k for k, _ in rest], [key(n) for n in range(300)])


if __name__ == "__main__":
    unittest.main()
