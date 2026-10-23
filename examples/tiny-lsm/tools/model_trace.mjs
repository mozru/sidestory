// Prints what the simulation widget's model (.sidestory/lsm-overview/widgets/model.ts) does with each of its
// scenarios, as JSON, for tools/check_model.py to compare with the real code. Node 22.18 or later:
//
//     node tools/model_trace.mjs | python3 tools/check_model.py
import { OPTS, SCENARIOS, simulate } from '../.sidestory/lsm-overview/widgets/model.ts';

const out = { opts: OPTS, scenarios: {} };
for (const [name, s] of Object.entries(SCENARIOS)) {
  const frames = simulate(s.ops);
  const last = frames.at(-1);
  out.scenarios[name] = {
    ops: s.ops,
    results: frames.filter((f) => f.result !== undefined && (s.ops[f.op].kind !== 'put' && s.ops[f.op].kind !== 'del')).map((f) => ({ op: f.op, result: f.result, out: f.out })),
    mem: last.mem,
    log: last.log,
    levels: last.levels.map((l) => l.map((t) => ({ num: t.num, min: t.min, max: t.max, size: t.size, entries: t.entries, bloom: t.bloom }))),
  };
}
console.log(JSON.stringify(out));
