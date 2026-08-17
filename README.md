# crossmodel

**Delegate work from Claude Code to another agentic CLI — they write, you review and commit.**

Claude Code is excellent at orchestrating. It is also the only thing spending your
Anthropic quota. `crossmodel` hands work to an external agentic CLI — OpenAI's Codex, xAI's
Grok Build, the Cursor CLI, or OpenCode and through it OpenRouter, Ollama and anything
OpenAI-compatible — so it bills to *that* provider's pool instead.

"Agentic" is the load-bearing word. These are not chat endpoints: point one at a
directory and it greps and reads the tree itself, and with `--write` it edits inside that
directory. A repo-wide sweep costs their quota, not yours.

The catch nobody addresses: **how do you know what the cheap model can actually do?**
So this ships with a deterministic benchmark. No LLM judges another LLM; a test suite
decides.

> **Status: v0.11.0, early.** Works, tested end to end, but the API may move. Issues and
> PRs welcome.

---

## Install

```bash
/plugin marketplace add devloadingbr/claude-code-crossmodel
/plugin install crossmodel@crossmodel
```

Restart, then run:

```
/crossmodel-setup
```

That detects which provider CLIs you have, asks which models you want and what to call
them, **verifies each one with a real call**, and writes the config. No hand-edited JSON,
and no alias left in the file that fails the first time you use it.

You need at least one provider installed. Three good entry points:

```bash
npm install -g opencode-ai      # free models available with no key at all
npm install -g @openai/codex    # then: codex login
curl -fsSL https://x.ai/cli/install.sh | bash
# or: npm i -g @xai-official/grok
```

**OpenCode** costs nothing to try — `opencode models` lists free models that need no
account, and the shipped `flash` alias uses one. It is also provider-neutral, so the same
binary later reaches OpenRouter, Ollama or any OpenAI-compatible endpoint.

**Codex** is the one whose OS sandbox makes `.git/` read-only, so a `--write` run can
edit and cannot commit. Writing itself is not reserved for it. It bills to a ChatGPT
subscription rather than a metered API key.

**Grok Build** is documented by xAI as an agentic CLI. 🟡 Documentation-only, not measured
here (docs.x.ai/build, read 2026-08-12). It needs a SuperGrok or X Premium+ subscription;
headless auth uses `XAI_API_KEY`. crossmodel ships one alias, `grok`, for
`grok-build-0.1`; `grok models` lists the rest, which you can add through
`crossmodel.config.json`.

Prefer to configure by hand? Copy `crossmodel.config.example.json` to
`~/.claude/crossmodel/crossmodel.config.json`. The setup skill just does this for you, with
verification. The home-directory file is checked first; a plugin-local
`crossmodel.config.json` remains a legacy fallback. Do not put the working copy next to
`lib/providers.mjs`: plugin updates replace the versioned plugin directory.

---

## Cursor as orchestrator

The same CLI, the other way around: the Cursor agent calls Codex and the Claude Code CLI,
spending *their* quota instead of this chat's.

```bash
# from this checkout, once per machine
node bin/crossmodel.mjs install --host cursor
```

That writes four things in `$HOME`, never in a project repo:

- a shim at `~/.local/bin/crossmodel` so the agent can find the binary (add that dir to PATH if it is not already)
- an always-on user rule at `~/.cursor/rules/crossmodel.mdc` — call the CLI from Shell, do not use the Task `delegate` subagent to save quota
- the setup skill at `~/.cursor/skills/crossmodel-setup/`
- a user enforcement hook at `~/.cursor/hooks/crossmodel-enforce`, registered in `~/.cursor/hooks.json`, so native Grep/Glob/Task sweeps use the external CLI

The hook denies native Grep and Glob, plus Task `explore`/`delegate`/`probe`; Grep of a
single file still works so the director can review. Use `crossmodel install --host cursor
--no-enforce` to skip or remove that gate, or set `CROSSMODEL_ENFORCE=0` to allow the
native tools for a run.

Enable **Settings → Rules, Skills, Subagents → Include third-party Plugins** so the Claude Code hooks (`#route`, saver mode, the delegation notice) load. New Cursor chats pick up the rule; the current one needs a restart.

What the agent should type:

```bash
crossmodel --model luna --cwd <dir> "<self-contained question>"
crossmodel --model luna --cwd <dir> --write --worktree /tmp/wt-<slice> "<spec>. Run the tests. Do not commit."
```

House setup: Grok 4.6 directs, luna does everything else. Anthropic (`sonnet` / `opus` / `haiku`) only when the user names Claude this turn. Same contract: they write and prove; you review and commit.

