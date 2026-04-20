# Fork Upstream Sync

This fork keeps two remotes:

- `origin`: `https://github.com/ericwgz/WeFlow.git`
- `upstream`: `https://github.com/hicccc77/WeFlow.git`

Use the helper script when you want to manually bring in upstream changes.

## Merge upstream into `main`

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync-upstream.ps1
```

## Rebase `main` onto upstream

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync-upstream.ps1 -Rebase
```

## Sync and push to your fork

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync-upstream.ps1 -Push
```

The script requires a clean working tree before syncing.
