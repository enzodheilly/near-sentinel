# Backlog as code

`backlog.mjs` is the source of truth for the project's sprints (milestones), labels and issues. `sync.mjs` pushes it to GitHub through the `gh` CLI and is idempotent: it creates what is missing, updates issue bodies, and never duplicates a title.

```bash
node .github/backlog/sync.mjs --dry   # validate the spec, print what would be sent
node .github/backlog/sync.mjs         # sync to GitHub
```

Workflow: each task is closed by the commit or pull request that ships it (`Closes #<n>`), so the project board moves it to Done automatically.
