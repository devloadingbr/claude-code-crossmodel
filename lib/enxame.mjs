// `crossmodel enxame <plano.json>`: one big sweep cut into small fatias, each read by one
// model run, in parallel. The shell does the parts a model should not do: it cuts the
// fatias, runs the pool, checks every answer by script, retries a rejected fatia once,
// joins the lines and prints one short summary. The model only reads a fatia and writes
// JSONL. Spec: D2091 (T44), sections 2, 3, 4 and 6.
//
// Anything that touches the clock or starts a process is a parameter of rodarEnxame
// (`relogio`, `dormir`, `lancar`), so the tests run the whole pool against a fake provider
// with no network and no real process.
//
// Errors are values: { ok: true, valor } or { ok: false, erro }. Nothing here throws a string,
// and no catch is left empty.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSAO_PLANO = 1;
export const PARALELO_MAX = 20;
export const PISO_POOL = 4;
// Teto de uma fatia: o padrão e o mínimo (o mesmo piso de --write do bin, 10 min).
export const TETO_FATIA_PADRAO_MS = 1_800_000;
export const TETO_FATIA_MIN_MS = 600_000;
// Folga além do teto antes de dar um lançador mudo por morto.
export const FOLGA_TETO_MS = 60_000;
export const ESPERA_LIMITE_MS = 60_000;
// Fatias boas seguidas até o pool subir um lugar de novo.
export const FATIAS_PARA_SUBIR = 3;
// Lançamentos de uma mesma fatia batidos no limite de taxa antes de virar falha.
export const LIMITE_TENTATIVAS = 3;
// O resumo é um aviso: nunca passa dessas linhas.
export const LIMITE_RESUMO = 25;
const LINHAS_FALHA = 15;
export const PRESETS_DIR = fileURLToPath(new URL('../enxame/presets/', import.meta.url));

const PASTAS_IGNORADAS = new Set(['node_modules', '.git', '.next', '.turbo']);
const CHAVES_DEDUP = ['id', 'titulo', 'o_que', 'problema', 'veredito', 'severidade'];
// The citation check of the T40 run: a path under a known folder, then :line. Verified on disk.
const CITACAO = /((?:src|scripts|drizzle|supabase|docs|\.github|tests?|e2e|\.work)\/[\w.\/()\[\]@-]+?\.\w+):(\d+)/g;
const LIMITE_TAXA = /429|rate limit|quota/i;
const SESSAO = /·\s*session\s+([\w.:-]+)/;
const MARCADORES = /\{(proposito|pergunta|arquivos|sha|saida)\}/g;