Project primer (opt-in, versioned — ask before running):

```bash
crossmodel teach --host cursor --dry-run    # would write ./AGENTS.md
crossmodel teach --host cursor
```

---

## Package and tests

The production runtime had no business living in a folder called `bench`, and it blocked
packaging, so `bench/providers.mjs` moved to `lib/providers.mjs`. The npm package is
`crossmodel-cli`: a real `bin` entry, zero dependencies, and `npm test`. 73 tests run
under `node --test` (the script is `node --test test/*.test.mjs` — on Node 22 a bare
directory argument discovers nothing). CI runs the tests plus `node --check` over every
tracked `.mjs`. The suite caught a bug the same day it was written, where rewriting a
comment deleted the line emitting `--force` and `--mode ask` for Cursor, which would have
made a write run hang and a sweep silently writable.

---

## What you get

### 1. `crossmodel` — one CLI for every provider

```bash
crossmodel --model luna "Write a JS function that parses RFC 4180 CSV. Code only."
crossmodel --model sol --file patch.diff "List only correctness defects in this diff."
crossmodel --list
```

The alias hides which binary it is, so nothing downstream cares.

**Exit codes are load-bearing:** `0` success, `1` usage error, `2` the call failed —
including a provider that exited 0 with an empty answer — and `3` a `--write` run that
changed nothing. `--help` prints the full flag list.
A failed call still produces text, and text looks like an answer — anything consuming
this must check the exit code first.

**Exit 0 with an empty answer counts as a failure**, and the provider's stderr comes back
with it. A CLI can refuse a tool call, explain itself on stderr, write nothing to stdout
and still exit 0 — leaving a blocked run and a working one indistinguishable. Silence is
never reported as a result here.

**Exit 3 is checked two ways**, because only some providers report their edits as events.
When there is no event stream the working tree is compared before and after. If neither is
possible — no stream and the target is not a git repo — crossmodel says it could not tell,
rather than implying files changed.

#### Flags

**Flags are strict.** An unrecognised flag is an error: `--wrte` cannot disappear and turn
the run into an accidental read-only call. A flag with no value, or followed by another
flag, is also an error: `--timeout` does not fall back to its default and `--cwd` does not
inherit the caller's directory. Capability checks for `--network`, `--effort` and
`--resume` run before `--worktree` creates anything, so a bad combination leaves no
orphaned worktree or branch.

#### Repo sweeps — the part worth stealing

```bash
crossmodel --model luna --cwd ~/myrepo \
  "Which files handle authentication? Answer as path:line, nothing else."
```

In our testing a cold sweep of a 14-module project — enumerate the modules, then locate
one specific function by name — returned the correct `file:line` in ~10s on ~6k tokens,
entirely on the external provider's quota.

You are not paying to *read* the repo. That is the whole trick.

### 1b. Delegation is visible

A `codex exec` and a `grep` look identical in a transcript, so you cannot tell which
quota pool a turn is draining. A `PreToolUse` hook announces the moment the boundary is
crossed:

```
🔶 delegating to luna (gpt-5.6-luna) — spending OpenAI quota, not this session's · sweeping /myrepo
```

It stays silent for same-pool calls (Claude Code → `claude`, Cursor → `cursor`) and for ordinary commands. It only announces; it
never blocks.

### 2. Three subagents, three jobs

| Agent | Model | What it's for |
|---|---|---|
| `delegate` | external CLI | The bridge. Sweeps, code from a spec, classification, second opinions. Spends the *other* provider's quota |
| `probe` | Claude, read-only | Investigation that needs judgement — *why* does this break, *would* this change hurt. Never writes |
| `slice` | Claude | Implement one slice inside existing code, run the project gate, report. Never commits |

`delegate` is the one that saves money; `probe` and `slice` exist so the routing policy
has somewhere to escalate *to*. `probe` opens by asking whether it should be `delegate`
instead — a mechanical lookup on Anthropic quota is waste, and it says so.

Each system prompt encodes the failure modes: validate exit codes, never forward an error
as a finding, separate confirmed from suspected, never invent an API, never commit.

### 3. `#route` — a routing policy that fires on demand

Put `#route` anywhere in a prompt and the hook injects your routing policy into that
turn. Without the trigger it outputs nothing and costs nothing.

The `#` is required on purpose — a bare `route` collides with everyday vocabulary
("fix the `/api` route") and the hook would fire on half your prompts.

