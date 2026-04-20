param(
  [string]$BaseBranch = "main",
  [switch]$Rebase,
  [switch]$Push
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
  param([string[]]$Args)

  Write-Host "> git $($Args -join ' ')"
  & git @Args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Args -join ' ') failed with exit code $LASTEXITCODE"
  }
}

$insideWorkTree = (& git rev-parse --is-inside-work-tree 2>$null)
if ($LASTEXITCODE -ne 0 -or $insideWorkTree.Trim() -ne "true") {
  throw "Run this script inside the repository root."
}

$originUrl = (& git remote get-url origin 2>$null)
if ($LASTEXITCODE -ne 0) {
  throw "Remote 'origin' is not configured."
}

$upstreamUrl = (& git remote get-url upstream 2>$null)
if ($LASTEXITCODE -ne 0) {
  throw "Remote 'upstream' is not configured."
}

$status = (& git status --porcelain)
if ($LASTEXITCODE -ne 0) {
  throw "Unable to read git status."
}
if ($status) {
  throw "Working tree is not clean. Commit or stash local changes before syncing upstream."
}

$startingBranch = (& git branch --show-current).Trim()
if (-not $startingBranch) {
  throw "Unable to detect the current branch."
}

Invoke-Git @("fetch", "upstream", $BaseBranch)

if ($startingBranch -ne $BaseBranch) {
  Invoke-Git @("checkout", $BaseBranch)
}

if ($Rebase) {
  Invoke-Git @("rebase", "upstream/$BaseBranch")
} else {
  Invoke-Git @("merge", "--no-ff", "--no-edit", "upstream/$BaseBranch")
}

if ($Push) {
  Invoke-Git @("push", "origin", $BaseBranch)
}

if ($startingBranch -ne $BaseBranch) {
  Invoke-Git @("checkout", $startingBranch)
}

Write-Host ""
Write-Host "Upstream sync complete."
Write-Host "origin   = $originUrl"
Write-Host "upstream = $upstreamUrl"
