import { describe, expect, it } from 'vitest';
import { shellQuote, shellSafePath } from '../../src/extension/shell.ts';

describe('the checker command quoting', () => {
  it('accepts plain sidestory paths and refuses shell syntax', () => {
    expect(shellSafePath('.sidestory/dma-ctrl')).toBe(true);
    expect(shellSafePath('services/auth/.sidestory/auth_tokens.v2')).toBe(true);
    for (const bad of ['.sidestory/$(curl x|sh)', '.sidestory/`id`', '.sidestory/a;b', '.sidestory/%PATH%', '.sidestory/a"b', "it's", '../x', 'a\nb', '.sidestory/<name>']) {
      expect(shellSafePath(bad)).toBe(false);
    }
  });

  it('quotes for POSIX shells and Windows', () => {
    expect(shellQuote('/x/check.cjs', 'darwin')).toBe("'/x/check.cjs'");
    expect(shellQuote("/it's/x", 'linux')).toBe("'/it'\\''s/x'");
    expect(shellQuote('C:\\Program Files\\x\\check.cjs', 'win32')).toBe('"C:\\Program Files\\x\\check.cjs"');
  });
});