The policy is data. Copy `routing.example.json` to `~/.claude/crossmodel/routing.json`
and edit it; the hook never needs changing. If the file is malformed it says so loudly
rather than quietly falling back to defaults — silently reverting to an unmeasured policy
is exactly the failure this plugin exists to prevent.

Put it in `~/.claude/crossmodel/`, not in the plugin directory: an installed plugin lives
under a *versioned* path, so an update creates a new directory and anything you wrote into
the old one is gone.

### 4. Saver mode — delegate by default, on a deadline

`#route` is opt-in per turn, which is right most of the time and wrong exactly when it
matters: the week your quota is nearly spent, you forget the trigger on the turns you
most needed it.

```bash
crossmodel mode on --until sunday --prefer luna
crossmodel mode status
crossmodel mode off
```

While it is on, **every** turn carries a short standing reminder — delegate by default,
justify in one line when you don't — instead of waiting for a trigger. It costs roughly
200 tokens a turn, which one avoided file-read pays back.

`--until` takes `6h`, `2d`, a weekday name, or an ISO date, and the mode **expires on its
own** and announces that it did. A quota-saving measure you can leave on by accident is
one that stops matching reality without telling you.

Two things it deliberately keeps at home: final review and the commit. Saver mode changes
who does the work, never who approves it.

One counterintuitive rule it enforces: **call the CLI straight from Bash rather than
through the `delegate` subagent.** That subagent is itself a Claude model — using it to
save Anthropic quota spends Anthropic quota. It earns its cost when the output is large or
the batch is long, and not before.

### 5. `crossmodel teach` — tell the project this exists

A future session opening your repo has no idea crossmodel is installed, so it does the
mechanical lookups itself and spends your quota doing it.

```bash
crossmodel teach --dry-run     # print the block, write nothing
crossmodel teach               # write it into ./CLAUDE.md
```

It writes a short primer between `<!-- BEGIN crossmodel -->` / `<!-- END crossmodel -->`
markers, naming **the aliases that actually work on this machine** rather than examples
that fail on first use. Re-running updates the block in place; deleting the marker lines
removes it; nothing outside them is ever touched, and a half-written marker pair is refused
rather than guessed at.

It is a command and not something the install does, on purpose. Installing a plugin does
not execute code — and `CLAUDE.md` is versioned, so it ships to everyone who clones the
repo. Committing instructions on your behalf, to teammates who may not have the plugin,
is not a plugin's decision to make.

The block stays short deliberately. `CLAUDE.md` is loaded into every session, so each line
is a tax on every turn forever; it carries only what cannot be inferred from the code —
exit-code semantics, that the git rule is a contract, and who commits.

---

## Design principle: subagents write and prove, the orchestrator reviews and commits

Writing code is the job. A delegated model that cannot write can't iterate, can't run its
own tests, and can't finish anything — so `--write` exists and is meant to be used.

The checkpoint is not *who touched the file*. It is **what enters history**. While a
change sits in the working tree it is visible in a diff and cheap to throw away. After a
commit it is a fact other things get built on. So the boundary sits there:

| Step | Who | Why |
|---|---|---|
| Write the code | subagent, any provider | it's the work |
| Run the gate | subagent | it has to prove it didn't break anything |
| **Review the whole** | **orchestrator** | only it sees the other slices and the original intent |
| **Commit** | **orchestrator** | the step that leaves the reach of "undo" |

**Why the orchestrator and not the subagent.** A delegated model holds exactly the view
it was handed. It doesn't know the decision made three turns ago, the constraint stated
in passing, or the four other slices in flight. That view is enough to write a correct
function and nowhere near enough to judge whether it belongs.

**Why external models get an isolated scope.** An external CLI runs *its own* agent loop
with its own definition of "done" and its own appetite for adjacent cleanup — unlike a
Claude subagent, which runs under this harness's rules. That's a scoping problem, not a
reason to forbid writing, so `--write` requires an explicit `--cwd` and asks the provider to
scope edits to it. The git rule is a contract a cooperating agent honours, not a lock —
`codex` is the only provider that enforces it in the kernel. Point `--write` at a `git
worktree` and two agents can work at once without meeting; that isolation is also what
makes reviewing the diff cheap.

Verified, not assumed for codex: with `--write`, edits inside the directory succeed and
edits outside are rejected (`patch rejected: writing outside of the project`); `.git/` is
read-only. Grok Build's OS sandbox is documented, not measured here — see below. OpenCode's
policy is not a sandbox. Network is blocked by default in both measured codex modes, so
nothing can push, deploy, or call a webhook — and it stays that way unless you pass
`--network`, which requires `--write` and exists so an agent can run a test suite that
talks to a local service. Opening it is a real widening of scope: with network on, "cannot
call a webhook" no longer holds. Grant it when you want the agent's work verified, not by
default. After a `--write` run, read `git -C <dir> log` as well as the diff.

