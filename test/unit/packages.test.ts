// Packages (docs/NAVIGATION-PLAN.md §5.1): labels, and which packages count for a file.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { longestPrefixPackage, packageLabel, packageKeyOf } = await import('../../src/extension/nav/packages.ts');
const { refFromDir, uriKey } = await import('../../src/extension/explainers.ts');

afterEach(() => {
  workspace.root = undefined;
  workspace.folders = undefined;
});

describe('package labels', () => {
  it('single root: the path below the folder; the folder itself gets its name', () => {
    workspace.root = Uri.file('/repo/app');
    expect(packageLabel(Uri.file('/repo/app/services/auth') as never)).toBe('services/auth');
    expect(packageLabel(Uri.file('/repo/app') as never)).toBe('app');
  });
  it('multi-root: prefixed with the folder name', () => {
    workspace.folders = [
      { uri: Uri.file('/w/api'), name: 'api' },
      { uri: Uri.file('/w/web'), name: 'web' },
    ];
    expect(packageLabel(Uri.file('/w/api/services/auth') as never)).toBe('api › services/auth');
    expect(packageLabel(Uri.file('/w/web') as never)).toBe('web');
  });
  it('cleans the label (folder names are repository text)', () => {
    workspace.root = Uri.file('/repo');
    expect(packageLabel(Uri.file('/repo/a‮b\ncd') as never)).toBe('ab cd');
  });
  it('the package key is the Sidestory folder', () => {
    workspace.root = Uri.file('/repo');
    expect(packageKeyOf(Uri.file('/repo/x/.sidestory/a') as never)).toBe(uriKey(Uri.file('/repo/x/.sidestory') as never));
  });
});

describe('a file’s packages', () => {
  it('the longest root that is a path prefix wins', () => {
    const roots = new Map([
      ['top', 'file:///repo'],
      ['auth', 'file:///repo/services/auth'],
      ['authx', 'file:///repo/services/auth-x'],
    ]);
    expect(longestPrefixPackage('file:///repo/services/auth/src/a.ts', roots)).toBe('auth');
    expect(longestPrefixPackage('file:///repo/services/auth-x/a.ts', roots)).toBe('authx');
    expect(longestPrefixPackage('file:///repo/readme.md', roots)).toBe('top');
    expect(longestPrefixPackage('file:///other/x', roots)).toBeUndefined();
  });
  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('compares case-insensitively through uriKey on macOS and Windows', () => {
    const roots = new Map([['auth', uriKey(Uri.file('/Repo/Services/Auth') as never)]]);
    expect(longestPrefixPackage(uriKey(Uri.file('/repo/services/auth/x.ts') as never), roots)).toBe('auth');
  });
});

describe('nested Sidestory folders', () => {
  it('are rejected below the workspace folder', () => {
    workspace.root = Uri.file('/repo');
    expect(refFromDir(Uri.file('/repo/.sidestory/x') as never)).toBeDefined();
    expect(refFromDir(Uri.file('/repo/.sidestory/x/.sidestory/y') as never)).toBeUndefined();
  });
});
