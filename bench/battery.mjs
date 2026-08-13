#!/usr/bin/env node
// Multi-model battery: runs suites against opus/sonnet/haiku/sol/terra/luna.
// 100% deterministic scoring — in the `code` suite, `node --test` is the judge.
//
//   node battery.mjs --suites code,review --models luna,terra,sol,haiku,sonnet,opus --repetitions 1
//   node battery.mjs --suites code --models luna --limit 1        # cheap smoke test

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callModel, MODELS, availableModels, extractJSON, extractCode } from '../lib/providers.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

if (process.argv.includes('--list')) {
  const models = await availableModels();
  for (const [alias, info] of Object.entries(models)) {
    console.log(`  ${alias.padEnd(7)} ${info.ok ? 'ok  ' : 'off '} ${info.why}`);
  }
  process.exit(0);
}

const SUITES = arg('suites', 'code').split(',').map((s) => s.trim());
const ALIASES = arg('models', 'luna,terra').split(',').map((s) => s.trim());
const REPETITIONS = Number(arg('repetitions', '1'));
const LIMIT = Number(arg('limit', '0'));

for (const a of ALIASES) {
  if (!MODELS[a]) {
    console.error(`unknown model alias: ${a}. Known: ${Object.keys(MODELS).join(', ')}`);
    process.exit(1);
  }
}

