# crossmodel

**Delegate work from Claude Code to any other LLM — and know which ones you can trust with what.**

Claude Code is excellent at orchestrating. It is also the only thing spending your
Anthropic quota. `crossmodel` lets a Claude Code session hand self-contained work to an
external model — OpenAI's Codex CLI, Gemini, a local Ollama model, anything on
OpenRouter — so that work bills to *that* provider's quota instead.

The catch nobody addresses: **how do you know what the cheap model can actually do?**
So this ships with a deterministic benchmark. No LLM judges another LLM; a test suite
decides.

> **Status: v0.3.0, early.** Works, tested end to end, but the API may move. Issues and
> PRs welcome.

---

## Install

```bash
/plugin marketplace add devloadingbr/claude-code-crossmodel
/plugin install crossmodel@crossmodel
```

Then check what's reachable from your machine:

```bash
node ~/.claude/plugins/cache/crossmodel/crossmodel/*/bin/crossmodel.mjs --list
```

You need at least one external provider installed and authenticated. The cheapest start
is OpenAI's Codex CLI, which authenticates with a ChatGPT subscription rather than an
API key:

```bash
npm install -g @openai/codex
codex login
```

---

## What you get

### 1. `crossmodel` — one CLI for every provider

```bash
crossmodel --model luna "Write a JS function that parses RFC 4180 CSV. Code only."
crossmodel --model sol --file patch.diff "List only correctness defects in this diff."
crossmodel --list
```

Transport is resolved from a registry, so the caller never knows whether `luna` is a
local subprocess or an HTTPS request.

**Exit codes are load-bearing:** `0` success, `1` usage error, `2` the call failed.
A failed call still produces text, and text looks like an answer — anything consuming
this must check the exit code first.

#### Repo sweeps — the part worth stealing

CLI-backed models are **agentic**. Point one at a directory and it greps and reads the
tree itself; you never paste code into the prompt:

```bash
crossmodel --model luna --cwd ~/myrepo \
  "Which files handle authentication? Answer as path:line, nothing else."
```

A repo-wide sweep costs **that provider's quota, not your Anthropic quota**. In our
testing a cold sweep of a 14-module project — enumerate the modules, then locate one
specific function — took ~10s and ~6k tokens, all on the external provider.

`--list` tags every alias `reads files` or `prompt only`. Passing `--cwd` to an
HTTP-backed model is rejected with an explicit error, never silently ignored: a sweep
that quietly ran against nothing is worse than one that refused.

### 1b. Delegation is visible

A `codex exec` and a `grep` look identical in a transcript, so you cannot tell which
quota pool a turn is draining. A `PreToolUse` hook announces the moment the boundary is
crossed:

```
🔶 delegating to luna (gpt-5.6-luna) — spending OpenAI quota, not Anthropic · sweeping /myrepo
```

It stays silent for Anthropic models and for ordinary commands. It only announces; it
never blocks.

### 2. `delegate` — a subagent that does the bridging

Claude Code spawns it, it calls the external model, filters the output, and reports a
structured result. The raw response never enters your main context.

Its system prompt encodes the parts that are easy to get wrong: validate the exit code,
never forward an error as a finding, mark claims the external model couldn't verify, and
refuse the task when building the briefing would cost more than doing the work.

### 3. `#route` — a routing policy that fires on demand

Put `#route` anywhere in a prompt and the hook injects your routing policy into that
turn. Without the trigger it outputs nothing and costs nothing.

The `#` is required on purpose — a bare `route` collides with everyday vocabulary
("fix the `/api` route") and the hook would fire on half your prompts.

The policy is data. Copy `routing.example.json` to `routing.json` and edit it; the hook
never needs changing. If the file is malformed it says so loudly rather than quietly
falling back to defaults — silently reverting to an unmeasured policy is exactly the
failure this plugin exists to prevent.

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

## Adding a provider

Two transports, both data-driven. Drop a `crossmodel.config.json` next to
`bench/providers.mjs`:

```json
{
  "providers": {
    "myapi": {
      "kind": "http",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "MY_API_KEY"
    }
  },
  "models": {
    "fast": { "provider": "myapi", "model": "some-model-id" },
    "local": { "provider": "ollama", "model": "qwen2.5-coder" }
  }
}
```

`kind: "http"` expects an OpenAI-compatible `/chat/completions` endpoint, which covers
OpenRouter, Together, Groq, vLLM, and LM Studio. `kind: "cli"` spawns a command.

Built in: `claude`, `codex`, `gemini`, `ollama`, `openrouter`, and a generic
`openai-compatible`.

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
