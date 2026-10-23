// Quoting for commands the user pastes into a shell (Copy Widget Check Command). Folder names come from the
// repository, so a name that could carry shell syntax is refused rather than quoted cleverly.

/** Paths the checker command may name: letters, digits, spaces and a few separators, nothing a shell interprets. */
export function shellSafePath(p: string): boolean {
  return /^[A-Za-z0-9._ /-]+$/.test(p) && !p.split('/').includes('..');
}

/** Quotes a path for the platform's shell: POSIX single quotes; on Windows double quotes (names never hold % ! ^ "). */
export function shellQuote(p: string, platform: string = process.platform): string {
  if (platform === 'win32') return `"${p.replace(/"/g, '')}"`;
  return `'${p.replace(/'/g, "'\\''")}'`;
}
