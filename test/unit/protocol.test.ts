import { describe, expect, it } from 'vitest';
import { fromWebviewSchema, safeExternalUrl } from '../../src/shared/protocol.ts';

describe('safeExternalUrl', () => {
  it.each(['https://example.com/docs', 'http://example.com', 'mailto:someone@example.com', 'https://8.8.8.8/x'])('allows %s', (u) => {
    expect(safeExternalUrl(u)).not.toBeNull();
  });

  it.each([
    'http://localhost:8888/',
    'http://dev.localhost/',
    'http://printer.local/',
    'http://intranet/',
    'http://127.0.0.1:3000/',
    'http://10.1.2.3/',
    'http://192.168.0.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:8080/',
    'http://[fd00::1]/',
    'http://user:pass@example.com/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not a url',
  ])('refuses %s', (u) => {
    expect(safeExternalUrl(u)).toBeNull();
  });

  it('normalizes', () => {
    expect(safeExternalUrl('HTTPS://Example.COM/a b')).toBe('https://example.com/a%20b');
  });
});

describe('fromWebviewSchema', () => {
  it('accepts well-formed messages', () => {
    expect(fromWebviewSchema.safeParse({ type: 'focusAnchor', anchorId: 'refill', source: 'scroll' }).success).toBe(true);
    expect(fromWebviewSchema.safeParse({ type: 'openFile', path: 'notes/more.html' }).success).toBe(true);
  });

  it.each([
    null,
    { type: 'focusAnchor', anchorId: '../x', source: 'scroll' },
    { type: 'focusAnchor', anchorId: 'a', source: 'other' },
    { type: 'openExternal', url: 'http://localhost/' },
    { type: 'openFile', path: '../../etc/passwd' },
    { type: 'openFile', path: '/abs' },
    { type: 'unknown' },
  ])('refuses %j', (m) => {
    expect(fromWebviewSchema.safeParse(m).success).toBe(false);
  });
});

describe('safeExternalUrl: security audit regressions', () => {
  it.each([
    'https://attacker.example/?u=http://127.0.0.1:2375',
    'https://github.com/login/oauth/authorize?client_id=x&redirect_uri=http://localhost:8888/cb',
    'https://example.com/?u=http%3A%2F%2Flocalhost%3A9000',
    'https://example.com/#http://localhost:3000',
    'mailto:a@b.c?attach=/etc/passwd',
  ])('refuses %s', (u) => {
    expect(safeExternalUrl(u)).toBeNull();
  });

  it('allows ordinary query strings and plain mail links', () => {
    expect(safeExternalUrl('https://example.com/search?q=bit+reader&page=2')).not.toBeNull();
    expect(safeExternalUrl('mailto:team@example.com?subject=Hello&body=Hi')).not.toBeNull();
  });
});
