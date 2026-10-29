// The checker's rules: global, per sidestory, per step and per element, the narrowest winning; safety rules locked.
import { describe, expect, it } from 'vitest';
import { applyRules, LOCKED_RULES, lockedLevels, manifestLevels, parseChecksFile, parseIgnore, severityFor, type RuleContext, type RuleFinding } from '../../src/core/check-rules.ts';

const HTML = '/r/.sidestory/s/sidestory.html';
const MANIFEST = '/r/.sidestory/s/manifest.json';
const f = (code: string, extra: Partial<RuleFinding> = {}): RuleFinding => ({ severity: 'warning', file: MANIFEST, code, message: code, ...extra });
const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({ global: new Map(), sidestory: new Map(), anchors: new Map(), ignores: [], htmlFile: HTML, ...over });

describe('check rules', () => {
  it('the narrowest level wins: step over sidestory over global over the checker', () => {
    const r = applyRules([f('anchor-stale', { anchor: 'refill' }), f('anchor-stale', { anchor: 'other' }), f('no-title')], ctx({
      global: new Map([['anchor-stale', 'error'], ['no-title', 'info']]),
      sidestory: new Map([['no-title', 'off']]),
      anchors: new Map([['refill', new Map([['anchor-stale', 'off']])]]),
    }));
    expect(r.findings.map((x) => `${x.code}:${x.anchor ?? ''}:${x.severity}`)).toEqual(['anchor-stale:other:error']);
    expect(r.off).toEqual([{ code: 'anchor-stale', reason: 'off in anchor "refill"' }, { code: 'no-title', reason: 'off in manifest.json' }]);
  });

  it('an element\'s exception turns off its rules on the lines it spans, with its reason; unused ones are reported', () => {
    const ignores = [{ codes: ['box-unlinked'], reason: 'legend', line: 10, endLine: 14 }, { codes: ['no-title'], reason: 'x', line: 40, endLine: 40 }];
    const r = applyRules([f('box-unlinked', { file: HTML, line: 12 }), f('box-unlinked', { file: HTML, line: 20 })], ctx({ ignores }));
    expect(r.findings.map((x) => x.line)).toEqual([20]);
    expect(r.off).toEqual([{ code: 'box-unlinked', reason: 'legend' }]);
    expect(r.unusedIgnores).toEqual([ignores[1]]);
  });

  it('safety rules stay at every level, and say so', () => {
    expect(LOCKED_RULES.has('code-link-secret')).toBe(true);
    const r = applyRules([f('code-link-secret', { severity: 'error', file: HTML, line: 3 })], ctx({
      global: new Map([['code-link-secret', 'off']]),
      ignores: [{ codes: ['code-link-secret'], reason: 'please', line: 1, endLine: 5 }],
    }));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe('error');
    expect(r.locked.map((l) => l.where)).toEqual(['data-explain-ignore at line 1', '.sidestory/checks.json']);
    expect(LOCKED_RULES.has('bad-specifier')).toBe(true);
    // Raising one is fine.
    expect(applyRules([f('secret-file', { severity: 'warning' })], ctx({ global: new Map([['secret-file', 'error']]) })).findings[0]!.severity).toBe('error');
  });

  it('reads checks.json, the manifest\'s levels and the page\'s exceptions, reporting mistakes', () => {
    expect([...parseChecksFile('{"rules":{"anchor-stale":"error","box-unlinked":"off"}}').levels]).toEqual([['anchor-stale', 'error'], ['box-unlinked', 'off']]);
    expect(parseChecksFile('{"rules":{"Anchor":"loud"},"extra":1}').problems).toHaveLength(2);
    expect(parseChecksFile('{nope').problems[0]).toMatch(/valid JSON/);
    const m = manifestLevels(JSON.stringify({ checks: { 'no-title': 'off' }, anchors: { refill: { file: 'a', range: [1, 2], checks: { 'anchor-changed': 'info' } }, bad: { checks: 'x' } } }));
    expect([...m.sidestory]).toEqual([['no-title', 'off']]);
    expect([...m.anchors.get('refill')!]).toEqual([['anchor-changed', 'info']]);
    expect(m.problems).toEqual(['anchor "bad" "checks": must be an object of rules, like { "anchor-stale": "error" }']);
    expect(parseIgnore('box-unlinked no-title: legend, not code')).toEqual({ codes: ['box-unlinked', 'no-title'], reason: 'legend, not code', bad: [] });
    expect(parseIgnore('box-unlinked')).toEqual({ codes: ['box-unlinked'], reason: '', bad: [] });
    expect(parseIgnore('Box!: x').bad).toEqual(['Box!']);
  });

  it('an exception that knows its element covers only what is inside it, even on a one-line page', () => {
    const ignores = [{ codes: ['box-unlinked'], reason: 'legend', line: 1, endLine: 1, start: 10, end: 40 }];
    const r = applyRules([f('box-unlinked', { file: HTML, line: 1, offset: 20 }), f('box-unlinked', { file: HTML, line: 1, offset: 60 })], ctx({ ignores }));
    expect(r.findings.map((x) => x.offset)).toEqual([60]);
  });

  it('errors that mean the page doesn\'t load, and the rules\' own findings, aren\'t changed by any level', () => {
    const r = applyRules([f('manifest', { severity: 'error' }), f('unused-ignore', { file: HTML, line: 2 })], ctx({
      global: new Map([['manifest', 'off'], ['unused-ignore', 'off']]),
      ignores: [{ codes: ['unused-ignore'], reason: 'x', line: 1, endLine: 3 }],
    }));
    expect(r.findings.map((x) => `${x.code}:${x.severity}`)).toEqual(['manifest:error', 'unused-ignore:warning']);
    expect(lockedLevels(new Map([['secret-file', 'off'], ['syntax', 'warning'], ['anchor-stale', 'off']])).map((l) => l.code)).toEqual(['secret-file', 'syntax']);
  });

  it('a step\'s "checks" take only the step\'s code findings; VS Code\'s Problems panel uses the same levels', () => {
    const m = manifestLevels(JSON.stringify({ anchors: { refill: { checks: { 'anchor-stale': 'off', 'no-title': 'off' } } } }));
    expect([...m.anchors.get('refill')!.keys()]).toEqual(['anchor-stale']);
    expect(m.problems[0]).toMatch(/"no-title" can't be set for one step/);
    const levels = { global: new Map([['needs-click', 'off'], ['syntax', 'off']] as const), sidestory: new Map([['unknown-export', 'info']] as const) };
    expect(severityFor('needs-click', 'warning', levels)).toBeUndefined();
    expect(severityFor('syntax', 'error', levels)).toBe('error');
    expect(severityFor('unknown-export', 'error', levels)).toBe('error');
    expect(severityFor('other', 'warning', levels)).toBe('warning');
  });
});
