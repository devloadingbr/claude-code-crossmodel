// Write a short crossmodel primer into a project's CLAUDE.md or AGENTS.md.
//
// Why a command and not something the install does: installing a plugin does not execute
// code, and even if it did, these files are VERSIONED and ship to everyone who clones
// the repo. A tool that edits them without being asked would commit instructions on the
// user's behalf to teammates who may not even have the plugin. So this is explicit,
// idempotent, and trivially reversible.
//
// Why it is short: both files are loaded into every session, so every line is a tax paid
// on every turn forever. This block earns its place only by carrying what cannot be
// inferred from the code — exit-code semantics, which provider is actually sandboxed,
// and the one rule about who commits.
//
// `--host cursor` changes the default file to AGENTS.md (Cursor reads that; CLAUDE.md
// is optional there). `--file` always wins.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const BEGIN = '<!-- BEGIN crossmodel -->';
export const END = '<!-- END crossmodel -->';

/**
 * Default file for `crossmodel teach`. `--file` wins; `--host cursor` selects AGENTS.md.
 * Unknown host is an error, not a silent fallback — a typo must not write CLAUDE.md
 * inside a Cursor project and tell the user the primer is in the file Cursor actually reads.
 */
export function teachTarget({ host, file, cwd = process.cwd() } = {}) {
  if (file) return { path: path.resolve(cwd, file) };
  if (!host || host === 'claude') return { path: path.resolve(cwd, 'CLAUDE.md') };
  if (host === 'cursor') return { path: path.resolve(cwd, 'AGENTS.md') };
  return { error: `unknown --host "${host}". Use cursor or claude.` };
}

/**
 * The primer. `aliases` is what `--list` found usable on THIS machine, so the block names
 * commands that actually run here rather than examples that fail on first use.
 */
export function primer(aliases = []) {
  const usable = aliases.filter((a) => a.ok);
  const writers = usable.filter((a) => a.write).map((a) => a.alias);
  const names = usable.map((a) => a.alias);

  const available = names.length
    ? `Aliases available here: ${names.map((n) => `\`${n}\``).join(', ')}${
        writers.length ? ` — of these, ${writers.map((n) => `\`${n}\``).join(', ')} can \`--write\`.` : '.'
      }`
    : 'No provider CLI is installed yet — run `/crossmodel-setup` before relying on this.';

  return `${BEGIN}
## Delegating work to another model (crossmodel)

\`crossmodel\` hands a task to an external agentic CLI, so it spends **that provider's
quota instead of this session's**. It is agentic: give it a directory and it greps and
reads the tree itself. Run \`crossmodel --list\` to see what is configured.

${available}

\`\`\`bash
crossmodel --model <alias> --cwd <dir> "<self-contained question>"
\`\`\`

**Delegate by default** for: "where is X", "which files touch Y", "does this pattern exist
anywhere", reading a lot to conclude a little, code from a spec a test can check, bulk
conversion, classification into a closed list, an independent second opinion. Ask several
questions in ONE sweep rather than several sweeps.

**Do not delegate** when the task hinges on context that exists only in this conversation —
a decision made earlier, a constraint stated in passing. Reconstructing it in the prompt
can cost more than doing the work. The delegated model cannot see this conversation, so
state the objective, the constraints and the definition of done explicitly, every time.

**Exit codes are load-bearing — check before trusting stdout.** A failed call still prints
text, and text looks like an answer.

| Exit | Meaning |
|---|---|
| \`0\` | success |
| \`1\` | usage error — fix the invocation |
| \`2\` | the call failed, *including* a provider that exited 0 with an empty answer |
| \`3\` | a \`--write\` run that changed **no file** — not success. Read the answer; the agent usually hit a blocker and correctly refused to fake progress |

**Writing is allowed. Committing is not.**

\`\`\`bash
crossmodel --model <alias> --worktree /tmp/wt-feature --write \\
  "<spec>. Run the tests. Do not commit."
\`\`\`

Subagents write and prove; the orchestrator reviews and commits. The checkpoint is not who
touched the file, it is what enters history. Report every file touched — nobody can review
what was not mentioned.

**The rule is the same for every provider:** the agent works freely inside the directory
it was given — reads, edits, runs the build, runs the tests — and does not touch git
history. Nothing else is withheld from it. An agent that has to negotiate for permission
to run a build tool hands back unverified code.

⚠️ **The git rule is a contract, not a lock.** \`codex\` is the only provider that enforces
it in the kernel — \`.git/\` is read-only inside its sandbox, so it cannot commit whatever
it decides. \`grok\`, \`cursor\` and \`opencode\` are asked, not prevented, and a shell can
reach around any of them. So verify rather than assume: after a \`--write\` run, read
\`git -C <dir> log\` as well as the diff.

The protection that actually works is your review, and \`--worktree\` is what makes it
cheap: an isolated checkout you can read, keep, or delete without touching your tree.

⚠️ **Read access is NOT confined to \`--cwd\`.** A delegated model can read \`.env\`,
credentials and shell history, and quote them back into the transcript. Do not sweep a tree
whose secrets should not be repeated.
${END}`;
}

/**
 * Splice the block into `text`, replacing an existing one. Returns { content, action }.
 * An opening marker without a closing one is an ERROR, not something to guess at: the
 * file is hand-edited and half-rewriting it would destroy work.
 */
export function splice(text, block) {
  const hasBegin = text.includes(BEGIN);
  const hasEnd = text.includes(END);

  if (hasBegin !== hasEnd) {
    return { error: `the file has ${hasBegin ? 'a BEGIN' : 'an END'} marker without its pair — fix or remove it by hand, refusing to guess where the block ends.` };
  }

  // A second copy of the block — pasted, merged, or duplicated by a bad rebase — would be
  // invisible: indexOf finds the first pair, replaces it, and leaves the second one behind
  // to go stale forever while every run reports "updated". Refuse, for the same reason an
  // odd marker is refused: this file is hand-edited and guessing destroys work.
  const count = (needle) => text.split(needle).length - 1;
  if (count(BEGIN) > 1 || count(END) > 1) {
    return { error: 'the file contains more than one crossmodel block — delete the extra ones by hand, refusing to guess which is authoritative.' };
  }

  if (hasBegin) {
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END) + END.length;
    if (end < start) return { error: 'the END marker appears before the BEGIN marker — fix that by hand.' };
    const next = `${text.slice(0, start)}${block}${text.slice(end)}`;
    return { content: next, action: next === text ? 'unchanged' : 'updated' };
  }

  const sep = text.length && !text.endsWith('\n\n') ? (text.endsWith('\n') ? '\n' : '\n\n') : '';
  return { content: `${text}${sep}${block}\n`, action: 'appended' };
}

/** Read → splice → write. Never touches anything outside the markers. */
export function teach(filePath, aliases) {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const r = splice(existing, primer(aliases));
  if (r.error) return { ok: false, error: r.error };
  if (r.action !== 'unchanged') writeFileSync(filePath, r.content);
  return { ok: true, action: existing ? r.action : 'created', bytes: r.content.length };
}