const isStr = (v) => typeof v === 'string' && v.length > 0;
const tentar = (fn) => {
  try {
    return { ok: true, valor: fn() };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
};
const normalizar = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const pastaDe = (p) => path.posix.dirname(normalizar(p));
const pad = (n) => String(n).padStart(2, '0');
const dentroDe = (raiz, alvo) => {
  const base = path.resolve(raiz);
  const abs = path.resolve(alvo);
  return abs === base || abs.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
};
// Same check on the real paths, so a symlink that points out of the cwd is caught. A path that
// does not exist yet passes here (the lexical check already ran; the read reports it missing).
const dentroDoCwdReal = (cwd, abs) => {
  const rc = tentar(() => realpathSync(cwd));
  const ra = tentar(() => realpathSync(abs));
  if (!rc.ok || !ra.ok) return true;
  return dentroDe(rc.valor, ra.valor);
};
const dentroDoCwd = (cwd, caminho) => dentroDe(cwd, path.resolve(cwd, caminho)) && dentroDoCwdReal(cwd, path.resolve(cwd, caminho));
const relativo = (raiz, alvo) => path.relative(raiz, alvo).split(path.sep).join('/');
const clip = (s, n = 200) => {
  const uma = String(s).replace(/\s+/g, ' ').trim();
  return uma.length > n ? `${uma.slice(0, n - 1)}…` : uma;
};
const parseJson = (texto) => tentar(() => JSON.parse(texto));
const contarLinhas = (texto) => (texto === '' ? 0 : texto.endsWith('\n') ? texto.split('\n').length - 1 : texto.split('\n').length);
const ehLimpo = (o) => o.veredito === 'limpo' || o.severidade === 'limpo';

export function lerTexto(caminho) {
  return tentar(() => readFileSync(caminho, 'utf8'));
}

/** Reads plano.json from disk and parses it. Shape checks are validarPlano's job. */
export function lerPlano(caminho) {
  const lido = lerTexto(caminho);
  if (!lido.ok) return { ok: false, erro: `não consegui ler ${caminho}: ${lido.erro}` };
  const obj = parseJson(lido.valor);
  if (!obj.ok) return { ok: false, erro: `${caminho} não é JSON: ${obj.erro}` };
  return { ok: true, valor: obj.valor };
}

/**
 * Checks the shape of plano.json (contract, spec section 2). `aliases`, when given, is the list of
 * model aliases this build knows; a plan naming any other alias is refused here, not per fatia.
 */
export function validarPlano(plano, { aliases } = {}) {
  const nao = (campo, motivo) => ({ ok: false, erro: `plano.json: ${campo} ${motivo}` });
  if (!plano || typeof plano !== 'object' || Array.isArray(plano)) return nao('(raiz)', 'precisa ser um objeto JSON');
  if (plano.versao !== VERSAO_PLANO) return nao('versao', `precisa ser ${VERSAO_PLANO}`);
  if (!isStr(plano.id) || !/^ex-[0-9a-z]+$/.test(plano.id)) return nao('id', 'precisa ser "ex-" seguido de base36');
  if (!isStr(plano.cwd) || !path.isAbsolute(plano.cwd)) return nao('cwd', 'precisa ser caminho absoluto');
  if (!isStr(plano.sha) || !/^[0-9a-f]{7,64}$/.test(plano.sha)) return nao('sha', 'precisa ser um SHA git em hexadecimal');
  if (!isStr(plano.proposito) || !/^[a-z-]+$/.test(plano.proposito)) return nao('proposito', 'precisa ser o nome de um preset');
  if (!isStr(plano.pergunta) || !plano.pergunta.trim()) return nao('pergunta', 'precisa ser texto não vazio');
  if (!isStr(plano.alias) || (aliases && !aliases.includes(plano.alias))) return nao('alias', `não é um modelo conhecido: ${plano.alias}`);
  if (!isStr(plano.effort_fatia)) return nao('effort_fatia', 'precisa ser texto não vazio');
  if (!isStr(plano.effort_consolidacao)) return nao('effort_consolidacao', 'precisa ser texto não vazio');
  if (!Number.isInteger(plano.paralelo) || plano.paralelo < 1 || plano.paralelo > PARALELO_MAX) {
    return nao('paralelo', `precisa ser inteiro de 1 a ${PARALELO_MAX}`);
  }
  if (!Number.isInteger(plano.fatia_arquivos) || plano.fatia_arquivos < 1) return nao('fatia_arquivos', 'precisa ser inteiro maior que 0');
  if (typeof plano.fatia_kb !== 'number' || !(plano.fatia_kb > 0)) return nao('fatia_kb', 'precisa ser número maior que 0');
  if (plano.teto_fatia_ms !== undefined
    && (typeof plano.teto_fatia_ms !== 'number' || !Number.isFinite(plano.teto_fatia_ms) || plano.teto_fatia_ms < TETO_FATIA_MIN_MS)) {
    return nao('teto_fatia_ms', `precisa ser número de pelo menos ${TETO_FATIA_MIN_MS} (ms)`);
  }
  if (typeof plano.consolidar !== 'boolean') return nao('consolidar', 'precisa ser true ou false');
  if (!isStr(plano.saida) || !path.isAbsolute(plano.saida)
    || path.resolve(plano.saida) === path.resolve(plano.cwd) || !dentroDe(plano.cwd, plano.saida)) {
    return nao('saida', 'precisa ser caminho absoluto dentro do cwd');
  }
  if (plano.fatias !== null && plano.fatias !== undefined) {
    if (!Array.isArray(plano.fatias) || !plano.fatias.length
      || !plano.fatias.every((f) => Array.isArray(f) && f.length && f.every(isStr))) {
      return nao('fatias', 'precisa ser null ou lista de listas de caminhos');
    }
    const fora = plano.fatias.flat().find((c) => !dentroDoCwd(plano.cwd, c));
    if (fora) return nao('fatias', `${fora} está fora do cwd`);
  } else {
    const alvo = plano.alvo;
    if (!alvo || typeof alvo !== 'object' || !Array.isArray(alvo.caminhos) || !alvo.caminhos.length || !alvo.caminhos.every(isStr)) {
      return nao('alvo.caminhos', 'precisa ser lista de caminhos, com ao menos um');
    }
    if (alvo.excluir !== undefined && (!Array.isArray(alvo.excluir) || !alvo.excluir.every(isStr))) {
      return nao('alvo.excluir', 'precisa ser lista de padrões');
    }
    const fora = alvo.caminhos.find((c) => !dentroDoCwd(plano.cwd, c));
    if (fora) return nao('alvo.caminhos', `${fora} está fora do cwd`);
  }
  return { ok: true, valor: plano };
}

/**
 * Cuts the files into fatias. Files are ordered by folder, then by path, so each folder's
 * files sit together. A fatia is cut when adding the next file would pass `fatia_arquivos`
 * files or `fatia_kb` KB. A file bigger than `fatia_kb` is a fatia on its own.
 * Pure: the sizes come in as `kb`; nothing is read here.
 * @param {{caminho: string, kb: number}[]} arquivos
 * @returns {string[][]}
 */
export function fatiar(arquivos, { fatia_arquivos, fatia_kb }) {
  const ordem = [...arquivos].sort((a, b) => {
    const pa = pastaDe(a.caminho);
    const pb = pastaDe(b.caminho);
    if (pa !== pb) return pa < pb ? -1 : 1;
    const ca = normalizar(a.caminho);
    const cb = normalizar(b.caminho);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
  const fatias = [];
  let atual = [];
  let kbAtual = 0;
  const fechar = () => {
    if (atual.length) fatias.push(atual);
    atual = [];
    kbAtual = 0;
  };
  for (const a of ordem) {
    const caminho = normalizar(a.caminho);
    if (a.kb > fatia_kb) {
      fechar();
      fatias.push([caminho]);
      continue;
    }
    if (atual.length && (atual.length >= fatia_arquivos || kbAtual + a.kb > fatia_kb)) fechar();
    atual.push(caminho);
    kbAtual += a.kb;
  }
  fechar();
  return fatias;
}

/** Glob to RegExp for `alvo.excluir`: `**` crosses folders, `*` and `?` do not. */
export function globParaRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

// A file is binary when its first 8 KB hold a NUL byte.
function ehBinario(caminho) {
  return tentar(() => {
    const fd = openSync(caminho, 'r');
    try {
      const buf = Buffer.alloc(8000);
      const n = readSync(fd, buf, 0, 8000, 0);
      return buf.subarray(0, n).includes(0);
    } finally {
      closeSync(fd);
    }
  });
}

/**
 * Lists the files of `alvo` from the disk, not from git: the `.work` folder is not tracked.
 * Skips node_modules, .git, .next and binaries, and applies `excluir` against the path
 * relative to cwd. Returns [{caminho, kb}] sorted by path.
 */
export function listarAlvo(cwd, alvo) {
  const excluir = (alvo.excluir ?? []).map(globParaRegex);
  const achados = new Set();
  const percorrer = (dir) => {
    const lista = tentar(() => readdirSync(dir, { withFileTypes: true }));
    if (!lista.ok) return lista;
    for (const ent of lista.valor) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (PASTAS_IGNORADAS.has(ent.name)) continue;
        const r = percorrer(abs);
        if (!r.ok) return r;
      } else if (ent.isFile()) {
        achados.add(abs);
      }
    }
    return { ok: true, valor: null };
  };
  for (const c of alvo.caminhos) {
    const raiz = path.resolve(cwd, c);
    if (!dentroDe(cwd, raiz) || !dentroDoCwdReal(cwd, raiz)) return { ok: false, erro: `${c} está fora do cwd` };
    const st = tentar(() => statSync(raiz));
    if (!st.ok) return { ok: false, erro: `${c} não existe` };
    if (st.valor.isFile()) {
      achados.add(raiz);
    } else {
      const r = percorrer(raiz);
      if (!r.ok) return { ok: false, erro: `${c}: ${r.erro}` };
    }
  }
  const arquivos = [];
  for (const abs of [...achados].sort()) {
    const caminho = relativo(cwd, abs);
    if (excluir.some((re) => re.test(caminho))) continue;
    const bin = ehBinario(abs);
    if (!bin.ok) return { ok: false, erro: `não consegui ler ${caminho}: ${bin.erro}` };
    if (bin.valor) continue;
    const tam = tentar(() => statSync(abs).size);
    if (!tam.ok) return { ok: false, erro: `não consegui medir ${caminho}: ${tam.erro}` };
    arquivos.push({ caminho, kb: tam.valor / 1024 });
  }
  return { ok: true, valor: arquivos };
}

/** Loads a preset `{prompt, chaves, vereditos}` by name. `dir` defaults to enxame/presets. */
export function carregarPreset(nome, dir = PRESETS_DIR) {
  if (!/^[a-z-]+$/.test(String(nome))) return { ok: false, erro: `preset "${nome}" não existe (nome inválido)` };
  const lido = lerTexto(path.join(dir, `${nome}.json`));
  if (!lido.ok) return { ok: false, erro: `preset "${nome}" não encontrado em ${dir}` };
  const obj = parseJson(lido.valor);
  if (!obj.ok) return { ok: false, erro: `preset "${nome}" não é JSON` };
  const p = obj.valor;
  const formato = isStr(p?.prompt)
    && ['arquivos', 'saida'].every((m) => p.prompt.includes(`{${m}}`))
    && Array.isArray(p.chaves) && p.chaves.every(isStr)
    && Array.isArray(p.vereditos);
  if (!formato) return { ok: false, erro: `preset "${nome}" fora do formato {prompt, chaves, vereditos}` };
  return { ok: true, valor: p };
}

/** Fills the five markers of a preset prompt in one pass, so a value can never be filled twice. */
export function preencherPrompt(modelo, valores) {
  const pronto = { ...valores, arquivos: valores.arquivos.map((a) => `- ${a}`).join('\n') };
  return modelo.replace(MARCADORES, (_, nome) => pronto[nome]);
}

/**
 * Checks one fatia's JSONL (spec section 3, steps 3a to 3d). `linhas` are the raw lines of the
 * file; `fatia` the exact list of files; `lerArquivo(relPath)` returns a Result with the text
 * of a file relative to cwd. Returns { ok, motivos, faltam, citacoes, linhas } where `linhas`
 * are the parsed objects.
 */
export function validarFatia(linhas, fatia, preset, lerArquivo) {
  const motivos = [];
  const objetos = [];
  linhas.forEach((texto, i) => {
    if (!texto.trim()) return;
    const r = parseJson(texto);
    if (!r.ok) {
      motivos.push(`linha ${i + 1} não é JSON válido`);
      return;
    }
    if (!r.valor || typeof r.valor !== 'object' || Array.isArray(r.valor)) {
      motivos.push(`linha ${i + 1} não é um objeto`);
      return;
    }
    objetos.push(r.valor);
  });

  // (b) cobertura: every file of the fatia appears in at least one line.
  const cobertos = new Set(objetos.filter((o) => isStr(o.arquivo)).map((o) => normalizar(o.arquivo)));
  const faltam = fatia.filter((a) => !cobertos.has(normalizar(a)));

  // (d) chaves: a "limpo" line needs only `arquivo`; every other line needs the preset's chaves.
  const ausentes = new Set();
  let linhasSemChave = 0;
  for (const o of objetos) {
    const exigidas = ehLimpo(o) ? ['arquivo'] : preset.chaves;
    const falta = exigidas.filter((k) => o[k] === undefined);
    if (falta.length) {
      linhasSemChave++;
      falta.forEach((k) => ausentes.add(k));
    }
  }
  if (linhasSemChave) motivos.push(`${linhasSemChave} linha(s) sem a(s) chave(s): ${[...ausentes].join(', ')}`);

  // (c) citações: every arquivo:linha must name a file that exists and a line inside it.
  const citacoes = new Set();
  const total = new Map();
  for (const o of objetos) {
    for (const texto of textosDe(o)) {
      for (const m of texto.matchAll(CITACAO)) {
        const [, arq, numStr] = m;
        const n = Number(numStr);
        if (!total.has(arq)) {
          const lido = lerArquivo(arq);
          total.set(arq, lido.ok ? contarLinhas(lido.valor) : null);
        }
        const tot = total.get(arq);
        if (tot === null) citacoes.add(`${arq}:${numStr} (arquivo não existe)`);
        else if (n < 1 || n > tot) citacoes.add(`${arq}:${numStr} (o arquivo tem ${tot} linhas)`);
      }
    }
  }

  const ok = motivos.length === 0 && faltam.length === 0 && citacoes.size === 0;
  return { ok, motivos, faltam, citacoes: [...citacoes], linhas: objetos };
}

function textosDe(v, acc = []) {
  if (typeof v === 'string') acc.push(v);
  else if (Array.isArray(v)) v.forEach((x) => textosDe(x, acc));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => textosDe(x, acc));
  return acc;
}

