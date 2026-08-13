#!/usr/bin/env node
// Converte o texto de uma fatura em JSON pro `fin add --json`.
//
//   pdftotext -upw <senha> -layout fatura.pdf fatura.txt
//   node parse-fatura.mjs fatura.txt --card santander --venc 2026-08-12 --dry   # confere
//   node parse-fatura.mjs fatura.txt --card santander --venc 2026-08-12 > lote.json
//   node fin.mjs add --json "$(cat lote.json)"
//
// SEMPRE compare o total do --dry com o "Total Despesas" impresso na fatura antes de
// importar. Se não bater, o regex não pegou tudo — não importe torto, ajuste.
import { readFileSync } from 'node:fs';
import { parseArgs } from './lib/helpers.mjs';
import { parseFatura, resumo } from './lib/fatura.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const [file] = pos;

if (!file) {
  console.error('uso: parse-fatura.mjs <arquivo.txt> --card <nome> --venc <YYYY-MM-DD> [--dry] [--ano 2026]');
  process.exit(1);
}
if (!flags.venc || flags.venc === true) {
  console.error('erro: --venc <YYYY-MM-DD> é obrigatório (é a data que as parcelas recebem)');
  process.exit(1);
}

const items = parseFatura(readFileSync(file, 'utf8'), {
  card: flags.card || 'cartao',
  venc: flags.venc,
  ano: flags.ano,
});

const r = resumo(items);
console.error(`${r.n} itens | total ${r.total.toFixed(2)}`);

if (flags.dry) {
  for (const [cat, v] of r.categorias) {
    console.error(`  ${cat.padEnd(16)} ${v.total.toFixed(2).padStart(9)} ${String(v.n).padStart(3)}x`);
  }
} else {
  console.log(JSON.stringify(items));
}
