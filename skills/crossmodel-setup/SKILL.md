---
name: crossmodel-setup
description: "Set up or reconfigure crossmodel — detect which provider CLIs are installed, register the models you want as short aliases, verify each one with a real call, and write the config. Use when crossmodel is freshly installed, when `--list` shows nothing usable, when you have installed a new provider CLI, or when the user asks to add, remove or rename a model alias."
---

# crossmodel setup

Get the user from "installed" to "working" without making them hand-write JSON.

Do this **interactively and in order**. Never write a config for a provider you have not
confirmed is installed and answering — a config full of aliases that fail on first use is
worse than an empty one.

## Locate the plugin

The CLI lives at `$CLAUDE_PLUGIN_ROOT/bin/crossmodel.mjs`. If that variable is not set:

```bash
find ~/.claude/plugins -name crossmodel.mjs -path '*crossmodel*' 2>/dev/null | head -1
```

Use that path for the rest of the session. Everything below assumes `$CM` holds it.

## Step 1 — see what is already there

```bash
node "$CM" --list
```

Aliases marked `ok` already work. If the user only wants to add one model, skip to
step 3 rather than redoing everything.

## Step 2 — detect installed providers

```bash
for b in codex grok agent opencode gemini ollama claude; do
  printf '%-9s ' "$b"; command -v $b >/dev/null && echo installed || echo "not installed"
done
```

For each **installed** provider, check authentication before going further:

| Provider | Check | If not authenticated |
|---|---|---|
| `codex` | `codex login status` | Tell the user to run `codex login` themselves — it is an account OAuth flow and you must not do it for them |
| `grok` | `grok models` | Tell the user to run `grok login` themselves (browser OAuth), or to export `XAI_API_KEY`. Needs a SuperGrok or X Premium+ subscription |
| `agent` (Cursor) | `agent status` then `agent --list-models` | Tell the user to run `agent login` themselves (browser OAuth), or to export `CURSOR_API_KEY`. Never pass `--api-key` on a command line — it lands in `ps` for every user on the machine |
| `opencode` | `opencode models` | Some models need no auth at all — the list includes free ones. For a paid provider (OpenRouter, OpenAI…) tell the user to run `opencode auth login` themselves; same principle |
| `gemini` | provider's own auth command | same principle |
| `ollama` | `ollama list` | no auth; if the list is empty they need to pull a model first |

`opencode` is worth offering even when `codex` is present: it is provider-neutral, so it
reaches OpenRouter, Ollama and any OpenAI-compatible endpoint through one adapter. Its
model strings are `provider/model` exactly as `opencode models` prints them — never invent
one. Its `--write` runs under the policy in `~/.claude/crossmodel/permissions.json`, which
allows the agent to work and denies git's writing verbs — nothing else.

`grok` is a third quota pool. One thing to say out loud: its argument shape in
`providers.mjs` came from xAI's published docs and **has not been verified against a real
run**, so the first call is the verification.

```bash
curl -fsSL https://x.ai/cli/install.sh | bash   # or: npm install -g @xai-official/grok
```

The **Cursor CLI** (binary `agent`) is a fourth pool and often the cheapest one to add,
because a Cursor subscription is something many people already pay for and it carries Grok,
GPT, Claude and Kimi behind one bill. Verified working on `agent 2026.08.11`. Two things to
say when you register it:

- Reasoning effort is part of the model id (`cursor-grok-4.6-high`, `…-xhigh`, each with an
  optional `-fast`), not a flag — so the alias IS the effort tier. `agent --list-models` is
  the authority; never invent an id.
- It writes freely inside `--cwd`, like every provider here. crossmodel imposes exactly one
  rule anywhere — git history stays the orchestrator's — and permits everything the agent
  needs to do the work and prove it: build, tests, package managers, the lot.

```bash
curl https://cursor.com/install -fsS | bash && agent login
```