// Dedup key of a line: arquivo, linha and the first identity field the line has. A line with
// none of them is compared whole, so only an exact repeat is dropped.
function chaveDeLinha(l) {
  const ident = CHAVES_DEDUP.find((k) => l[k] !== undefined);
  const parte = ident ? `${ident}=${String(l[ident])}` : JSON.stringify(l);
  return JSON.stringify([l.arquivo ?? null, l.linha ?? null, parte]);
}

/** Joins the lists of parsed lines and drops repeats by (arquivo, linha, identity). */
export function juntar(listas) {
  const vistos = new Set();
  const saida = [];
  for (const lista of listas) {
    for (const l of lista) {
      const k = chaveDeLinha(l);
      if (vistos.has(k)) continue;
      vistos.add(k);
      saida.push(l);
    }
  }
  return saida;
}

function placar(linhas, preset) {
  const chave = preset.chaves.includes('severidade') ? 'severidade' : preset.chaves.includes('veredito') ? 'veredito' : null;
  if (!chave) {
    const arquivos = new Set(linhas.map((l) => l.arquivo)).size;
    return `placar: ${linhas.length} linhas em ${arquivos} arquivo(s)`;
  }
  const contagem = new Map(preset.vereditos.map((v) => [v, 0]));
  let sem = 0;
  for (const l of linhas) {
    if (l[chave] === undefined) {
      sem++;
      continue;
    }
    const v = String(l[chave]);
    contagem.set(v, (contagem.get(v) ?? 0) + 1);
  }
  const partes = [...contagem].map(([v, n]) => `${v} ${n}`);
  if (sem) partes.push(`sem ${chave} ${sem}`);
  return `placar (${chave}): ${partes.join(' · ')}`;
}