`--cwd` is resolved to an absolute path and checked for existence before any provider is
spawned. This closes a bug where a relative directory was resolved twice — `--cwd lib`
became `lib/lib` — and applies to providers whose directory is a flag (`--workspace`,
`--dir` or `--cwd`) as well as those using the child's process directory.

```
orchestrator ──asks──▶ model ──writes in an isolated scope + proves──▶ orchestrator reviews ──▶ commits
```

The saving is untouched: the expensive part — sweeping, reasoning, drafting, testing —
runs on the external provider's quota. Only review and commit come home.

---

## Letting it verify its own work

The single most expensive lesson from real use: **an agent that cannot run your tests hands
back unverified code, and the verification bounces straight back to you.**

Measured here on 2026-08-05. Two implementation phases were delegated with `--write`. Both
wrote tests. Neither could run the ones that touch a database, because the sandbox blocks
network and the database listens on localhost. One of those unrun tests was already
failing against the code that shipped with it — a payment processor that guaranteed *one
row* but not *one write*, so a redelivered out-of-order event would flip a settled payment
back to pending. The test named the bug. Nobody saw it run.

So network is a flag now, off by default:

```bash
crossmodel --model luna --worktree /tmp/wt-feature --write --network \
  --effort xhigh --timeout 1800000 "Implement SPEC.md. Run npm test AND npm run test:db."
```

- `--network` requires `--write` (the toggle it maps to is workspace-write-scoped) and
  stays off unless asked. Turn it on when the agent must run the project's real gate.
  For a read-only sweep that still needs the internet, copy what it must read into a
  throwaway directory and point `--cwd` there. 🔴 **Do not instead narrow
  `sandbox_workspace_write.writable_roots` and grant network** — measured 2026-08-06, that
  setting did *not* confine anything: the agent overwrote a file in the cwd regardless.
  It looks like a safety boundary and isn't one.
- `--effort <level>` picks reasoning effort in the provider's own vocabulary (codex:
  `minimal|low|medium|high|xhigh`). A provider without the control **errors** instead of
  silently ignoring it — believing a run reasoned harder than it did is worse than an error.
- `--worktree <dir>` creates an isolated git worktree and uses it as `--cwd`. An existing
  path is reused only after it is **verified to be a linked worktree** — an ordinary
  directory, or the main checkout, is refused rather than written to, because a flag whose
  purpose is isolation must not quietly hand over something that is not isolated. It also
  **symlinks `node_modules` in**. That part is not a convenience: a fresh worktree
  has no installed dependencies, so the agent cannot run the very tests it was asked to
  prove its work with — an isolation flag that blocks verification is a trap, not
  isolation. Add `--link a,b` for the gitignored files a checkout lacks and the tests
  need, like a local `.env`. The worktree is left behind deliberately — reviewing that
  diff is the point.
- `--resume <id|last>` continues a session that died instead of starting cold. The context
  it already paid for survives, and re-reading the repo is the expensive part.

### Timeouts are a destructive failure mode under `--write`

There is no default wall-clock deadline. `--timeout <ms>` has no default: it is an opt-in
hard ceiling. The deadline somebody guessed is what actually kills runs and wastes tokens
already spent, far more often than a provider genuinely hangs.

**Nothing kills a run automatically.** The obvious substitute — a watchdog on silence
rather than on duration — was built, shipped, and then turned off by default, because
silence only means something when there is a stream to be silent on. With `--no-stream`, or
on any provider without an event stream, a perfectly healthy run prints nothing at all
until it finishes, and an adversarial review on a reasoning model runs ~40 minutes that
way. A byte-based watchdog would kill it and call it wedged — the guessed deadline again,
wearing a better argument.

What guards against a genuinely wedged run instead is visibility plus a working
interrupt. The progress reporter prints a heartbeat naming how long the silence has lasted,
and the child now runs in its own process group, so Ctrl-C takes the whole tree with it —
a backgrounded `npm test` no longer survives the way it used to.

`--idle-timeout <ms>` is still there, off unless you ask for it, for unattended batches
where nobody is reading the heartbeat and a wedged run would sit burning a slot.

The **600000 ms** floor still applies, but only to an explicit `--timeout` under `--write`.

When a `--write` run does fail, crossmodel asks the tree before it alarms you: it reports
the tree **is UNCHANGED** when the failed child touched nothing, and only warns about
possible partial edits — and points at `--resume last` — when there is something to
inspect. A post-mortem about damage that cannot exist teaches people to ignore the warning
that matters.

