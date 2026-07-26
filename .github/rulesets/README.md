# Branch rulesets

These JSON files are the versioned source of truth for the repository's
GitHub rulesets. GitHub does not read them automatically — import them once:

1. GitHub → **Settings → Rules → Rulesets**
2. **New ruleset ▾ → Import a ruleset**
3. Pick `main.json`, save, then repeat with `all-branches.json`.

## What they enforce

### `protect-main` (default branch, no bypass)

- No branch deletion.
- No force pushes — history on `main` is immutable for everyone, including
  admins (temporarily disable the ruleset if you ever truly need to rewrite).
- Linear history required — merge PRs with *squash* or *rebase*, not merge
  commits.

### `protect-all-branches` (every branch, admin bypass)

- No branch deletion and no force pushes **for future collaborators**.
- Repository admins bypass both rules, so the owner can still force-push WIP
  branches and delete merged ones freely.

Rules from both rulesets combine on `main`; the most restrictive one wins,
so `main` stays hard-protected regardless of the bypass above.

## Later, when collaborators join

Add a `pull_request` rule to `main.json` (then re-import or edit in the UI)
to require PRs and one approving review before merging:

```json
{
  "type": "pull_request",
  "parameters": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews_on_push": true,
    "require_code_owner_review": false,
    "require_last_push_approval": false,
    "required_review_thread_resolution": false
  }
}
```
