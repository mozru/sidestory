// Login: check the password, then hand out a session token.
import { issueToken, type Token } from './tokens.ts';

export interface User {
  name: string;
  passwordHash: string;
}

export async function login(user: User, password: string, verify: (hash: string, password: string) => Promise<boolean>): Promise<Token | null> {
  if (!(await verify(user.passwordHash, password))) return null;
  return issueToken();
}
