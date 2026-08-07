# crossmodel

**Delegate work from Claude Code to another agentic CLI — and know which models you can trust with what.**

Claude Code is excellent at orchestrating. It is also the only thing spending your
Anthropic quota. `crossmodel` hands work to an external agentic CLI — OpenAI's Codex,
Gemini, a local Ollama model — so it bills to *that* provider's pool instead.

"Agentic" is the load-bearing word. These are not chat endpoints: point one at a
directory and it greps and reads the tree itself, and with `--write` it edits inside that
directory. A repo-wide sweep costs their quota, not yours.

The catch nobody addresses: **how do you know what the cheap model can actually do?**
So this ships with a deterministic benchmark. No LLM judges another LLM; a test suite
decides.

> **Status: v0.8.0, early.** Works, tested end to end, but the API may move. Issues and
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

You need at least one provider installed. The cheapest entry point is OpenAI's Codex,
because it authenticates with a ChatGPT subscription instead of a metered API key:

```bash
npm install -g @openai/codex
codex login
```

Prefer to configure by hand? Copy `crossmodel.config.example.json` to
`crossmodel.config.json`. The setup skill just does this for you, with verification.

---

## What you get

### 1. `crossmodel` — one CLI for every provider

```bash
crossmodel --model luna "Write a JS function that parses RFC 4180 CSV. Code only."
crossmodel --model sol --file patch.diff "List only correctness defects in this diff."
crossmodel --list
```

The alias hides which binary it is, so nothing downstream cares.

**Exit codes are load-bearing:** `0` success, `1` usage error, `2` the call failed, `3` a
`--write` run that changed nothing.
A failed call still produces text, and text looks like an answer — anything consuming
this must check the exit code first.

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
🔶 delegating to luna (gpt-5.6-luna) — spending OpenAI quota, not Anthropic · sweeping /myrepo
```

It stays silent for Anthropic models and for ordinary commands. It only announces; it
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
reason to forbid writing, so `--write` requires an explicit `--cwd` and confines edits to
it. Point it at a `git worktree` and two agents can work at once without meeting.

Verified, not assumed: with `--write`, edits inside the directory succeed and edits
outside are rejected (`patch rejected: writing outside of the project`). The system temp
dir is writable in both modes. Network is blocked by default in both modes, so nothing can
push, deploy, or call a webhook — and it stays that way unless you pass `--network`, which
requires `--write` and exists so an agent can run a test suite that talks to a local
service. Opening it is a real widening of scope: with network on, "cannot call a webhook"
no longer holds. Grant it when you want the agent's work verified, not by default.

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
- `--worktree <dir>` creates (or reuses) an isolated git worktree and uses it as `--cwd`,
  **symlinking `node_modules` in**. That last part is not a convenience: a fresh worktree
  has no installed dependencies, so the agent cannot run the very tests it was asked to
  prove its work with — an isolation flag that blocks verification is a trap, not
  isolation. Add `--link a,b` for the gitignored files a checkout lacks and the tests
  need, like a local `.env`. The worktree is left behind deliberately — reviewing that
  diff is the point.
- `--resume <id|last>` continues a session that died instead of starting cold. The context
  it already paid for survives, and re-reading the repo is the expensive part.

### Timeouts are a destructive failure mode under `--write`

A timeout kill is `SIGKILL` wherever the agent happens to be: **half-applied edits stay on
disk, with no rollback.** A default sized for a question is actively dangerous for an
implementation run — the two phases above took ~25 minutes each against a 4-minute default.

So the default now depends on what you asked for: **4 min** for a sweep, **1 h** with
`--write`, and anything under **10 min** with `--write` is *refused* rather than risked.
Validation runs before any side effect, so a rejected argument never leaves a worktree
behind. When a `--write` run does fail, the error says the tree may hold partial edits and
points at `--resume last`.

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
`bench/providers.mjs` as a pull request. It is about ten lines; see `codex` for the shape,
including how a sandbox flag maps to `write`.

Built in: `codex`, `opencode`, `gemini`, `ollama`, and `claude` (as the benchmark baseline).

### OpenCode: one harness, many backends

`opencode` is the entry that opens this up. It is provider-neutral, so OpenRouter, Ollama,
OpenAI, Google and anything OpenAI-compatible all arrive through a single adapter —
harness and model stop being welded together. The `flash` alias ships working out of the
box with no API key and no cost; `opencode models` lists what your install offers.

**It is read-only here, and that is a measurement.** OpenCode's boundary is an in-process
permission check, not an OS sandbox. Tested against opencode 1.18.14:

| Attempt | Result |
|---|---|
| Write **tool** outside the working dir, no `--auto` | ✅ refused (`external_directory; auto-rejecting`) |
| Same write with `--auto` | 🔴 **succeeded** — file outside overwritten |
| `printf 'x' > /outside/file` via the **shell** tool, no `--auto` | 🔴 **succeeded** |

The permission layer guards the file tools; shell redirection walks past it. codex fails
the write at the syscall regardless of what the model decides — OpenCode relies on the
model deciding. Those are different promises, so `--write` stays with codex, crossmodel
never passes `--auto`, and OpenCode runs under its read-only `plan` agent.

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
- **Read-only is the default; `--write` is opt-in and scoped.** Edits are confined to the
  `--cwd` you name, and nothing external ever commits. Use a `git worktree` when two
  agents might otherwise share a tree.
- **Read access is NOT confined to `--cwd`.** A delegated model can read anything your
  user can — `.env`, `~/.aws/credentials`, shell history. It cannot send them anywhere
  (network is blocked in every sandbox mode), but it *can* quote them back to you, and
  that answer lands in your transcript. Don't point a sweep at a tree whose secrets you
  don't want repeated.
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