---

## Knowing what's left

`spend their quota instead of yours` is a claim, and until you can see the number it stays
one. Worse, an empty pool announces itself as a refused run halfway through a batch —
the worst possible moment to find out.

```
$ crossmodel usage
codex — plan plus
  quota    █░░░░░░░░░░░░░░░░░░░  4% used of the last 7d
  resets   08/08/2026, 17:17:48 (in 2d 17h)
  credits  none
  tokens   last 24h   15,099,378 in / 110,649 out  (193 sessions)
           last 7d    15,099,378 in / 110,649 out  (193 sessions)
```

The codex CLI has no `usage` command, but it writes a transcript per session and the
server's rate-limit snapshot rides along inside it. So this reads those files: **no network
call, no auth, and it works while a run is still in flight.** `--json` for scripting.

It reads a format nobody promised to keep stable, so every field is treated as optional:
an unrecognised shape prints `unknown`, and no data at all exits **2** — because "no
reading" must never be mistaken for "nothing used".

---

## Watching a run

A long delegation used to be a black box: the CLI printed a banner, went quiet for
minutes, and dumped everything at the end. Silence and a hang look identical, which is
the worst property a background job can have.

So progress is now **on by default** for providers that expose a machine-readable event
stream (codex today, via `--json`). Every file written, command run, and message is
echoed as it happens:

```
     0s · session 019fd4f2-18f4-7202-9771-e9a8a3674584
    11s ✎ + /home/you/repo/src/thing.ts
    15s $ npx vitest run src/thing.test.ts
    17s ! exit 1: npx vitest run src/thing.test.ts
    18s > PRONTO
    18s = 52,515 tokens
```

`✎` a write · `$` a command starting · `!` a command that failed or a turn that errored ·
`~` reasoning · `?` a web search · `>` a message · `=` the token bill.

**Progress goes to stderr; stdout still carries only the answer.** That contract is what
lets callers keep doing `$(crossmodel ...)` and piping into other tools. In fact stdout
got *cleaner*: reading the event stream means the answer is the model's actual message,
with the provider's banner no longer glued to the front of it.

The first line is a header — model, effort, sandbox, network — because with `--json` the
provider's own banner disappears, and settings you cannot see are settings you cannot
trust. Proving that `--effort xhigh` had actually taken once meant reading codex's session
transcript by hand.

Long silences get reported too. An agent alternates between bursts of tool calls and quiet
stretches where it reasons and writes, and a quiet stretch is indistinguishable from a
hang — that confusion happened here, on a run that was working fine. After a minute
without events you get `… working, 90s since the last event`.

- `--log <file>` — write the progress lines *and* the answer to a file as well. Use this
  instead of redirecting stderr, which silences the live view. The obvious fix for that
  (`2>&1 | tee`) is easy to forget; forgetting it once already cost a run's visibility.
- `--no-stream` — turn the stream off entirely and go back to waiting in silence.
- `--quiet` — silence the narration but **keep** the stream, because it is also what
  strips the banner. Tying the two together would make `--quiet` return a dirtier stdout
  than the default, which is the opposite of what the flag promises.

A provider with no event stream simply never reports; the run works exactly as before and
says once, on stderr, that progress was unavailable. Asking for progress is always safe.

Codex also keeps its own live transcript at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
— the `session` id on the first line is how you find the right one to tail.

---

## The benchmark

```bash
cd bench
node battery.mjs --list                                    # free, no quota spent
node battery.mjs --suites code --models luna --limit 1     # cheap smoke test
node battery.mjs --suites code,review,format,classify \
                 --models luna,sonnet,opus --repetitions 3
```

Four suites, all scored by script:

| Suite | Measures | Who decides the score |
|---|---|---|
| `code` | Implement from a spec | **`node --test` actually running** |
| `review` | Find a planted defect without inventing false ones | Comparison against paired buggy/clean samples |
| `format` | Obey a strict output contract | Deterministic validators |
| `classify` | Triage a batch into a closed list | Exact label match |

**`format` is the one people skip and shouldn't.** Every agent architecture assumes the
model respects an output contract. A model that reasons well but ignores the format
breaks your parser, and it breaks it silently.

### Design choices worth knowing

- **No LLM judges another LLM.** Circular, and it burns quota. The ground truth is in the
  task files.
- **Paired samples in `review`.** Recall alone is meaningless — a model that flags
  everything scores 100%. Every buggy sample has a clean twin.