/**
 * The summary printed on stdout (the aviso to the director): at most 25 lines, never a
 * transcript. `estado` = { id, minutos, fatias: [{n, arquivos, status, retomada, motivo}],
 * linhas (juntado), preset, juntado, relatorio, consolidacao }.
 */
export function resumo(estado) {
  const { id, minutos, fatias, linhas, preset, juntado, relatorio, consolidacao } = estado;
  const oks = fatias.filter((f) => f.status === 'ok').length;
  const retomadas = fatias.filter((f) => f.retomada).length;
  const falhas = fatias.filter((f) => f.status === 'falha');
  const saida = [
    `enxame ${id}: ${fatias.length} fatias, ${oks} ok, ${retomadas} retomadas, ${falhas.length} falhas, ${Math.round(minutos * 10) / 10} min`,
    placar(linhas, preset),
    `juntado: ${juntado} (${linhas.length} linhas)`,
    relatorio ? `relatorio: ${relatorio}` : `relatorio: não gerado (${consolidacao})`,
  ];
  if (falhas.length) {
    saida.push('fatias com falha:');
    for (const f of falhas.slice(0, LINHAS_FALHA)) {
      saida.push(clip(`  f${pad(f.n)} (${f.arquivos.length} arquivo(s)): ${f.motivo}`, 340));
    }
    if (falhas.length > LINHAS_FALHA) saida.push(`  … e mais ${falhas.length - LINHAS_FALHA}`);
  }
  return saida.slice(0, LIMITE_RESUMO);
}

