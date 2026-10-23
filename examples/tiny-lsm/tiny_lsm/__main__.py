"""A small shell for poking at a database: python -m tiny_lsm DIR [COMMAND ...]

    put KEY VALUE | get KEY | del KEY | scan [START [END]] | load N
    flush | compact | stats | help | quit
"""
import cmd
import random
import shlex
import sys

from .db import DB
from .options import Options

# Small sizes, so that a few hundred writes show flushes and compactions.
SHELL_OPTIONS = Options(memtable_bytes=4096, block_bytes=512, table_bytes=4096, l0_limit=4, level_base_bytes=16 * 1024)


class Shell(cmd.Cmd):
    prompt = "lsm> "

    def __init__(self, db: DB) -> None:
        super().__init__()
        self.db = db

    def do_put(self, arg: str) -> None:
        """put KEY VALUE"""
        key, value = shlex.split(arg)
        self.db.put(key.encode(), value.encode())

    def do_get(self, arg: str) -> None:
        """get KEY"""
        (key,) = shlex.split(arg)
        value = self.db.get(key.encode())
        print("(not found)" if value is None else value.decode(errors="replace"))

    def do_del(self, arg: str) -> None:
        """del KEY"""
        (key,) = shlex.split(arg)
        self.db.delete(key.encode())

    def do_scan(self, arg: str) -> None:
        """scan [START [END]]: keys from START up to (not including) END"""
        bounds: list[bytes | None] = [b.encode() for b in shlex.split(arg)]
        bounds += [None, None]
        for key, value in self.db.scan(bounds[0], bounds[1]):
            print(f"{key.decode(errors='replace')} = {value.decode(errors='replace')}")

    def do_load(self, arg: str) -> None:
        """load N: put N random keys (key0000..key9999), to watch flushes and compactions"""
        for _ in range(int(arg or 1000)):
            n = random.randrange(10_000)
            self.db.put(f"key{n:04d}".encode(), f"value-{n}-{random.random():.6f}".encode())
        self.do_stats("")

    def do_flush(self, arg: str) -> None:
        """flush: write the memtable to a new L0 table"""
        self.db.flush()

    def do_compact(self, arg: str) -> None:
        """compact: merge every level all the way down"""
        self.db.compact()
        self.do_stats("")

    def do_stats(self, arg: str) -> None:
        """stats: tables and bytes per level"""
        for name, value in self.db.stats().items():
            print(f"{name:>36}: {value}")

    def do_quit(self, arg: str) -> bool:
        """quit"""
        return True

    do_EOF = do_quit

    def onecmd(self, line: str) -> bool:
        try:
            return super().onecmd(line)
        except ValueError as e:
            print(f"error: {e}")
            return False


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 2
    with DB(argv[0], SHELL_OPTIONS) as db:
        shell = Shell(db)
        if len(argv) > 1:
            shell.onecmd(shlex.join(argv[1:]))
        else:
            shell.cmdloop(f"tiny_lsm in {argv[0]}. Type help for commands.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