- **Difficulty gradient.** The useful question isn't "can this model code?" but "where
  does it break?"
- **Repetitions matter.** In our own runs, variance between rounds exceeded the gap
  between models. One repetition measures luck.

### About the example results

`routing.example.json` contains numbers from our own runs. **Do not treat them as a
ranking.** They come from 1–2 repetitions on tasks shaped like one particular codebase.
Run the battery on tasks that look like *your* work.

The most useful thing our runs produced wasn't a leaderboard: **four of our own answer
keys were wrong, and the models caught all four.** One flagged a real month-end overflow
bug in a sample we had labelled "clean". A benchmark is a rumour until you verify it too.

---

## Adding models and providers

**A new model on an existing provider** is a config change — `/crossmodel-setup` writes
it, or do it by hand:

`crossmodel.config.json` lives at `~/.claude/crossmodel/crossmodel.config.json` first.
The plugin directory is a legacy fallback only; a config stored there is lost when the
versioned plugin path is replaced during an update. Add aliases in the home-directory
file, not next to `lib/providers.mjs`.

```json
{
  "models": {
    "fast":  { "provider": "codex",  "model": "gpt-5.6-luna" },
    "local": { "provider": "ollama", "model": "qwen2.5-coder" }
  }
}
```

**A new provider** needs an `args()` builder — how to turn `(model, prompt, cwd, write)`
into that CLI's argument list — which JSON can't express. It belongs in
`lib/providers.mjs` as a pull request. It is about ten lines; see `codex` for the shape,
including how a sandbox flag maps to `write`.

Built in: `codex`, `grok`, `cursor`, `opencode`, `gemini`, `ollama`, and `claude` (as the
benchmark baseline). Of those, `cursor` is verified by a real run and `grok` is
documentation-only.

The `gem` alias is Gemini 3.7 Flash High through the Antigravity CLI (`agy`), billed to
Antigravity rather than Cursor.

### Grok Build: xAI's agentic CLI

`grok` is the xAI Grok Build CLI (binary: `grok`). 🟡 The facts in this section come from
docs.x.ai/build, read on 2026-08-12; they are documentation-only and not from a measured
run. Install it with `curl -fsSL https://x.ai/cli/install.sh | bash` or
`npm i -g @xai-official/grok`. It needs a SuperGrok or X Premium+ subscription, and
headless authentication uses `XAI_API_KEY`.

crossmodel ships one alias: `grok` → `grok-build-0.1`. Run `grok models` to list the rest
and add another model through `crossmodel.config.json`.

Grok's documented sandbox is Landlock on Linux and Seatbelt on macOS. crossmodel passes
`--sandbox read-only` for a sweep and `--sandbox workspace` for `--write`. `workspace` is
the profile xAI's own docs label normal development. `strict` also confines reads to the
cwd, which stops an agent reading a sibling package or a global config and buys nothing
the diff review does not already cover.

`workspace` allows network unconditionally, and no profile writes to the cwd with network
blocked, so crossmodel **refuses `--network` for grok** rather than accepting a flag it
cannot honour. Child-network blocking under read-only is Linux-only; on macOS it is a
no-op. Grok leaves `.git/` writable, so the git rule is a contract, not a lock — after a
`--write` run, review `git -C <dir> log` as well as the diff. Streaming progress is not
wired up for Grok because its streaming-JSON event schema is undocumented.

### OpenCode: one harness, many backends

`opencode` is the entry that opens this up. It is provider-neutral, so OpenRouter, Ollama,
OpenAI, Google and anything OpenAI-compatible all arrive through a single adapter —
harness and model stop being welded together. The `flash` alias ships working out of the
box with no API key and no cost; `opencode models` lists what your install offers.

**Its boundary is a policy, not a sandbox.** OpenCode has no OS sandbox; it has a
permission layer, and that layer only checks arguments it can see. A path handed to the
Write tool is checked. The same path inside `printf 'x' > /outside/file` is not — to the
permission layer that is just "run a command". Measured against opencode 1.18.14, with no
`--auto`: the first was refused, the second succeeded.

The policy used to be an allowlist with `"*": "ask"` as the floor. That is gone, for two
reasons.

It blocked ordinary work. In a non-interactive run, `ask` with nobody to ask is a
refusal, so an agent could not run a build tool nobody had listed, and an agent that
cannot run the suite hands back code nobody has run.

It stopped nothing. MEASURED 2026-08-12, with that policy in force, `echo BACKUP >
/outside/file` from the agent shell exited 0 and overwrote a file outside the workspace,
while `cat` of that same path was refused, because OpenCode matches a command by its
leading word.

