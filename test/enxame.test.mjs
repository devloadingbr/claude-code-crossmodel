// Tests of `crossmodel enxame` (D2091 section 6). No network and no real process: the launcher,
// the clock and `dormir` are injected, and the "provider" is a function that writes the JSONL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fatiar, validarFatia, juntar, ajustarPool, criarPool, resumo, rodarEnxame, validarPlano,
  carregarPreset, listarAlvo, extrairSessao, ehLimiteDeTaxa, LIMITE_RESUMO, ESPERA_LIMITE_MS, PISO_POOL, LIMITE_TENTATIVAS,
} from '../lib/enxame.mjs';

const PRESET = { chaves: ['arquivo', 'linha', 'severidade', 'titulo', 'evidencia'], vereditos: ['🔴', 'limpo'] };
const lerDe = (mapa) => (rel) => (rel in mapa ? { ok: true, valor: mapa[rel] } : { ok: false, erro: 'não existe' });

// A temp repo with `n` source files of 3 lines each; the caller removes it.
function repo(n = 4) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'enxame-'));
  mkdirSync(path.join(cwd, 'src'), { recursive: true });
  for (let i = 1; i <= n; i++) writeFileSync(path.join(cwd, 'src', `a${String(i).padStart(2, '0')}.ts`), 'um\ndois\ntres\n');
  return cwd;
}
const plano = (cwd, extra = {}) => ({
  versao: 1, id: 'ex-abc', cwd, sha: 'abc1234', proposito: 'achados', pergunta: 'o que está errado?',
  alvo: { caminhos: ['src'], excluir: [] }, fatias: null, alias: 'luna6', effort_fatia: 'high',
  effort_consolidacao: 'max', paralelo: 4, fatia_arquivos: 1, fatia_kb: 60, consolidar: false,
  saida: path.join(cwd, '.work', 'enxame', 'ex-abc'), ...extra,
});
const relogioFalso = () => {
  let t = 0;
  const dormidas = [];
  return { relogio: () => t, dormir: async (ms) => { dormidas.push(ms); t += ms; }, dormidas, avancar: (ms) => { t += ms; } };
};
// What the prompt tells the model: the exact files and the output path.
const lerPrompt = (prompt) => ({
  arquivos: [...prompt.matchAll(/^- (.+)$/gm)].map((m) => m[1]),
  // the resumed prompt carries only the feedback, which names the output as "reprovou <saida>."
  saida: (/em (\S+\.jsonl):/.exec(prompt) ?? /reprovou (\S+\.jsonl)\./.exec(prompt))?.[1] ?? null,
});
const linhaLimpa = (arquivo) => `${JSON.stringify({ arquivo, severidade: 'limpo' })}\n`;
// A provider that answers every fatia with a "limpo" line per file.
const bom = (job, cwd) => {
  const { arquivos, saida } = lerPrompt(job.prompt);
  writeFileSync(path.join(cwd, saida), arquivos.map(linhaLimpa).join(''));
  return { codigo: 0, stderr: '', log: '  1s · session sess-1\n' };
};
const comRepo = async (n, fn) => {
  const cwd = repo(n);
  try {
    await fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

test('fatiar respeita o limite de arquivos e agrupa por pasta', () => {
  const arq = ['b/x.ts', 'a/2.ts', 'a/1.ts', 'a/3.ts', 'b/y.ts'].map((caminho) => ({ caminho, kb: 1 }));
  assert.deepEqual(fatiar(arq, { fatia_arquivos: 2, fatia_kb: 60 }), [['a/1.ts', 'a/2.ts'], ['a/3.ts', 'b/x.ts'], ['b/y.ts']]);
});

test('fatiar respeita o limite de KB e um arquivo grande vira fatia sozinho', () => {
  const arq = [{ caminho: 'a/1.ts', kb: 30 }, { caminho: 'a/2.ts', kb: 20 }, { caminho: 'a/3.ts', kb: 200 }, { caminho: 'a/4.ts', kb: 20 }, { caminho: 'a/5.ts', kb: 20 }];
  assert.deepEqual(fatiar(arq, { fatia_arquivos: 15, fatia_kb: 60 }), [['a/1.ts', 'a/2.ts'], ['a/3.ts'], ['a/4.ts', 'a/5.ts']]);
});

test('validarFatia aceita uma fatia completa com "limpo" e citação válida', () => {
  const linhas = [
    JSON.stringify({ arquivo: 'src/a.ts', linha: 2, severidade: '🔴', titulo: 't', evidencia: ['src/a.ts:2'] }),
    JSON.stringify({ arquivo: 'src/b.ts', severidade: 'limpo' }),
  ];
  const r = validarFatia(linhas, ['src/a.ts', 'src/b.ts'], PRESET, lerDe({ 'src/a.ts': 'x\ny\nz\n' }));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('validarFatia reprova JSONL inválido', () => {
  const r = validarFatia(['{isto não é json', JSON.stringify({ arquivo: 'src/a.ts', severidade: 'limpo' })], ['src/a.ts'], PRESET, lerDe({}));
  assert.equal(r.ok, false);
  assert.match(r.motivos.join(' '), /linha 1 não é JSON válido/);
});

test('validarFatia reprova cobertura faltando', () => {
  const r = validarFatia([JSON.stringify({ arquivo: 'src/a.ts', severidade: 'limpo' })], ['src/a.ts', 'src/b.ts'], PRESET, lerDe({}));
  assert.equal(r.ok, false);
  assert.deepEqual(r.faltam, ['src/b.ts']);
});

test('validarFatia reprova citação de linha inexistente e de arquivo inexistente', () => {
  const linha = JSON.stringify({ arquivo: 'src/a.ts', linha: 1, severidade: '🔴', titulo: 't', evidencia: ['src/a.ts:99', 'src/fantasma.ts:1'] });
  const r = validarFatia([linha], ['src/a.ts'], PRESET, lerDe({ 'src/a.ts': 'x\ny\n' }));
  assert.equal(r.ok, false);
  assert.equal(r.citacoes.length, 2);
  assert.match(r.citacoes[0], /src\/a\.ts:99 \(o arquivo tem 2 linhas\)/);
  assert.match(r.citacoes[1], /não existe/);
});

test('validarFatia reprova linha sem as chaves do preset', () => {
  const r = validarFatia([JSON.stringify({ arquivo: 'src/a.ts', severidade: '🔴' })], ['src/a.ts'], PRESET, lerDe({}));
  assert.equal(r.ok, false);
  assert.match(r.motivos.join(' '), /sem a\(s\) chave\(s\): linha, titulo, evidencia/);
});

test('juntar não repete linha (arquivo, linha, identidade)', () => {
  const a = { arquivo: 'x.ts', linha: 3, titulo: 'um', severidade: '🔴' };
  const saida = juntar([[a, { arquivo: 'x.ts', severidade: 'limpo' }], [{ ...a }, { ...a, linha: 4 }, { arquivo: 'x.ts', severidade: 'limpo' }]]);
  assert.equal(saida.length, 3);
});

test('ajustarPool: cai pela metade no limite de taxa, com piso, e sobe +1 a cada 3 fatias boas', () => {
  let p = criarPool(12);
  p = ajustarPool(p, { tipo: 'limite' });
  assert.equal(p.atual, 6);
  p = ajustarPool(p, { tipo: 'limite' });
  assert.equal(p.atual, PISO_POOL);
  p = ajustarPool(p, { tipo: 'limite' });
  assert.equal(p.atual, PISO_POOL);
  p = ajustarPool(ajustarPool(p, { tipo: 'ok' }), { tipo: 'ok' });
  assert.equal(p.atual, PISO_POOL);
  p = ajustarPool(p, { tipo: 'ok' });
  assert.equal(p.atual, PISO_POOL + 1);
  let teto = criarPool(4);
  for (let i = 0; i < 9; i++) teto = ajustarPool(teto, { tipo: 'ok' });
  assert.equal(teto.atual, 4);
});

test('o pool nunca passa de "paralelo"', async () => {
  await comRepo(10, async (cwd) => {
    const c = relogioFalso();
    let emVoo = 0;
    let maximo = 0;
    const lancar = async (job) => {
      emVoo++;
      maximo = Math.max(maximo, emVoo);
      await new Promise((r) => setImmediate(r));
      emVoo--;
      return bom(job, cwd);
    };
    const r = await rodarEnxame(plano(cwd, { paralelo: 3 }), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(r.codigo, 0, r.linhas.join('\n'));
    assert.equal(maximo, 3);
    assert.match(r.linhas[0], /^enxame ex-abc: 10 fatias, 10 ok, 0 retomadas, 0 falhas/);
  });
});

test('limite de taxa: a fatia volta à fila depois de 60 s e o pool cai pela metade', async () => {
  await comRepo(6, async (cwd) => {
    const c = relogioFalso();
    const chamadas = new Map();
    let emVoo = 0;
    const lancar = async (job) => {
      const { saida } = lerPrompt(job.prompt);
      const n = (chamadas.get(saida) ?? 0) + 1;
      chamadas.set(saida, n);
      emVoo++;
      await new Promise((r) => setImmediate(r));
      emVoo--;
      if (saida.endsWith('f01.jsonl') && n === 1) return { codigo: 1, stderr: 'HTTP 429 too many requests', log: '' };
      return bom(job, cwd);
    };
    const r = await rodarEnxame(plano(cwd, { paralelo: 8 }), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(r.codigo, 0, r.linhas.join('\n'));
    assert.equal([...chamadas.entries()].find(([k]) => k.endsWith('f01.jsonl'))[1], 2);
    assert.deepEqual(c.dormidas, [ESPERA_LIMITE_MS]);
    assert.match(r.linhas[0], /6 fatias, 6 ok/);
  });
});

test('limite de taxa: espera 60 s no relógio injetado antes de lançar de novo', async () => {
  await comRepo(1, async (cwd) => {
    const c = relogioFalso();
    const quando = [];
    const lancar = async (job) => {
      quando.push(c.relogio());
      return quando.length === 1 ? { codigo: 1, stderr: 'rate limit exceeded', log: '' } : bom(job, cwd);
    };
    const r = await rodarEnxame(plano(cwd), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(r.codigo, 0, r.linhas.join('\n'));
    assert.deepEqual(c.dormidas, [ESPERA_LIMITE_MS]);
    assert.equal(quando[1] - quando[0], ESPERA_LIMITE_MS);
  });
});

test('limite de taxa em todas as tentativas vira falha, com o teto de lançamentos', async () => {
  await comRepo(1, async (cwd) => {
    const c = relogioFalso();
    let n = 0;
    const lancar = async () => { n++; return { codigo: 1, stderr: 'quota exceeded', log: '' }; };
    const r = await rodarEnxame(plano(cwd), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(n, LIMITE_TENTATIVAS);
    assert.equal(r.codigo, 4);
    assert.match(r.linhas.join('\n'), /limite de taxa em 3 tentativas/);
  });
});

test('erro sem limite de taxa é falha direta, sem nova tentativa', async () => {
  await comRepo(1, async (cwd) => {
    const c = relogioFalso();
    let n = 0;
    const lancar = async () => { n++; return { codigo: 2, stderr: 'binary crashed', log: '' }; };
    const r = await rodarEnxame(plano(cwd), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(n, 1);
    assert.equal(r.codigo, 4);
    assert.match(r.linhas.join('\n'), /processo saiu com código 2/);
  });
});

test('fatia reprovada é retomada uma vez com --resume da sessão e a lista do que faltou', async () => {
  await comRepo(2, async (cwd) => {
    const c = relogioFalso();
    const jobs = [];
    const lancar = async (job) => {
      jobs.push(job);
      const { saida } = lerPrompt(job.prompt);
      if (job.resume === null) {
        // 1st run: a line for a file outside the fatia, so the fatia's own file is uncovered.
        writeFileSync(path.join(cwd, saida), '{"arquivo": "outro.ts", "severidade": "limpo"}\n');
        return { codigo: 0, stderr: '', log: '  2s · session sess-9\n' };
      }
      const alvo = job.prompt.match(/sem nenhuma linha: (\S+)/)[1];
      writeFileSync(path.join(cwd, saida), linhaLimpa(alvo));
      return { codigo: 0, stderr: '', log: '' };
    };
    const r = await rodarEnxame(plano(cwd, { fatias: [['src/a01.ts']] }), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(r.codigo, 0, r.linhas.join('\n'));
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].resume, 'sess-9');
    assert.match(jobs[1].prompt, /sem nenhuma linha: src\/a01\.ts/);
    assert.match(r.linhas[0], /1 fatias, 1 ok, 1 retomadas, 0 falhas/);
  });
});

test('sem id de sessão a retomada é fria: nunca "last", e o prompt original vai junto', async () => {
  await comRepo(1, async (cwd) => {
    const c = relogioFalso();
    const jobs = [];
    const lancar = async (job) => {
      jobs.push(job);
      const { saida } = lerPrompt(job.prompt);
      if (jobs.length === 1) writeFileSync(path.join(cwd, saida), 'lixo\n');
      else writeFileSync(path.join(cwd, saida), linhaLimpa('src/a01.ts'));
      return { codigo: 0, stderr: '', log: '  2s · session ?\n' };
    };
    const r = await rodarEnxame(plano(cwd), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(r.codigo, 0, r.linhas.join('\n'));
    assert.equal(jobs[1].resume, null);
    assert.notEqual(jobs[1].resume, 'last');
    assert.match(jobs[1].prompt, /Leia SOMENTE estes arquivos/);
    assert.match(jobs[1].prompt, /A validação reprovou/);
  });
});

test('reprovada duas vezes vira falha, o enxame segue e sai com 4; o juntado só leva as aprovadas', async () => {
  await comRepo(3, async (cwd) => {
    const c = relogioFalso();
    let rodadas = 0;
    const lancar = async (job) => {
      const { arquivos, saida } = lerPrompt(job.prompt);
      // the retry prompt lists no files, so the fatia is told by its log path
      if (job.log.endsWith('f02.log')) {
        rodadas++;
        writeFileSync(path.join(cwd, saida), '{"arquivo": "src/a02.ts", "severidade": "🔴"}\n');
        return { codigo: 0, stderr: '', log: '  1s · session s2\n' };
      }
      return bom(job, cwd);
    };
    const r = await rodarEnxame(plano(cwd), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(rodadas, 2);
    assert.equal(r.codigo, 4);
    assert.match(r.linhas[0], /3 fatias, 2 ok, 1 retomadas, 1 falhas/);
    assert.match(r.linhas.join('\n'), /f02 \(1 arquivo\(s\)\)/);
    const juntado = readFileSync(path.join(cwd, '.work', 'enxame', 'ex-abc', 'juntado.jsonl'), 'utf8');
    assert.ok(juntado.includes('a01.ts') && juntado.includes('a03.ts') && !juntado.includes('a02.ts'));
  });
});

test('consolidação: uma execução com effort_consolidacao; falhar dá exit 1', async () => {
  await comRepo(2, async (cwd) => {
    const c = relogioFalso();
    const jobs = [];
    const lancar = async (job) => {
      jobs.push(job);
      if (job.effort === 'max') {
        writeFileSync(path.join(cwd, '.work', 'enxame', 'ex-abc', 'relatorio.md'), '# rel\n');
        return { codigo: 0, stderr: '', log: '' };
      }
      return bom(job, cwd);
    };
    const r = await rodarEnxame(plano(cwd, { consolidar: true }), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(r.codigo, 0, r.linhas.join('\n'));
    assert.equal(jobs.filter((j) => j.effort === 'max').length, 1);
    assert.match(r.linhas.join('\n'), /relatorio: .*relatorio\.md/);

    const quebra = await rodarEnxame(plano(cwd, { consolidar: true, id: 'ex-def', saida: path.join(cwd, '.work', 'enxame', 'ex-def') }), {
      lancar: async (job) => (job.effort === 'max' ? { codigo: 1, stderr: 'x', log: '' } : bom(job, cwd)),
      relogio: c.relogio, dormir: c.dormir,
    });
    assert.equal(quebra.codigo, 1);
    assert.match(quebra.linhas.join('\n'), /relatorio: não gerado \(falhou\)/);
  });
});

test('alvo vazio, plano inválido e alias desconhecido saem com 2', async () => {
  await comRepo(1, async (cwd) => {
    const c = relogioFalso();
    const lancar = async () => { throw new Error('não devia lançar'); };
    mkdirSync(path.join(cwd, 'vazio'));
    const vazio = await rodarEnxame(plano(cwd, { alvo: { caminhos: ['vazio'], excluir: [] } }), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(vazio.codigo, 2);
    const ruim = await rodarEnxame({ versao: 9 }, { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(ruim.codigo, 2);
    const alias = await rodarEnxame(plano(cwd), { lancar, relogio: c.relogio, dormir: c.dormir, aliases: ['outro'] });
    assert.equal(alias.codigo, 2);
    assert.match(alias.linhas[0], /alias/);
  });
});

test('o resumo tem no máximo 25 linhas, mesmo com dezenas de falhas', () => {
  const fatias = Array.from({ length: 60 }, (_, i) => ({ n: i + 1, arquivos: ['a.ts'], status: 'falha', retomada: true, motivo: 'm'.repeat(500) }));
  const linhas = resumo({ id: 'ex-x', minutos: 3.14159, fatias, linhas: [], preset: PRESET, juntado: '/j.jsonl', relatorio: null, consolidacao: 'sem linhas' });
  assert.ok(linhas.length <= LIMITE_RESUMO, `${linhas.length} linhas`);
  assert.match(linhas[0], /^enxame ex-x: 60 fatias, 0 ok, 60 retomadas, 60 falhas, 3.1 min$/);
  assert.ok(linhas.every((l) => l.length <= 345));
});

test('fatias.json é gravado e o prompt da fatia leva a lista exata, a SHA e a saída', async () => {
  await comRepo(2, async (cwd) => {
    const c = relogioFalso();
    const prompts = [];
    const lancar = async (job) => { prompts.push(job); return bom(job, cwd); };
    await rodarEnxame(plano(cwd, { fatia_arquivos: 2 }), { lancar, relogio: c.relogio, dormir: c.dormir });
    const fatias = JSON.parse(readFileSync(path.join(cwd, '.work', 'enxame', 'ex-abc', 'fatias.json'), 'utf8'));
    assert.deepEqual(fatias[0].arquivos, ['src/a01.ts', 'src/a02.ts']);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].prompt, /- src\/a01\.ts\n- src\/a02\.ts/);
    assert.match(prompts[0].prompt, /abc1234/);
    assert.match(prompts[0].prompt, /\.work\/enxame\/ex-abc\/f01\.jsonl/);
    assert.equal(prompts[0].write, true);
    assert.equal(prompts[0].effort, 'high');
    assert.ok(existsSync(path.join(cwd, '.work', 'enxame', 'ex-abc', 'juntado.jsonl')));
  });
});

test('um lançador que lança vira falha da fatia, não queda do enxame', async () => {
  await comRepo(1, async (cwd) => {
    const c = relogioFalso();
    const r = await rodarEnxame(plano(cwd), { lancar: async () => { throw new Error('boom'); }, relogio: c.relogio, dormir: c.dormir });
    assert.equal(r.codigo, 4);
  });
});

test('presets embarcados carregam; sessão e limite de taxa são lidos do log', () => {
  for (const n of ['mapa', 'confronto', 'achados', 'inventario', 'critica-teste']) {
    const p = carregarPreset(n);
    assert.equal(p.ok, true, `${n}: ${p.erro}`);
  }
  assert.equal(carregarPreset('nao-existe').ok, false);
  assert.equal(extrairSessao('  12s · session abc-123\n'), 'abc-123');
  assert.equal(extrairSessao('sem sessão'), null);
  assert.equal(ehLimiteDeTaxa('Error 429'), true);
  assert.equal(ehLimiteDeTaxa('tudo bem'), false);
  assert.equal(validarPlano({}).ok, false);
});

test('plano: teto_fatia_ms abaixo do mínimo ou fora de número é recusado', async () => {
  await comRepo(1, async (cwd) => {
    assert.equal(validarPlano(plano(cwd, { teto_fatia_ms: 599_999 })).ok, false);
    assert.equal(validarPlano(plano(cwd, { teto_fatia_ms: '900000' })).ok, false);
    assert.equal(validarPlano(plano(cwd, { teto_fatia_ms: 600_000 })).ok, true);
    assert.equal(validarPlano(plano(cwd)).ok, true);
  });
});

test('lançador que nunca resolve vira falha "passou do teto", sem retomada, e o enxame segue', async () => {
  await comRepo(2, async (cwd) => {
    const c = relogioFalso();
    const jobs = [];
    const lancar = (job) => {
      jobs.push(job);
      if (job.log.endsWith('f01.log')) return new Promise(() => {});
      return Promise.resolve(bom(job, cwd));
    };
    const prazos = [];
    // fake timer: the first launch (f01, the one that never resolves) times out at once; the others never do
    const temporizar = (ms) => {
      prazos.push(ms);
      return { promessa: prazos.length === 1 ? Promise.resolve() : new Promise(() => {}), cancelar: () => {} };
    };
    const r = await rodarEnxame(plano(cwd, { teto_fatia_ms: 600_000 }), { lancar, relogio: c.relogio, dormir: c.dormir, temporizar });
    assert.equal(r.codigo, 4, r.linhas.join('\n'));
    assert.match(r.linhas.join('\n'), /f01 .*passou do teto de 10 min/);
    assert.match(r.linhas[0], /2 fatias, 1 ok, 0 retomadas, 1 falhas/);
    assert.equal(jobs.filter((j) => j.log.endsWith('f01.log')).length, 1);
    assert.ok(jobs.every((j) => j.timeoutMs === 600_000));
    assert.ok(prazos.every((p) => p === 660_000));
  });
});

test('fatia que saiu com erro depois do teto também vira "passou do teto"', async () => {
  await comRepo(1, async (cwd) => {
    const c = relogioFalso();
    const lancar = async () => { c.avancar(1_800_000); return { codigo: 1, stderr: 'killed', log: '' }; };
    const r = await rodarEnxame(plano(cwd), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(r.codigo, 4);
    assert.match(r.linhas.join('\n'), /passou do teto de 30 min/);
  });
});

test('symlink que aponta para fora do cwd é recusado no alvo e na validação de citação', async () => {
  await comRepo(1, async (cwd) => {
    const fora = mkdtempSync(path.join(tmpdir(), 'enxame-fora-'));
    try {
      writeFileSync(path.join(fora, 'segredo.ts'), 'a\nb\n');
      symlinkSync(fora, path.join(cwd, 'src', 'ponte'));
      const l = listarAlvo(cwd, { caminhos: ['src/ponte'], excluir: [] });
      assert.equal(l.ok, false);
      assert.match(l.erro, /fora do cwd/);
      const v = validarPlano(plano(cwd, { alvo: { caminhos: ['src/ponte'], excluir: [] } }));
      assert.equal(v.ok, false);
      // the citation reader refuses it too
      const c = relogioFalso();
      const lancar = async (job) => {
        const { saida } = lerPrompt(job.prompt);
        writeFileSync(path.join(cwd, saida), `${JSON.stringify({ arquivo: 'src/a01.ts', severidade: '🔴', linha: 1, titulo: 't', evidencia: ['src/ponte/segredo.ts:1'] })}\n`);
        return { codigo: 0, stderr: '', log: '' };
      };
      const r = await rodarEnxame(plano(cwd, { fatias: [['src/a01.ts']] }), { lancar, relogio: c.relogio, dormir: c.dormir });
      assert.equal(r.codigo, 4);
      assert.match(r.linhas.join('\n'), /arquivo não existe/);
    } finally {
      rmSync(fora, { recursive: true, force: true });
    }
  });
});

test('limite de taxa só vale no stderr: "429" no log do modelo é falha comum, e o stderr entra no motivo', async () => {
  await comRepo(1, async (cwd) => {
    const c = relogioFalso();
    let n = 0;
    const lancar = async () => { n++; return { codigo: 1, stderr: 'capability refused: no write', log: 'o modelo falou de quota e 429' }; };
    const r = await rodarEnxame(plano(cwd), { lancar, relogio: c.relogio, dormir: c.dormir });
    assert.equal(n, 1);
    assert.deepEqual(c.dormidas, []);
    assert.match(r.linhas.join('\n'), /processo saiu com código 1: capability refused: no write/);
  });
});

test('placar conta "🟡 risco" sob a marca 🟡 do preset', () => {
  const linhas = [{ arquivo: 'a', severidade: '🟡 risco' }, { arquivo: 'b', severidade: '🟡' }, { arquivo: 'c', severidade: 'limpo' }];
  const r = resumo({ id: 'ex-a', fatias: [], linhas, preset: { chaves: ['severidade'], vereditos: ['🔴', '🟡', 'limpo'] } });
  assert.ok(r.join('\n').includes('🟡 2'), r.join('\n'));
});