export function criarPool(teto) {
  return { atual: teto, teto, boas: 0 };
}

/**
 * The pool of concurrent runs. `{tipo: 'limite'}` (a 429, "rate limit" or "quota") halves it,
 * with a floor of PISO_POOL and never above the ceiling. `{tipo: 'ok'}` (a validated fatia)
 * adds one slot after FATIAS_PARA_SUBIR good fatias in a row, up to the ceiling.
 */
export function ajustarPool(pool, evento) {
  if (evento.tipo === 'limite') {
    return { ...pool, atual: Math.min(pool.teto, Math.max(PISO_POOL, Math.floor(pool.atual / 2))), boas: 0 };
  }
  if (evento.tipo === 'ok') {
    const boas = pool.boas + 1;
    if (boas < FATIAS_PARA_SUBIR) return { ...pool, boas };
    return { ...pool, atual: Math.min(pool.teto, pool.atual + 1), boas: 0 };
  }
  return pool;
}

/** Session id from the run log ("  12s · session <id>"), or null. "?" means the provider gave none. */
export function extrairSessao(log) {
  const m = SESSAO.exec(log ?? '');
  return m ? m[1] : null;
}

/** True when a failed run's text says the provider is rate-limiting or out of quota. */
export function ehLimiteDeTaxa(texto) {
  return LIMITE_TAXA.test(texto ?? '');
}