// ----------------------------------------------------------------- suite: code
function runTests(dir) {
  return new Promise((resolve) => {
    const p = spawn('node', ['--test', 'test.test.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve({ pass: 0, fail: 0, execError: 'test timed out' }); }, 30_000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
      clearTimeout(timer);
      const pass = Number((out.match(/^# pass (\d+)/m) || [])[1] ?? 0);
      const fail = Number((out.match(/^# fail (\d+)/m) || [])[1] ?? 0);
      // syntax/import error => no test ran
      const execError = pass + fail === 0
        ? (out.match(/(SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|Error)[^\n]*/) || ['did not execute'])[0].slice(0, 140)
        : null;
      resolve({ pass, fail, execError });
    });
  });
}

async function suiteCode(alias, task) {
  const prompt = `${task.spec}

Respond ONLY with the code inside a triple-backtick-fenced block.
No explanation before or after. The code must be a complete, valid ESM module.`;
  const r = await callModel(alias, prompt, { timeoutMs: 240_000 });
  if (!r.ok) return { score: 0, ms: r.ms, detail: `call failed: ${r.error}`.slice(0, 140) };

  const code = extractCode(r.text);
  if (!code) return { score: 0, ms: r.ms, detail: 'did not return a code block' };

  const dir = mkdtempSync(path.join(tmpdir(), `bench-${task.id}-`));
  try {
    writeFileSync(path.join(dir, 'impl.mjs'), code);
    writeFileSync(path.join(dir, 'test.test.mjs'), task.tests);
    const { pass, fail, execError } = await runTests(dir);
    const total = pass + fail;
    return {
      score: total ? pass / total : 0,
      ms: r.ms,
      pass, fail,
      detail: execError || (fail ? `${fail} test(s) failing` : 'all passed'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------- suite: review
const REVIEW_INSTR = 'You are a code reviewer. Analyze the snippet and respond ONLY with the JSON of the schema. '
  + 'Only count as a bug a CORRECTNESS DEFECT: wrong behavior, one tenant\'s data leaking into another, '
  + 'a silent failure, an unawaited promise, a swallowed error, non-deterministic output. '
  + 'Do NOT count as a bug: style, naming, formatting, architecture preference. '
  + 'When in doubt, answer hasBug=false — a false alarm is expensive.';

async function suiteReview(alias, task) {
  const prompt = `${REVIEW_INSTR}\n\n<code language="typescript">\n${task.code}\n</code>\n\n`
    + `Respond with a JSON: {"hasBug": boolean, "summary": string, "confidence": number}`;
  const isCodex = MODELS[alias].provider === 'codex';
  const r = await callModel(alias, prompt, {
    timeoutMs: 240_000,
    schemaPath: isCodex ? path.join(ROOT, 'schema-review.json') : undefined,
  });
  if (!r.ok) return { score: 0, ms: r.ms, detail: `call failed: ${r.error}`.slice(0, 140), invalid: true };

  const o = extractJSON(r.text, (x) => typeof x.hasBug === 'boolean');
  if (!o) return { score: 0, ms: r.ms, detail: 'no valid JSON in output', invalid: true };

  const correct = o.hasBug === task.hasBug;
  let rightCause = null;
  if (correct && task.hasBug && task.marker) {
    const t = (o.summary || '').toLowerCase();
    rightCause = task.marker.some((m) => t.includes(m.toLowerCase()));
  }
  return {
    score: correct ? 1 : 0,
    ms: r.ms,
    answered: o.hasBug, expected: task.hasBug, rightCause,
    detail: correct ? (rightCause === false ? 'correct, but wrong cause' : 'ok') : (o.summary || '').slice(0, 120),
  };
}

// --------------------------------------------------------------- suite: format
async function suiteFormat(alias, task) {
  // no --output-schema on purpose: the test IS whether the model obeys the
  // instruction on its own, not whether the CLI can force the format externally.
  const r = await callModel(alias, task.prompt, { timeoutMs: 180_000 });
  if (!r.ok) return { score: 0, ms: r.ms, detail: `call failed: ${r.error}`.slice(0, 140) };
  const v = task.verify(r.text);
  return { score: v.score, ms: r.ms, detail: v.detail };
}

// ------------------------------------------------------------- suite: classify
async function suiteClassify(alias, task) {
  const prompt = task.buildPrompt(task.items);
  const r = await callModel(alias, prompt, { timeoutMs: 180_000 });
  if (!r.ok) return { score: 0, ms: r.ms, detail: `call failed: ${r.error}`.slice(0, 140) };
  const o = extractJSON(r.text, (x) => Array.isArray(x.result));
  const v = task.verify(o, task.items);
  return { score: v.score, ms: r.ms, detail: v.detail };
}

// ---------------------------------------------------------------- orchestrate
const DEFS = {
  code: { load: async () => (await import('./tasks/code.mjs')).default, run: suiteCode },
  review: { load: async () => JSON.parse(readFileSync(path.join(ROOT, 'tasks/review.json'), 'utf8')), run: suiteReview },
  format: { load: async () => (await import('./tasks/format.mjs')).default, run: suiteFormat },
  classify: { load: async () => (await import('./tasks/classify.mjs')).default, run: suiteClassify },
};

const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);

(async () => {
  const plans = [];
  for (const s of SUITES) {
    if (!DEFS[s]) { console.error(`unknown suite: ${s}`); process.exit(1); }
    let tasks = await DEFS[s].load();
    if (LIMIT) tasks = tasks.slice(0, LIMIT);
    plans.push({ suite: s, tasks, run: DEFS[s].run });
  }
  const totalCalls = ALIASES.length * REPETITIONS * plans.reduce((a, p) => a + p.tasks.length, 0);
  console.log(`${ALIASES.length} models x ${REPETITIONS} rep x ${plans.map((p) => `${p.tasks.length} ${p.suite}`).join(' + ')} = ${totalCalls} calls`);
  console.log(`models run in PARALLEL (separate quota pools), tasks run in SERIES within each model\n`);

  // one model per "lane", running in parallel
  const results = await Promise.all(ALIASES.map(async (alias) => {
    const rows = [];
    for (const plan of plans) {
      for (let rep = 1; rep <= REPETITIONS; rep++) {
        for (const task of plan.tasks) {
          const r = await plan.run(alias, task);
          console.log(`  ${alias.padEnd(7)} ${plan.suite.padEnd(8)} ${String(task.id).padEnd(12)} score=${r.score.toFixed(2)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
          rows.push({ suite: plan.suite, task, rep, ...r });
        }
      }
    }
    return [alias, rows];
  }));

  // -------------------------------------------------------------------- report
  const md = [];
  md.push('# Model battery — where each model breaks\n');
  md.push(`Suites: ${SUITES.join(', ')} · ${REPETITIONS} repetition(s) · deterministic scoring (in the \`code\` suite, \`node --test\` is the judge).\n`);

  for (const suite of SUITES) {
    md.push(`\n## Suite \`${suite}\`\n`);
    const tasks = plans.find((p) => p.suite === suite).tasks;

    md.push('| Model | Provider | Overall score | ' + tasks.map((t) => `${t.id}${t.difficulty ? ` (${t.difficulty[0]})` : ''}`).join(' | ') + ' | Median |');
    md.push('|---|---|---:|' + tasks.map(() => '---:').join('|') + '|---:|');
    for (const [alias, rows] of results) {
      const mine = rows.filter((l) => l.suite === suite);
      if (!mine.length) continue;
      const avg = mine.reduce((a, l) => a + l.score, 0) / mine.length;
      const times = mine.map((l) => l.ms).sort((a, b) => a - b);
      const cells = tasks.map((t) => {
        const rs = mine.filter((l) => l.task.id === t.id);
        if (!rs.length) return '—';
        return pct(rs.reduce((a, l) => a + l.score, 0) / rs.length);
      });
      md.push(`| \`${alias}\` | ${MODELS[alias].provider} | **${pct(avg)}** | ${cells.join(' | ')} | ${times[Math.floor(times.length / 2)]}ms |`);
    }
    if (suite === 'code') {
      md.push('\nLetter in parentheses = difficulty (f=easy, m=medium, d=hard). Cell = % of tests that passed.\n');
    }

    md.push('\n### Where each one broke\n');
    md.push('| Model | Task | Score | What happened |');
    md.push('|---|---|---:|---|');
    let any = false;
    for (const [alias, rows] of results) {
      for (const l of rows.filter((x) => x.suite === suite && x.score < 1)) {
        any = true;
        md.push(`| \`${alias}\` | ${l.task.id} | ${pct(l.score)} | ${String(l.detail).replace(/\|/g, '\\|').slice(0, 130)} |`);
      }
    }
    if (!any) md.push('| — | — | — | no failures |');
  }

  md.push('\n## How to read this result\n');
  md.push('| Score on suite | Reading |');
  md.push('|---|---|');
  md.push('| 100% consistent across N repetitions | can rely on this task class unattended |');
  md.push('| 100% but flaky across runs | only with a deterministic checker afterward |');
  md.push('| breaks on `hard`, passes `easy`/`medium` | use it for the mechanical part, escalate the rest |');
  md.push('| breaks on `easy` | do not use it to generate code in this language |');

  mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  const name = `battery-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  writeFileSync(path.join(ROOT, 'results', `${name}.md`), md.join('\n'));
  writeFileSync(path.join(ROOT, 'results', `${name}.json`), JSON.stringify(Object.fromEntries(results), null, 2));
  console.log(`\n${md.join('\n')}`);
  console.log(`\nReport: results/${name}.md`);
})();