The shipped default is the house rule as configuration — the agent works, git history
stays the orchestrator's:

| | |
|---|---|
| bash (`*`) | allow |
| `git diff/log/status` and the other reading verbs | allow (named, so a broader user rule cannot sweep them away with the writes) |
| edit inside the working dir | allow with `--write` |
| `git commit`, `push`, `reset`, `rebase`, `checkout` and the other writing verbs | **deny** — what enters history is yours |
| `webfetch` | deny — reaching the network is `--network`'s decision, not the policy's |

Override it in `~/.claude/crossmodel/permissions.json`.

Verified end to end, not assumed — with the policy active, in a `--write` run:

| Attempt | Result |
|---|---|
| Write a file inside the working dir | ✅ succeeds |
| Write **tool** aimed outside it | 🔒 blocked |
| `echo BACKUP > /outside/file` via the **shell** | 🔴 exited 0 and overwrote a file outside the workspace (measured 2026-08-12) |
| `cat /outside/file` via the **shell** | 🔒 refused as `external_directory` |
| Edit a file, then `git commit` | ✅ edited · 🔒 commit refused |
| `git diff --stat` | ✅ still works |
| A repo shipping `opencode.json` with `"permission":"allow"` | 🔒 cannot override |

That last row is why the policy travels as `OPENCODE_CONFIG_CONTENT` and not
`OPENCODE_CONFIG`: config precedence puts a project's own `opencode.json` *above* the
latter, so a repo you do not control could hand itself full permissions. The inline form
loads after the project config and wins.

⚠️ Still enforced in process, by OpenCode. The git denial is a contract a cooperating
agent honours, not a lock: `git commit` reached through `sh -c` or `node -e` is not
caught, and `"confined to --cwd"` is a strong convention, not a boundary. The protection
which actually works is the orchestrator reviewing the diff before committing, and
`--worktree` is what makes that review cheap. Codex is the one provider that enforces the
git rule in the kernel — `.git/` is read-only inside its sandbox. Grok, Cursor and
OpenCode are asked, not prevented.

**One trap worth knowing if you script OpenCode yourself:** it does not take its working
directory from the spawned process. With the child's cwd set to a target repo and the
parent sitting in `/tmp`, it wrote `/tmp/NEW.txt`. `--dir` is what actually aims it.

### Cursor: a fourth quota pool, and a harness

Cursor's CLI is the `agent` binary:

```bash
curl https://cursor.com/install -fsS | bash
agent login                 # or set CURSOR_API_KEY
```

One alias ships: `cgrok` maps to `cursor-grok-4.6-high` (Grok 4.6). `agent --list-models`
lists the rest; the same subscription also carries GPT-5.6 Sol, Claude Opus 5, Kimi K3
and Composer. Add any model you use via `~/.claude/crossmodel/crossmodel.config.json`.

Cursor does not take reasoning effort as a flag. The tier is baked into the model id:
`-low`, `-medium`, `-high` or `-xhigh`, each with an optional `-fast`. crossmodel therefore
**refuses `--effort` for Cursor** rather than dropping it silently; choose the tier by
choosing the alias. It refuses `--network` too: Cursor's `--sandbox` accepts only
`enabled|disabled`, with no network knob and no read-only/strict distinction.

**Verified by a real run on 2026-08-13 against `agent` 2026.08.11-e8db854:** a read-only
sweep took 45s and answered correctly. This distinguishes Cursor from `grok`, which is
documentation-only. `agent -p` is **not read-only by default** — the documentation
says it has access to all tools, including write and shell — so crossmodel passes
`--mode ask` for sweeps. That was measured refusing a shell write, with the target file
left untouched.

**Measured, and important:** `--sandbox enabled` failed to start on stock Ubuntu with
`Sandbox mode is enabled but not available on this system... possibly due to AppArmor
configuration. Run agent sandbox disable to switch to allowlist mode`. crossmodel used to
pass that flag under `--write` and let the failure stand, which meant it refused to write
on a machine where the plain `agent` CLI writes fine.

The cause is a gap in Cursor's own AppArmor profile, diagnosed from the kernel audit log
on 2026-08-13: profile `cursor_sandbox_agent_cli` grants `sys_admin`, `setuid` and
`setgid` but not `dac_override`, which `newuidmap` needs to write the namespace uid map.
The machine was not locked down: plain `unshare --user --map-root-user` works there, and
the IDE's separate `cursor_sandbox` profile is unaffected.