/** Prompt of the retry after a rejected fatia: what is missing, and a rewrite of the whole file. */
export function promptRetomada({ saida, faltam, citacoes, motivos }) {
  const linhas = [`A validação reprovou ${saida}. Corrija e reescreva o arquivo inteiro:`];
  if (faltam.length) linhas.push(`- arquivos da fatia sem nenhuma linha: ${faltam.join(', ')}`);
  if (citacoes.length) linhas.push(`- citações que não existem no arquivo: ${citacoes.join('; ')}`);
  for (const m of motivos) linhas.push(`- ${m}`);
  linhas.push('Cada arquivo da fatia precisa de ao menos uma linha, e toda citação arquivo:linha tem de apontar para uma linha que existe. Não escreva nada além do arquivo.');
  return linhas.join('\n');
}

/** Prompt of the one consolidation run: reads only the joined lines, writes the report. */
export function promptConsolidacao({ proposito, pergunta, juntado, relatorio, chave }) {
  return [
    `Você consolida uma varredura feita em fatias (propósito: ${proposito}). Pergunta: ${pergunta}`,
    `Leia SÓ o arquivo ${juntado}: uma linha JSON por item achado nas fatias. Não leia nenhum outro arquivo.`,
    `Grave ${relatorio} em Markdown, com: 1) o placar por ${chave ?? 'arquivo'} (contagem de cada valor); 2) os achados principais, cada um com arquivo:linha; 3) o que ficou sem resposta.`,
    'Responda só gravando o relatório.',
  ].join('\n\n');
}

function motivoReprovada({ faltam, citacoes, motivos }) {
  const partes = [];
  if (faltam.length) partes.push(`${faltam.length} sem linha (ex.: ${faltam[0]})`);
  if (citacoes.length) partes.push(`${citacoes.length} citação(ões) inválida(s) (ex.: ${citacoes[0]})`);
  partes.push(...motivos);
  return partes.join(' · ') || 'reprovada sem detalhe';
}

function prepararFatias(plano) {
  if (plano.fatias) {
    const ausente = plano.fatias.flat().find((c) => !existsSync(path.resolve(plano.cwd, c)));
    if (ausente) return { ok: false, erro: `fatias: ${ausente} não existe no cwd` };
    return { ok: true, valor: plano.fatias.map((f) => f.map(normalizar)) };
  }
  const lista = listarAlvo(plano.cwd, plano.alvo);
  if (!lista.ok) return { ok: false, erro: `alvo: ${lista.erro}` };
  if (!lista.valor.length) return { ok: false, erro: 'alvo: nenhum arquivo para varrer (binários, node_modules e excluir já descontados)' };
  return { ok: true, valor: fatiar(lista.valor, plano) };
}

// The launcher is injected; a throw from it becomes a value, never a crash of the enxame.
// A launcher that never resolves must not hold the pool: a timer of teto + FOLGA_TETO_MS turns it
// into a failure (`estourou`). `temporizar(ms)` -> { promessa, cancelar } is injected; the default
// is a real, unref'd timer that is cancelled when the launcher answers.
const temporizadorReal = (ms) => {
  let id;
  const promessa = new Promise((resolve) => {
    id = setTimeout(resolve, ms);
    id.unref?.();
  });
  return { promessa, cancelar: () => clearTimeout(id) };
};
const lancarSeguro = async (lancar, job, temporizar = temporizadorReal) => {
  const t = temporizar((job.timeoutMs ?? TETO_FATIA_PADRAO_MS) + FOLGA_TETO_MS);
  const lancado = Promise.resolve()
    .then(() => lancar(job))
    .catch((e) => ({ codigo: null, stderr: `lançamento falhou: ${e instanceof Error ? e.message : String(e)}`, log: '' }));
  const r = await Promise.race([lancado, t.promessa.then(() => ({ codigo: null, stderr: '', log: '', estourou: true }))]);
  t.cancelar();
  return r;
};

const falhaDoEnxame = (erro, codigo) => ({ codigo, linhas: [`enxame: ${erro}`], erro });

/**
 * Runs the whole enxame. `deps`:
 *   lancar(job) -> Promise<{codigo, stderr, log}>  starts one run (job: alias, effort, cwd,
 *                 log, prompt, resume, write). The real one spawns crossmodel; a test passes a fake.
 *   relogio()   -> ms                              the clock.
 *   dormir(ms)  -> Promise<void>                   waits (the 60 s after a rate limit).
 *   aliases?    -> string[]                        known model aliases, to refuse a bad plan early.
 *   presetsDir? -> string                          where the presets live (default enxame/presets).
 * Returns { codigo, linhas } with the exit code of spec section 3, step 8.
 */