If nothing is installed, stop and recommend one. The cheapest entry point is Codex,
because it authenticates with a ChatGPT subscription rather than a metered API key:

```bash
npm install -g @openai/codex && codex login
```

## Step 3 — choose the models

Ask the user which models they want and what to call them. Keep aliases short: they get
typed constantly, and they appear in the routing policy.

For providers you cannot enumerate programmatically, ask the user which model IDs their
plan gives them rather than guessing — a wrong model ID fails at call time with a
confusing error.

Suggest **at least two tiers**, because the whole point is routing between them:

- a cheap, high-quota model for volume — sweeps, code from a spec, classification
- a stronger one for judgement — final review, tie-breaks

## Step 4 — write the config

Write `~/.claude/crossmodel/crossmodel.config.json`. Merge with what is already there;
never clobber aliases the user already had.

🔴 **In `$HOME`, not in the plugin directory.** The plugin installs under a versioned path
(`.../cache/<mkt>/<plugin>/<version>/`), so a config written there is destroyed by the next
update and the user silently drops back to the built-in aliases. The plugin directory is
still searched as a legacy fallback; if you find a config there, offer to move it.

```json
{
  "models": {
    "fast": { "provider": "codex", "model": "<model-id>" },
    "smart": { "provider": "codex", "model": "<model-id>" }
  }
}
```

Only add a `providers` block if they are wiring up a CLI that is not built in. In that
case it needs `bin`, an `args` builder, and honest `supportsWrite` / `supportsSchema`
flags — and `args` cannot be expressed in JSON, so it belongs in `providers.mjs` as a PR,
not in user config.

## Step 5 — verify with a real call. Do not skip this.

For every alias you registered:

```bash
node "$CM" --model <alias> "Reply with only the number: 6*7"
```

Expect `42` and exit code 0. If it fails, fix the model ID or the auth and retry — **do
not leave a broken alias in the config**. Report exactly which aliases you verified.

Then confirm the capability that matters most:

```bash
node "$CM" --model <alias> --cwd <some repo> "Name three files in this directory. List only."
```

If that works, the model can sweep a repo on its own quota, which is the main reason to
use this plugin at all.

## Step 6 — routing policy

Copy `routing.example.json` to `~/.claude/crossmodel/routing.json` and edit the model names
to match the aliases just created.

Be explicit with the user about `measured`:

- `"measured": false` — the `#route` hook prints a warning that the policy is a guess.
  This is the honest default.
- `"measured": true` — only after they have run `bench/battery.mjs` on tasks that
  resemble their real work. Setting it true without doing that only fools them later.

## Step 7 — offer the project primer (ask first)

A future session in this project will not know crossmodel exists unless something tells
it. `crossmodel teach` writes a short primer into the project's `CLAUDE.md`, between
`BEGIN`/`END` markers, naming the aliases that actually work here.

**Ask before running it, and do not run it unprompted.** `CLAUDE.md` is versioned: it ships
to everyone who clones the repo, and the user may not want plugin instructions committed
for teammates who do not have it installed.

```bash
crossmodel teach --dry-run     # show them exactly what it adds
crossmodel teach               # only after they say yes
```

Re-running updates the block in place; deleting the marker lines removes it. Nothing
outside the markers is touched, and a half-written marker pair is refused rather than
guessed at. If they decline, say the `#route` trigger and saver mode already work without
it — the primer is convenience, not a requirement.

## Step 8 — hand off

Tell the user:

1. Which aliases are live, and which one is the cheap tier vs the strong tier.
2. That `#route` in any prompt injects the routing policy for that turn.
3. That a new plugin config is read at session start, so they should restart.
4. That `node bench/battery.mjs --list` costs nothing, and a real run costs quota.

## Rules

- **Never run an account login flow.** Print the command and let the user run it.
- **Never write a config entry you did not verify with a real call.**
- **Never invent model IDs.** Ask, or read the provider's own listing command.
- Keep the summary short. The user wants "these three work", not a transcript.
