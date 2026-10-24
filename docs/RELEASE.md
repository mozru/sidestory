# Releasing

Publisher: **paperkite** (<https://marketplace.visualstudio.com/manage/publishers/paperkite>); the extension id is `paperkite.sidestory`.

## Cutting a release

1. Under `## Unreleased` at the top of `CHANGELOG.md`, list what changed. These notes become the GitHub release notes and the Marketplace's Changelog tab. The first release's heading is `## 0.1.0 (unreleased)`.
2. On an up-to-date `main` with a clean tree:

   ```bash
   npm run release -- patch        # or minor, major, or an exact version such as 0.1.0
   ```

   This dates the CHANGELOG section, sets the version in `package.json` and `package-lock.json`, commits "Release vX.Y.Z", tags `vX.Y.Z`, and pushes `main` and the tag. Add `--dry-run` to see what it would do, or `--no-push` to push yourself.
3. The tag starts the [Release workflow](../.github/workflows/release.yml). It:
   - checks the tag against `package.json` and the CHANGELOG;
   - runs the whole CI matrix;
   - takes the `.vsix` that CI built and tested;
   - publishes it to the Marketplace, if a credential is set up (see below);
   - creates a GitHub release with `sidestory.vsix` attached.

If the release script fails, it puts the files back, or prints the exact command to undo its commit and tag. If the workflow fails before publishing:
1. Fix the problem on `main`.
2. Delete the tag: `git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`.
3. In `CHANGELOG.md`, rename the dated heading back to `## Unreleased`.
4. Release the same version again: `npm run release -- X.Y.Z`.

If it fails after publishing, use **Re-run failed jobs** (not all jobs) on the workflow run: a version already on the Marketplace is skipped, and the `.vsix` is attached to an existing GitHub release.

The Marketplace accepts only `major.minor.patch` versions, and each version only once. `"preview": true` in `package.json` shows the extension as Preview; remove it for 1.0.

## Publishing manually

Without a credential, the workflow skips the Marketplace step with a warning. Download `sidestory.vsix` from the GitHub release and upload it on the publisher page: **+ New extension → Visual Studio Code** the first time, then **⋯ → Update** for each later version.

## Automatic publishing (set up once)

The `publish` job runs in a GitHub environment named `marketplace`. Create it in the repository's Settings → Environments, and protect it:
- **Deployment branches and tags:** *Selected*, then add a **tag** rule `v*.*.*`, so only release tags can use its credentials.
- **Required reviewers (optional):** you approve each release before it publishes.

Then give it one credential:

- **Microsoft Entra ID (recommended; no stored secret).** This follows the managed-identity steps in [Publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension); it needs an Azure subscription.
  1. Create a *user-assigned managed identity* in Azure.
  2. Under its Federated credentials, add a GitHub Actions credential: organization `mozru`, repository `sidestory`, entity *Environment*, name `marketplace`.
  3. Give the identity a Marketplace profile and find its id. This must run *as the identity*; your own sign-in (Cloud Shell included) isn't. Either:
     - on an Azure VM the identity is attached to, run `az login --identity --client-id <client id> --allow-no-subscriptions` first; or
     - in GitHub, add a throwaway workflow (`on: workflow_dispatch`, `environment: marketplace`, `permissions: id-token: write`), with the *Sign in with Microsoft Entra ID* step from release.yml followed by the command below. Then temporarily allow `main` in the environment's deployment rule, run the workflow once, and undo both.

     The command:
     ```bash
     az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798
     ```
     The `id` field is the identity's id.
  4. On the publisher page, Members → Add, enter that id, and give it the *Contributor* role.
  5. In the `marketplace` environment, add the *variables* (not secrets) `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`: the identity's client id and its tenant.

  The workflow then signs in with GitHub's OIDC token and runs `vsce publish --azure-credential`.
- **A token (simpler, short-lived option).** Create it on dev.azure.com: User settings → Personal access tokens → New Token, with Organization *All accessible organizations* and Scopes *Marketplace › Manage*. Save it as the environment *secret* `VSCE_PAT`. Microsoft retires these all-organization tokens on **2026-12-01**, so this works only until then.

If both are set, the token is used. vsce 4 also has an undocumented `--oidc` mode (Marketplace trusted publishing, with no Azure at all); switch to it once Microsoft documents it.

## Checks

CI ([ci.yml](../.github/workflows/ci.yml)) runs on every push, and in full before each release. To run the same checks locally:

```bash
npm ci
npm run typecheck
npm test                                        # unit tests
npm audit --omit=dev --audit-level=moderate
npm run build && npm run test:webview && npm run test:widgets
npm run package                                 # dist/sidestory.vsix, must be < 3 MB
npm run test:e2e                                # browser VS Code; needs Docker
npm run test:desktop                            # desktop VS Code
```

Before a big release, also do the manual checks in [TEST-PLAN.md](TEST-PLAN.md): Remote-SSH, navigation and the Pin dialogs.

## Known gaps

- Code moved to another file shows "Code not found" (no symbol-aware search yet).
- Pin's checklist shows the first line of the code, not a diff.
- What the sanitizer removes isn't reported in the Output channel.
