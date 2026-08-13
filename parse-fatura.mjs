#!/usr/bin/env node
// Converte o texto de uma fatura em JSON pro `fin add --json`.
//
//   pdftotext -upw <senha> -layout fatura.pdf fatura.txt
//   node parse-fatura.mjs fatura.txt --layout santander --card santander --venc 2026-08-12 --dry
//   node parse-fatura.mjs fatura.txt --layout santander --card santander --venc 2026-08-12 > lote.json
//   node fin.mjs add --json "$(cat lote.json)"
//
// `--layout` é o banco que imprimiu (santander, porto, caixa); `--card` é o nome do
// `method` no seu banco de dados. Costumam coincidir, mas são coisas diferentes — dois
// cartões Porto viram dois `--card` com o mesmo `--layout`.
//
// SEMPRE compare o total do --dry com o total de compras impresso na fatura antes de
// importar. Se não bater, o regex não pegou tudo — não importe torto, ajuste.
import { readFileSync } from 'node:fs';
import { parseArgs } from './lib/helpers.mjs';
import { LAYOUTS, parseFaturaCompleto, resumo } from './lib/fatura.mjs';

const layouts = Object.keys(LAYOUTS).join('|');
const { flags, pos } = parseArgs(process.argv.slice(2));
const [file] = pos;

if (!file) {
  console.error(`uso: parse-fatura.mjs <arquivo.txt> --layout <${layouts}> --card <nome> --venc <YYYY-MM-DD> [--dry] [--ano 2026]`);
  process.exit(1);
}
if (!flags.venc || flags.venc === true) {
  console.error('erro: --venc <YYYY-MM-DD> é obrigatório (é a data que as parcelas recebem)');
  process.exit(1);
}

const layout = flags.layout === true || !flags.layout ? 'santander' : flags.layout;
if (!LAYOUTS[layout]) {
  console.error(`erro: layout "${layout}" não existe. Use --layout <${layouts}>.`);
  process.exit(1);
}

const { items, creditos } = parseFaturaCompleto(readFileSync(file, 'utf8'), {
  card: flags.card || 'cartao',
  venc: flags.venc,
  ano: flags.ano,
  layout,
});

// Zero item quase nunca é uma fatura vazia — é o layout errado, ou um PDF que saiu sem
// as colunas. Sair calado aqui produziria um `lote.json` vazio importado sem ninguém ver.
if (!items.length) {
  console.error(`erro: nenhum lançamento encontrado com --layout ${layout}.`);
  console.error(`      confira se o layout é esse mesmo (opções: ${layouts}) e se o pdftotext rodou com -layout.`);
  process.exit(1);
}

const r = resumo(items);
console.error(`${r.n} itens | despesas ${r.total.toFixed(2)}`);
if (creditos.n) {
  console.error(`${creditos.n} créditos ignorados | ${creditos.total.toFixed(2)} (pagamento, estorno, desconto — não são despesa)`);
}

if (flags.dry) {
  for (const [cat, v] of r.categorias) {
    console.error(`  ${cat.padEnd(16)} ${v.total.toFixed(2).padStart(9)} ${String(v.n).padStart(3)}x`);
  }
} else {
  console.log(JSON.stringify(items));
}
