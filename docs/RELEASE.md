# Releasing

Status: **prepared, not released.** Everything below up to "Publish" is done and checked; publishing waits for the publisher ID and repository URL.

## Before the first release (needs the owner)

1. **Publisher.** Create (or pick) a publisher at <https://marketplace.visualstudio.com/manage>, then set `"publisher"` in `package.json` (now the placeholder `sidestory`). The extension's id becomes `<publisher>.sidestory`.
2. **Repository.** Add to `package.json`:
   ```json
   "repository": { "type": "git", "url": "https://github.com/<owner>/<repo>.git" },
   "bugs": { "url": "https://github.com/<owner>/<repo>/issues" },
   "homepage": "https://github.com/<owner>/<repo>#readme"
   ```
   (done: github.com/mozru/sidestory; the `package` script no longer needs `--allow-missing-repository`).
3. **SECURITY.md** asks for vulnerability reports by email (it is in the published package). Keep that, or switch to the repository's private vulnerability reporting (GitHub → Settings → Security) once it exists.

## Checks (all passing at 81db349)

Run from a clean install; this is what CI runs (`.github/workflows/ci.yml`):

```bash
npm ci
npm run typecheck
npm test                                        # 224 unit tests
npm audit --omit=dev --audit-level=moderate     # 0 vulnerabilities
npm run build && npm run test:webview           # 59 panel tests
npm run package                                 # dist/sidestory.vsix, must be < 1 MB (222 KB)
npm run test:e2e                                # 11 tests in browser VS Code; needs Docker
```

Then the manual checks in [TEST-PLAN.md](TEST-PLAN.md) (Remote-SSH, desktop VS Code, navigation and Pin dialogs).

The package was inspected: 13 files (extension bundle, webview bundle, codicons, icon, README, CHANGELOG, SECURITY, LICENSE); no source maps, tests or fixtures; the only external modules are `vscode` and Node built-ins (zod, idiomorph and jsonc-parser are bundled).

## Publish (not done)

1. In `CHANGELOG.md`, change `## 0.1.0 (unreleased)` to the release date.
2. `npm run package` and install `dist/sidestory.vsix` locally once more (**Extensions: Install from VSIX…**).
3. Commit, tag `v0.1.0`, push the tag.
4. `npx vsce publish --packagePath dist/sidestory.vsix` with a Personal Access Token for the publisher (Azure DevOps, scope *Marketplace › Manage*). Optionally also Open VSX: `npx ovsx publish dist/sidestory.vsix -p <token>`.
5. Attach the `.vsix` to a GitHub release for the tag.

The extension is marked `"preview": true`, so the Marketplace shows it as Preview; drop that for 1.0.

## Known gaps in 0.1.0

- Code moved to another file shows "Code not found" (no symbol-aware search yet).
- Pin's checklist shows the first line of the code, not a diff.
- What the sanitizer removes isn't reported in the Output channel.