export async function rodarEnxame(entrada, deps) {
  const { lancar, relogio, dormir, aliases, presetsDir, temporizar } = deps;
  const v = validarPlano(entrada, { aliases });
  if (!v.ok) return falhaDoEnxame(v.erro, 2);
  const plano = v.valor;
  const preset = carregarPreset(plano.proposito, presetsDir);
  if (!preset.ok) return falhaDoEnxame(preset.erro, 2);
  const { cwd, saida } = plano;
  const teto = plano.teto_fatia_ms ?? TETO_FATIA_PADRAO_MS;
  const inicio = relogio();

  // 1. fatiar, sem modelo.
  const prep = prepararFatias(plano);
  if (!prep.ok) return falhaDoEnxame(prep.erro, 2);
  const fatias = prep.valor;
  const arquivoDaFatia = (n, ext) => path.join(saida, `f${pad(n)}.${ext}`);
  const gravouFatias = tentar(() => {
    mkdirSync(saida, { recursive: true });
    writeFileSync(path.join(saida, 'fatias.json'), `${JSON.stringify(fatias.map((arquivos, i) => ({ n: i + 1, arquivos })), null, 2)}\n`);
  });
  if (!gravouFatias.ok) return falhaDoEnxame(`não consegui gravar em ${saida}: ${gravouFatias.erro}`, 1);

  const itens = fatias.map((arquivos, i) => ({
    n: i + 1, arquivos, prontaEm: 0, limites: 0, retomada: false, resume: null, feedback: null, status: null, motivo: null, linhas: [],
  }));
  const pendentes = [...itens];
  const ativos = new Map();
  let pool = criarPool(plano.paralelo);
  const lerArquivo = (rel) => {
    const abs = path.resolve(cwd, rel);
    if (!dentroDe(cwd, abs) || !dentroDoCwdReal(cwd, abs)) return { ok: false, erro: 'fora do cwd' };
    return lerTexto(abs);
  };

  const encerrar = (item, motivo) => {
    item.status = 'falha';
    item.motivo = clip(motivo, 320);
  };

  // 2 and 3. One run of a fatia, then the script checks its JSONL. Never rejects.
  const executar = async (item) => {
    const base = preencherPrompt(preset.valor.prompt, {
      proposito: plano.proposito,
      pergunta: plano.pergunta,
      arquivos: item.arquivos,
      sha: plano.sha,
      saida: relativo(cwd, arquivoDaFatia(item.n, 'jsonl')),
    });
    // A resumed session already holds the prompt, so it gets only the feedback.
    const prompt = item.feedback === null ? base : item.resume ? item.feedback : `${base}\n\n${item.feedback}`;
    const t0 = relogio();
    const r = await lancarSeguro(lancar, {
      alias: plano.alias,
      effort: plano.effort_fatia,
      cwd,
      log: arquivoDaFatia(item.n, 'log'),
      prompt,
      resume: item.resume,
      write: true,
      timeoutMs: teto,
    }, temporizar);
    if (r.codigo !== 0) {
      // Past the ceiling: a failure with no resume, the enxame goes on.
      if (r.estourou || relogio() - t0 >= teto) return { tipo: 'falha', motivo: `passou do teto de ${Math.round(teto / 60_000)} min` };
      // Only the stderr says "rate limit": the log holds the model's own text.
      if (ehLimiteDeTaxa(r.stderr ?? '')) return { tipo: 'limite' };
      const resto = clip(String(r.stderr ?? '').slice(-200));
      return { tipo: 'falha', motivo: `processo saiu com código ${r.codigo ?? 'nenhum'}${resto ? `: ${resto}` : ''}` };
    }
    const sessao = extrairSessao(r.log);
    const lido = lerTexto(arquivoDaFatia(item.n, 'jsonl'));
    if (!lido.ok) {
      return { tipo: 'reprovada', sessao, faltam: [...item.arquivos], citacoes: [], motivos: ['arquivo de saída não foi gravado'] };
    }
    const check = validarFatia(lido.valor.split('\n'), item.arquivos, preset.valor, lerArquivo);
    if (check.ok) return { tipo: 'ok', linhas: check.linhas };
    return { tipo: 'reprovada', sessao, faltam: check.faltam, citacoes: check.citacoes, motivos: check.motivos };
  };

  const tratar = (item, res) => {
    if (res.tipo === 'ok') {
      item.status = 'ok';
      item.linhas = res.linhas;
      pool = ajustarPool(pool, { tipo: 'ok' });
      return;
    }
    if (res.tipo === 'limite') {
      pool = ajustarPool(pool, { tipo: 'limite' });
      item.limites += 1;
      if (item.limites >= LIMITE_TENTATIVAS) {
        encerrar(item, `limite de taxa em ${item.limites} tentativas`);
        return;
      }
      item.prontaEm = relogio() + ESPERA_LIMITE_MS;
      pendentes.push(item);
      return;
    }
    if (res.tipo === 'falha') {
      encerrar(item, res.motivo);
      return;
    }
    // Rejected by the script. One retry, with the session when the provider gave one; the cold
    // retry carries the same feedback in the prompt. A second rejection is a failure.
    if (item.retomada) {
      encerrar(item, motivoReprovada(res));
      return;
    }
    item.retomada = true;
    item.resume = res.sessao ?? null;
    item.feedback = promptRetomada({
      saida: relativo(cwd, arquivoDaFatia(item.n, 'jsonl')),
      faltam: res.faltam,
      citacoes: res.citacoes,
      motivos: res.motivos,
    });
    item.prontaEm = relogio();
    pendentes.push(item);
  };

  // 2. The pool: at most pool.atual runs at once; a fatia can wait for its turn (the 60 s).
  while (pendentes.length || ativos.size) {
    const agora = relogio();
    while (ativos.size < pool.atual) {
      const i = pendentes.findIndex((it) => it.prontaEm <= agora);
      if (i < 0) break;
      const [item] = pendentes.splice(i, 1);
      const chave = {};
      ativos.set(chave, executar(item).then((res) => ({ chave, item, res })));
    }
    if (ativos.size === 0) {
      const prox = Math.min(...pendentes.map((it) => it.prontaEm));
      await dormir(Math.max(0, prox - relogio()));
      continue;
    }
    const { chave, item, res } = await Promise.race(ativos.values());
    ativos.delete(chave);
    tratar(item, res);
  }

  // 5. Join the lines of the fatias that passed.
  const juntado = juntar(itens.filter((it) => it.status === 'ok').map((it) => it.linhas));
  const arqJuntado = path.join(saida, 'juntado.jsonl');
  const gravouJuntado = tentar(() => writeFileSync(arqJuntado, juntado.map((l) => `${JSON.stringify(l)}\n`).join('')));
  if (!gravouJuntado.ok) return falhaDoEnxame(`não consegui gravar juntado.jsonl: ${gravouJuntado.erro}`, 1);

  // 6. One consolidation run, only when asked and there is something to consolidate.
  let consolidacao = plano.consolidar ? 'sem linhas' : 'desligada';
  let relatorio = null;
  if (plano.consolidar && juntado.length) {
    const arqRel = path.join(saida, 'relatorio.md');
    const r = await lancarSeguro(lancar, {
      alias: plano.alias,
      effort: plano.effort_consolidacao,
      cwd,
      log: path.join(saida, 'consolidacao.log'),
      prompt: promptConsolidacao({
        proposito: plano.proposito,
        pergunta: plano.pergunta,
        juntado: relativo(cwd, arqJuntado),
        relatorio: relativo(cwd, arqRel),
        chave: chaveDoPreset(preset.valor),
      }),
      resume: null,
      write: true,
      timeoutMs: teto,
    }, temporizar);
    const feito = r.codigo === 0 && existsSync(arqRel);
    consolidacao = feito ? 'ok' : 'falhou';
    if (feito) relatorio = arqRel;
  }

  // 7 and 8. Summary and exit code. A failed consolidation is an error of the enxame (1);
  // a failed fatia is the exit 4 of spec step 8.
  const falhas = itens.filter((it) => it.status === 'falha').length;
  const codigo = plano.consolidar && consolidacao === 'falhou' ? 1 : falhas ? 4 : 0;
  const linhas = resumo({
    id: plano.id,
    minutos: (relogio() - inicio) / 60_000,
    fatias: itens.map(({ n, arquivos, status, retomada, motivo }) => ({ n, arquivos, status, retomada, motivo })),
    linhas: juntado,
    preset: preset.valor,
    juntado: arqJuntado,
    relatorio,
    consolidacao,
  });
  return { codigo, linhas };
}

function chaveDoPreset(preset) {
  if (preset.chaves.includes('severidade')) return 'severidade';
  if (preset.chaves.includes('veredito')) return 'veredito';
  return null;
}
