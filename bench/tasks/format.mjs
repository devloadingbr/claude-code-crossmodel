// `format` suite: does the model obey the OUTPUT specification?
//
// This is the most important suite for agent architecture: every agent (mech/slice/
// probe/gpt) depends on the model respecting a fixed format. A model that reasons well
// but ignores the format breaks the whole orchestration — and breaks silently, because
// the parser just returns garbage.
//
// Each task has `verify(text)` -> { score: 0..1, detail: string }.

const clean = (t) => (t || '').trim();

export default [
  {
    id: 'json-only',
    difficulty: 'easy',
    prompt: `Return a JSON with the fields "name" (string) and "age" (number) for: "John is 30 years old".
Answer with ONLY the raw JSON. No code blocks, no backticks, no explanation, no text before or after.`,
    verify(text) {
      const t = clean(text);
      if (/```/.test(t)) return { score: 0, detail: 'used a code block despite being forbidden' };
      let o;
      try { o = JSON.parse(t); } catch { return { score: 0, detail: 'output is not parseable raw JSON' }; }
      if (o?.name !== 'John') return { score: 0.5, detail: `name=${JSON.stringify(o?.name)}` };
      if (o?.age !== 30) return { score: 0.5, detail: `age=${JSON.stringify(o?.age)}` };
      return { score: 1, detail: 'ok' };
    },
  },

  {
    id: 'three-lines',
    difficulty: 'easy',
    prompt: `Answer with EXACTLY 3 lines, in this format and nothing else:
STATUS: <ok or error>
ITEMS: <an integer>
NOTE: <at most 8 words>

Context: processing finished fine and handled 42 records.`,
    verify(text) {
      const lines = clean(text).split('\n').filter((l) => l.trim());
      if (lines.length !== 3) return { score: 0, detail: `returned ${lines.length} lines, expected 3` };
      if (!/^STATUS:\s*(ok|error)\s*$/i.test(lines[0])) return { score: 0.33, detail: `line1 off format: ${lines[0].slice(0, 40)}` };
      const m = lines[1].match(/^ITEMS:\s*(\d+)\s*$/i);
      if (!m) return { score: 0.5, detail: `line2 off format: ${lines[1].slice(0, 40)}` };
      if (m[1] !== '42') return { score: 0.66, detail: `ITEMS=${m[1]}, expected 42` };
      const n = lines[2].match(/^NOTE:\s*(.+)$/i);
      if (!n) return { score: 0.75, detail: 'line3 missing NOTE: prefix' };
      const words = n[1].trim().split(/\s+/).length;
      if (words > 8) return { score: 0.85, detail: `NOTE has ${words} words, limit 8` };
      return { score: 1, detail: 'ok' };
    },
  },

  {
    id: 'hard-limit',
    difficulty: 'medium',
    prompt: `Explain what HTTP caching is using AT MOST 12 words.
Answer with only the sentence, don't mention the word count, no preamble, no quotes.`,
    verify(text) {
      const t = clean(text).replace(/^["']|["']$/g, '');
      if (/```/.test(t)) return { score: 0, detail: 'used a code block' };
      const lines = t.split('\n').filter((l) => l.trim());
      if (lines.length > 1) return { score: 0.3, detail: `returned ${lines.length} lines, expected 1` };
      const words = t.split(/\s+/).filter(Boolean).length;
      if (words === 0) return { score: 0, detail: 'empty' };
      if (words > 12) return { score: 0, detail: `${words} words, limit 12` };
      return { score: 1, detail: `${words} words` };
    },
  },

  {
    id: 'refuse-scope',
    difficulty: 'medium',
    prompt: `You are a MECHANICAL worker agent. Your only task: convert the list below to uppercase.
Hard rule: if the instruction is ambiguous or information is missing, you must NOT guess —
you must answer exactly the word AMBIGUOUS and nothing else.

List: convert the items to the correct format.

(Note: the list of items was not provided.)`,
    verify(text) {
      const t = clean(text).toUpperCase().replace(/[^A-Z]/g, '');
      if (t === 'AMBIGUOUS') return { score: 1, detail: 'recognized the ambiguity' };
      if (/AMBIGU/.test(t)) return { score: 0.6, detail: 'recognized it, but did not respect "nothing else"' };
      return { score: 0, detail: `made up an answer: ${clean(text).slice(0, 60)}` };
    },
  },

  {
    id: 'nested-json',
    difficulty: 'hard',
    prompt: `Return ONLY this JSON, no backticks and no surrounding text, filled in from the report:

{"customer":{"name":string,"phone":string|null},"pets":[{"name":string,"species":string}],"total":number}

Report: "Maria brought in the cat Nina and the dog Thor. She did not leave a phone
number. That's 2 animals total."

Rules: "total" is the number of pets. "phone" is null when not provided.
species must be "cat" or "dog", lowercase.`,
    verify(text) {
      const t = clean(text);
      if (/```/.test(t)) return { score: 0, detail: 'used a code block despite being forbidden' };
      let o;
      try { o = JSON.parse(t); } catch { return { score: 0, detail: 'not raw JSON' }; }
      let points = 0; const fails = [];
      if (o?.customer?.name === 'Maria') points++; else fails.push(`name=${JSON.stringify(o?.customer?.name)}`);
      if (o?.customer?.phone === null) points++; else fails.push(`phone=${JSON.stringify(o?.customer?.phone)}`);
      if (o?.total === 2) points++; else fails.push(`total=${JSON.stringify(o?.total)}`);
      const pets = Array.isArray(o?.pets) ? o.pets : [];
      const names = pets.map((p) => p?.name).sort().join(',');
      if (names === 'Nina,Thor') points++; else fails.push(`pets=${names}`);
      const sp = pets.map((p) => `${p?.name}:${p?.species}`).sort().join(',');
      if (sp === 'Nina:cat,Thor:dog') points++; else fails.push(`species=${sp}`);
      return { score: points / 5, detail: fails.length ? fails.join(' | ').slice(0, 120) : 'ok' };
    },
  },
];
