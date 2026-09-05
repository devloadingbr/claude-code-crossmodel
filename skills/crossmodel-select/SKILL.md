---
name: crossmodel-select
description: "Configure crossmodel's ROLE-based routing — for each function (write, review, explore, ...), pick and order the aliases that handle it, verify each with a real call, and write ~/.claude/crossmodel/roles.json. Use when the user wants to define which model writes code, which one reviews adversarially, which one explores a repo, when they mention '/crossmodel-select', or when they want to change the existing write/review/explore assignment."
---

# crossmodel select

Turn "which model does what" into a written, verified policy — `~/.claude/crossmodel/roles.json` — instead of the user re-deciding it in their head every time they delegate.

This is a DIFFERENT file from `crossmodel.config.json` (which models exist) and `mode.json`
(saver-mode bias). Roles sit on top of both: a role names a JOB, and points at aliases
that must already work (`crossmodel --list` should show them `ok` first — if one is not
configured yet, send the user to `/crossmodel-setup` before continuing here).

## Step 1 — show what exists

```bash
crossmodel role status
```

If this is the first run, it prints the built-in defaults (`write`, `review`, `explore`)
rather than nothing — say so, and ask whether the user wants to keep them, rename one, or
start over. Never assume "no file yet" means "no opinion yet".

## Step 2 — the two policies are NOT interchangeable

Ask, for each role, whether it wants:

- **priority** — an ordered preference with fallback. Use when there is a real "best
  choice, then a fallback if that one's quota is out" — e.g. `write: luna, qwen`.
- **round-robin** — alternate every call, on purpose. Use when the point is spreading
  load or avoiding the same model twice in a row — e.g. `review: glm, gem`, so a plan
  never gets rubber-stamped by the model that could have written it.

Picking round-robin for `write` would rotate implementations across models for no
reason; picking priority for `review` would silently favor one reviewer forever. Get
this wrong and the mechanism produces the OPPOSITE of what the user asked for — ask
explicitly, do not infer it from the model names.

## Step 3 — QUOTA GROUP awareness, out loud

Before finalizing an order, say which aliases actually share a subscription. Today:

- `sol`, `terra`, `luna`, `astra` → one ChatGPT/codex quota
- `qwen`, `glm` → one OpenCode Go subscription ($10/mo)
- `cgrok`, `cgrok-x` → one Cursor subscription
- `gem` → Antigravity, its own pool
- `grok` → xAI, its own pool

Putting two aliases from the SAME group in one role's fallback order (e.g. `luna` then
`sol`) accomplishes nothing — when the group is out, both are out together. Flag this if
the user proposes it; a fallback only helps across DIFFERENT groups.

## Step 4 — never route the orchestrator into its own fallback

`opus`, `sonnet`, `haiku` (the `claude` provider) must not appear in any role's order.
Routing "the model orchestrating this" back into its own delegation chain spends exactly
the quota crossmodel exists to protect, and — per external review of this design
(gpt-6-astra, 2026-09-04) — another Claude Code instance under the same plan shares that
plan's usage, so it does not even diversify quota the way the other providers do. It can
be called directly, by name (`--model opus`), for a deliberate one-off reason; it is never
a silent destination when every other option is exhausted.

## Step 5 — verify every alias with a real call before saving

For each alias about to go into the file:

```bash
crossmodel --model <alias> "Reply with only the number: 6*7"
```

Expect `42`, exit 0. An alias that fails here does not go into roles.json — a role whose
first candidate is broken silently degrades to whatever is next, and nobody finds out
until output quality drops.

## Step 6 — write the file

```json
{
  "roles": {
    "write":   { "policy": "priority",    "order": ["luna", "qwen"] },
    "review":  { "policy": "round-robin", "order": ["glm", "gem"] },
    "explore": { "policy": "priority",    "order": ["qwen", "flash"] }
  }
}
```

Merge with what is already there — do not drop a role the user did not ask to change.
Confirm with `crossmodel role status` afterward; it re-validates every alias against the
live model list and flags anything that stopped existing.

## Step 7 — explain how it actually gets used

```bash
crossmodel --role write --cwd <dir> "..."
crossmodel --role review --cwd <dir> "..."
```

Tell the user honestly what this build does and does NOT do:

- **Does:** before dispatching, skips any candidate whose quota GROUP is already known
  to be exhausted (from a previous call's failure), and — for round-robin — alternates
  which candidate goes first, so load spreads across both instead of hammering one.
- **Does not (yet):** chain through the whole order within a SINGLE invocation. A quota
  failure is recorded for next time; the current call still exits non-zero and tells you
  which alias to expect on the next `--role` call. Re-running is intentional, one
  deliberate step, not an automatic multi-hop retry — this was a scoping choice to avoid
  silently re-attempting a `--write` run on top of a partially-edited tree.
- If a `--write` run under a role fails, crossmodel checks the git tree itself: if it
  changed, it refuses to suggest just re-running the role and tells the user to inspect
  the diff first.

`crossmodel role status` shows which quota groups are currently open (temporarily
skipped) and until when — check it before assuming a role "isn't working right".