A wrapper that forbids what the tool itself permits is a wrapper people route around.
crossmodel therefore passes `--force` plus `--sandbox disabled`, which is Cursor's own
default. `--write` works; it was verified writing a file in a real run.

Cursor is a **harness**, like OpenCode: the alias names a model inside somebody else's
agent loop.

### Why CLI only, and no HTTP APIs

An earlier version supported OpenAI-compatible HTTP endpoints. It was removed.

A stateless endpoint only sees the prompt text — it can't sweep your repo, can't run your
tests, can't iterate. Supporting both meant every feature needed two paths and every
document needed a caveat, in exchange for a much weaker version of the product. Scope
discipline beat surface area: if it can't read your working directory, it's out.

---

## Honest limitations

- **The bridge costs Anthropic tokens too.** The `delegate` subagent is itself a Claude
  model. For small structured outputs, calling `crossmodel` straight from Bash is
  cheaper; the subagent pays for itself when the output is large or the batch is long.
- **Only CLI-backed models see your repo.** Agentic CLIs read the tree when given
  `--cwd`; HTTP-backed models see nothing but the prompt text. Neither can see the
  *conversation*, so state the goal explicitly either way.
- **Read-only is the default; `--write` is opt-in.** Every provider gets the same deal:
  the agent reads, edits, runs the build and runs the tests inside the directory it was
  given, and does not touch git history. Nothing else is withheld. That git rule is a
  contract a cooperating agent honours, not a lock. `codex` is the only provider that
  enforces it in the kernel — `.git/` is read-only inside its sandbox. `grok`, `cursor`
  and `opencode` are asked, not prevented, and a shell can reach around any of them. So
  verify rather than assume: after a `--write` run read `git -C <dir> log` as well as the
  diff. The protection which actually works is the orchestrator reviewing the diff, and
  `--worktree` is what makes that review cheap. OpenCode's permission layer is still
  in-process: `echo BACKUP > /outside/file` from the agent shell exited 0 and overwrote a
  file outside the workspace (measured 2026-08-12). A `permissions.json` that allows
  `git commit *` also undoes the commit denial — it is your file.
- **Read access is NOT confined to `--cwd`.** A delegated model can read anything your
  user can — `.env`, `~/.aws/credentials`, shell history. It *can* quote them back to
  you, and that answer lands in your transcript. On codex, network is off unless you
  pass `--network` (which itself requires `--write`). A grok `--write` run uses the
  `workspace` profile, which allows network unconditionally — `--network` is refused
  there, and on cursor, rather than accepted as a flag neither can honour. Don't point
  a sweep at a tree whose secrets you don't want repeated — and think twice before a
  `--write` run, or `--network`, on a tree that holds any.
- **Benchmark scores measure a pair, not a model.** `code` scores near-ceiling for most
  models *because a test suite runs underneath*. Remove the verifier and the number
  tells you nothing.
- **The task sets are small.** Eight coding tasks, twelve review samples. Enough to find
  a floor, not enough to rank confidently.

---

## Two hard-won gotchas

Both cost real debugging time and are commented in the source. Don't undo them.

1. **`stdin` must be closed** when spawning provider CLIs. Codex prints
   `Reading additional input from stdin...` and blocks forever if the pipe stays open.
   The symptom is misleading: you get the banner back and it looks like a parse failure.
2. **`claude --tools` is variadic** and swallows whatever follows it. The prompt has to
   come *before* it. And it's `--tools ""`, not `--allowed-tools`, that disables
   everything — needed so Claude can't run bash to test its own code, an advantage the
   sandboxed providers don't have.
3. **A relative directory used to be resolved twice.** `--cwd lib` became `lib/lib` for
   providers that take their directory as a flag (`--workspace`, `--dir` or `--cwd`). It
   is now made absolute and checked before the child starts.
4. **A startup failure used to imply damage.** A child that touched nothing could produce
   a partial-edits warning and a `--resume` suggestion. crossmodel checks the tree first
   and says it **is UNCHANGED** when there is nothing to inspect.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Anthropic or OpenAI. Uses each provider's official CLI under your
own account and terms.

### Exit codes

| code | meaning |
|---|---|
| 0 | success — the answer is on stdout |
| 1 | usage error (unknown alias, missing prompt, contradictory flags) |
| 2 | the call failed (provider unavailable, timeout, non-zero exit) |
| 3 | a `--write` run succeeded but **changed no file** |

Code 3 exists because success and no-op were indistinguishable, and that is dangerous in
exactly the case you most want to notice. A delegated phase here stopped because the schema
it needed did not exist — the correct call, honestly reported — and returned 0. Anything
automating on top of that reads "done".
