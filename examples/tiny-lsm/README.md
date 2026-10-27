# tiny-lsm: a log-structured merge tree, explained

This is a small but real key-value store in Python (standard library only, Python 3.11+, under 900 lines plus tests). Next to it is a set of [Sidestory](../../README.md) pages that walk through how it works: an overview with block diagrams, one page per component, and three interactive widgets.

![The overview's block diagram, with the code beside it](screenshots/01-overview-block-diagram.png)

## Try it

Open this folder in VS Code with Sidestory installed. Run **Sidestory: Open Sidestory…** and pick **lsm-overview**. Each component card lets you peek at its page or dive into it.

To run the store itself:

```bash
cd examples/tiny-lsm
python3 -m tiny_lsm.tests            # or: python3 -m unittest
python3 -m tiny_lsm /tmp/db          # then: put a 1, get a, load 2000, stats, scan key0100 key0110
```

## The widgets

Sidestory asks before it runs them. Until you agree, each one shows a static picture instead.

**The simulation** (in `lsm-overview`) runs the block diagram from a model of the Python code. Entries travel to the log and the memtable, flushes add L0 tables, compactions merge them down, and gets probe tables through their bloom filters. The editor highlights each line of Python as it runs. You can add your own puts, gets and deletes.

![The simulation mid-run: a get probing the tables, the editor on the line it runs](screenshots/02-simulation-get.png)

| The compaction visualizer (`lsm-compaction`) | The bloom filter playground (`lsm-bloom`) |
|---|---|
| ![Levels as rows of tables on a key axis](screenshots/03-compaction-visualizer.png) | ![Bits, false-positive rate and a chart against k](screenshots/04-bloom-playground.png) |
| Write batches and step through flushes and compactions. The write amplification adds up as you go. | Add keys, look keys up, and change m and k. The false-positive rate is shown both measured and by formula. |

## What's in it

| Page | Some of its steps | Code |
|---|---|---|
| `lsm-overview` | At a glance · A put · Compaction · A get · A scan · Recovery | [`db.py`](tiny_lsm/db.py) |
| `lsm-wal` | A record · flush and fsync · Replay (pick a crash) · Rotation | [`wal.py`](tiny_lsm/wal.py) |
| `lsm-memtable` | Two structures · put · Tombstones · When to flush | [`memtable.py`](tiny_lsm/memtable.py) |
| `lsm-sstable` | The file (a real table's bytes) · Index and footer · A lookup · Checksums | [`sstable.py`](tiny_lsm/sstable.py) |
| `lsm-bloom` | The idea · One hash · Try it · Sizing | [`bloom.py`](tiny_lsm/bloom.py) |
| `lsm-compaction` | Levels · Watch it · Picking · Merging · The swap · The cost | [`compaction.py`](tiny_lsm/compaction.py), [`levels.py`](tiny_lsm/levels.py) |
| `lsm-merge` | Why a heap · Step by step · Refilling · Tombstones | [`merge.py`](tiny_lsm/merge.py) |

The rest of the code: [`encoding.py`](tiny_lsm/encoding.py) and [`options.py`](tiny_lsm/options.py) define the entry format and the limits, [`__main__.py`](tiny_lsm/__main__.py) is the shell, and [`tests.py`](tiny_lsm/tests.py) covers crash recovery, torn logs, compaction checked against a dict, and snapshots.

| The SSTable byte layout | WAL replay, with a flipped bit |
|---|---|
| ![The SSTable byte layout](screenshots/05-sstable-byte-layout.png) | ![WAL replay with a flipped bit](screenshots/06-wal-replay-flipped-bit.png) |

## How the pictures stay true to the code

- The widget model ([`model.ts`](.sidestory/lsm-overview/widgets/model.ts)) follows the Python line for line, with the same byte sizes and the same hash. `node tools/model_trace.mjs | python3 tools/check_model.py` runs it against the real code and compares every table, entry and filter bit.
- [`tools/diagrams.py`](tools/diagrams.py) draws the figures from data that tiny_lsm itself wrote, and finds the line each simulation step highlights. Rerun it after you edit the code: `python3 tools/diagrams.py`.
