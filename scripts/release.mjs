// Cuts a release: bumps the version, dates the CHANGELOG section, commits, tags and pushes.
// The pushed tag starts .github/workflows/release.yml, which tests, packages and publishes.
//
//   npm run release -- patch|minor|major|<x.y.z> [--dry-run] [--no-push]
//
// The CHANGELOG must start with a section for the new release, headed "## Unreleased" or
// "## <version> (unreleased)"; it becomes "## <version> (<date>)" and is the release notes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const push = !args.includes('--no-push');
const bump = args.find((a) => !a.startsWith('--'));
// The Marketplace accepts only major.minor.patch, no pre-release suffixes.
const PLAIN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const run = (cmd, ...a) => {
  console.log(`$ ${cmd} ${a.join(' ')}`);
  if (dryRun) return;
  // npm through node itself: no shell, so arguments are passed as they are on Windows too.
  if (cmd !== 'npm') execFileSync(cmd, a, { stdio: 'inherit' });
  else if (process.env.npm_execpath) execFileSync(process.execPath, [process.env.npm_execpath, ...a], { stdio: 'inherit' });
  // Run directly with node on Windows: npm is npm.cmd, which needs a shell (the arguments here are fixed or validated).
  else execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', a, { stdio: 'inherit', shell: process.platform === 'win32' });
};
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

if (!bump) fail('usage: npm run release -- patch|minor|major|<x.y.z> [--dry-run] [--no-push]');

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!PLAIN.test(current)) fail(`package.json's version ${current} isn't major.minor.patch`);
const version = nextVersion(current, bump);
const tag = `v${version}`;

if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('releases are cut from main');
if (git('status', '--porcelain')) fail('the working tree has uncommitted changes');
try {
  git('fetch', '--quiet', 'origin', 'main', '--tags');
} catch {
  fail("couldn't fetch main and tags from origin (see git's message above)");
}
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main is not the same as origin/main; pull first');
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`);

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const heading = /^## (?:Unreleased|(\d+\.\d+\.\d+) \(unreleased\))[ \t]*(?=\r?$)/im;
const m = changelog.match(heading);
if (!m) fail('CHANGELOG.md has no "## Unreleased" section to release');
if (m[1] && m[1] !== version) fail(`CHANGELOG.md's unreleased section is for ${m[1]}, not ${version}`);
const body = changelog.slice(m.index + m[0].length).split(/^## /m)[0].trim();
if (!body) fail('the unreleased section in CHANGELOG.md is empty');

const date = new Date().toISOString().slice(0, 10);
console.log(`Releasing ${current} → ${version} (${date}, UTC)${dryRun ? ' [dry run]' : ''}`);

let stage = 'files';
try {
  if (!dryRun) writeFileSync('CHANGELOG.md', changelog.replace(heading, `## ${version} (${date})`));
  console.log(`CHANGELOG.md: "${m[0]}" → "## ${version} (${date})"`);
  // Updates package.json and package-lock.json together.
  run('npm', 'version', version, '--no-git-tag-version', '--allow-same-version');
  run('git', 'add', 'package.json', 'package-lock.json', 'CHANGELOG.md');
  run('git', 'commit', '--quiet', '-m', `Release ${tag}`);
  stage = 'commit';
  run('git', 'tag', '-a', tag, '-m', `Sidestory ${version}`);
  stage = 'tag';
  if (push) {
    // Only main and the new tag (never other local tags, whatever push.followTags says); the tag starts the release workflow.
    run('git', 'push', '--atomic', '--no-follow-tags', 'origin', 'refs/heads/main:refs/heads/main', `refs/tags/${tag}:refs/tags/${tag}`);
    if (!dryRun) console.log('Pushed. Follow the release at https://github.com/mozru/sidestory/actions/workflows/release.yml');
  } else {
    console.log(`Not pushed. To release: git push --atomic --no-follow-tags origin refs/heads/main:refs/heads/main refs/tags/${tag}:refs/tags/${tag}`);
  }
} catch (e) {
  if (stage === 'files') {
    git('reset', '--quiet', '--', 'package.json', 'package-lock.json', 'CHANGELOG.md');
    git('checkout', 'HEAD', '--', 'package.json', 'package-lock.json', 'CHANGELOG.md');
    fail(`${e.message.split('\n')[0]}\nNothing was committed; the files are back as they were.`);
  }
  const undo = stage === 'tag' ? `git tag -d ${tag} && git reset --hard HEAD~1` : 'git reset --hard HEAD~1';
  fail(`${e.message.split('\n')[0]}\nNothing was pushed. To undo the release commit${stage === 'tag' ? ' and tag' : ''}: ${undo}`);
}

function nextVersion(from, how) {
  const [major, minor, patch] = from.split('.').map(Number);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (!PLAIN.test(how)) fail(`not a version (major.minor.patch) or bump: ${how}`);
  const cmp = how.split('.').map(Number).reduce((c, n, i) => c || n - [major, minor, patch][i], 0);
  // The same version is allowed once, for a first release that was never tagged.
  if (cmp < 0) fail(`${how} is lower than the current version ${from}`);
  return how;
}
