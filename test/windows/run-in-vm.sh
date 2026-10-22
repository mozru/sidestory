#!/bin/sh
# Runs the test suites on the local Windows 11 ARM64 test VM (see docs/TEST-PLAN.md, "Windows VM").
# The committed HEAD is cloned in the VM with Git for Windows' defaults, so files are CRLF as in a real
# Windows checkout (the working tree, including uncommitted changes). Usage: test/windows/run-in-vm.sh [unit|panel|desktop|all]   (default: all)
set -e
WHAT=${1:-all}
VMDIR=${CX_WIN_VM_DIR:-$HOME/VMs/windows}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SSH="ssh -i $VMDIR/id_ed25519 -p 2222 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$VMDIR/known_hosts -o ConnectTimeout=10 cx@127.0.0.1"
SCP="scp -q -i $VMDIR/id_ed25519 -P 2222 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$VMDIR/known_hosts"
ps() { $SSH "$1" || true; }

# The working tree as it is (tracked and new files, minus .gitignore), as a throwaway commit made with a
# temporary index, so uncommitted fixes can be tested without touching the real index or HEAD.
TMPIDX=$(mktemp); cp "$ROOT/.git/index" "$TMPIDX"
GIT_INDEX_FILE=$TMPIDX git -C "$ROOT" add -A
TREE=$(GIT_INDEX_FILE=$TMPIDX git -C "$ROOT" write-tree); rm -f "$TMPIDX"
SNAP=$(git -C "$ROOT" commit-tree "$TREE" -p HEAD -m "working tree for the Windows VM")
git -C "$ROOT" update-ref refs/cx/windows-vm "$SNAP"
echo "== copying the working tree (on $(git -C "$ROOT" rev-parse --short HEAD)) to the VM"
git -C "$ROOT" bundle create /tmp/cx-repo.bundle refs/cx/windows-vm >/dev/null 2>&1
$SCP /tmp/cx-repo.bundle cx@127.0.0.1:C:/Users/cx/cx-repo.bundle
ps '$ErrorActionPreference = "Continue"
if (Test-Path C:\work\ce) { Remove-Item C:\work\ce -Recurse -Force }
New-Item -ItemType Directory -Force C:\work | Out-Null
git -c advice.detachedHead=false clone -q -b refs/cx/windows-vm C:\Users\cx\cx-repo.bundle C:\work\ce 2>$null; if (-not (Test-Path C:\work\ce\package.json)) { git init -q C:\work\ce; git -C C:\work\ce fetch -q C:\Users\cx\cx-repo.bundle refs/cx/windows-vm; git -C C:\work\ce checkout -q FETCH_HEAD }
Set-Location C:\work\ce
"line endings: " + ((Get-Content -Raw fixtures\sample-workspace\rtl\bit_reader.sv) -match "`r`n")
npm.cmd ci --no-audit --no-fund 2>&1 | Select-Object -Last 2'

if [ "$WHAT" = all ] || [ "$WHAT" = unit ]; then
  echo "== typecheck and unit tests (Windows)"
  ps 'Set-Location C:\work\ce; npm.cmd run typecheck 2>&1 | Select-Object -Last 3; npm.cmd test 2>&1 | Select-String -Pattern "Test Files|Tests |FAIL|×" | Select-Object -First 40'
fi

if [ "$WHAT" = all ] || [ "$WHAT" = panel ]; then
  echo "== panel and widget-frame tests (Windows, Chromium)"
  ps 'Set-Location C:\work\ce; npm.cmd run build 2>&1 | Out-Null; npx.cmd playwright install chromium 2>&1 | Out-Null
npm.cmd run test:webview 2>&1 | Select-String -Pattern "passed|failed|flaky|^\s+\d+\) " | Select-Object -First 40
npm.cmd run test:widgets 2>&1 | Select-String -Pattern "passed|failed|flaky|^\s+\d+\) " | Select-Object -First 40'
fi

if [ "$WHAT" = all ] || [ "$WHAT" = desktop ]; then
  # Electron needs the interactive desktop, which SSH sessions don't have: run it as a task in the
  # auto-logged-in user's session and collect its log.
  echo "== desktop VS Code (Windows, oldest supported and stable, LF and CRLF)"
  ps 'Set-Location C:\work\ce; npm.cmd run build 2>&1 | Out-Null
$cmd = "cmd /c cd /d C:\work\ce && (node test\desktop\run.mjs --version 1.95.0 && node test\desktop\run.mjs --version stable) > C:\work\desktop.log 2>&1 & echo done> C:\work\desktop.done"
Remove-Item C:\work\desktop.done -ErrorAction SilentlyContinue
schtasks /create /tn cxdesktop /tr $cmd /sc once /st 00:00 /ru cx /it /f | Out-Null
schtasks /run /tn cxdesktop | Out-Null
for ($i = 0; $i -lt 180 -and -not (Test-Path C:\work\desktop.done); $i++) { Start-Sleep 5 }
Get-Content C:\work\desktop.log | Select-String -Pattern "==|passing|failing|pending|^\s+\d+\) |AssertionError|timed out|Error:" | Select-Object -First 60'
fi
