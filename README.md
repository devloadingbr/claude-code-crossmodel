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

> **Status: v0.4.0, early.** Works, tested end to end, but the API may move. Issues and
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

**Exit codes are load-bearing:** `0` success, `1` usage error, `2` the call failed.
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
dir is writable in both modes. Network is blocked in both modes, so nothing can push,
deploy, or call a webhook regardless.

```
orchestrator ──asks──▶ model ──writes in an isolated scope + proves──▶ orchestrator reviews ──▶ commits
```

The saving is untouched: the expensive part — sweeping, reasoning, drafting, testing —
runs on the external provider's quota. Only review and commit come home.

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

Built in: `codex`, `gemini`, `ollama`, and `claude` (as the benchmark baseline).

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
