// Funções puras do CLI: parsing de argumento, dinheiro, data e formatação de tabela.
// Vivem separadas do fin.mjs para poderem ser testadas sem banco nenhum.

// Data local em ISO. NÃO use toISOString() para isso: ele converte para UTC, e aí
// "hoje" às 22h em São Paulo vira amanhã, e o fim do mês volta um dia em fusos a leste
// de Greenwich. Lançamento é um fato do calendário do usuário, não um instante em UTC.
export const isoLocal = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// aceita 35.90 | 35,90 | 1.200,50 | 1,200.50 | R$ 1200
export const num = (v) => {
  let s = String(v).replace(/[^\d.,-]/g, '');
  // sem nenhum dígito, Number('') seria 0 e o lançamento entraria valendo R$ 0,00 calado
  if (!/\d/.test(s)) throw new Error(`valor inválido: ${v}`);
  if (s.includes('.') && s.includes(',')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')   // 1.200,50
      : s.replace(/,/g, '');                      // 1,200.50
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`valor inválido: ${v}`);
  return n;
};

export const money = (v) => Number(v).toFixed(2);

// "null", "" ou --flag sem valor limpam o campo
export const nullable = (v) => (v === 'null' || v === '' || v === true ? null : v);

// aceita: 2026-08-05 | 05/08 | 05/08/2026 | hoje | ontem | -3 (dias atrás)
export function toDate(v, hoje = new Date()) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s === 'hoje' || s === 'today') return isoLocal(hoje);
  if (s === 'ontem' || s === 'yesterday') return isoLocal(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 1));
  if (/^-\d+$/.test(s)) return isoLocal(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - Math.abs(+s)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const br = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (br) {
    let y = br[3] ? +br[3] : hoje.getFullYear();
    if (y < 100) y += 2000;
    return `${y}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  }
  throw new Error(`data inválida: ${v}`);
}

// --month 2026-08 | 08 | atual/this | -1 (mês passado).
// `end` é exclusivo: o primeiro dia do mês seguinte.
export function monthRange(v, hoje = new Date()) {
  let y = hoje.getFullYear();
  let m = hoje.getMonth() + 1;
  const s = String(v ?? '').toLowerCase();
  if (s && s !== 'true' && s !== 'atual' && s !== 'this') {
    if (/^\d{4}-\d{2}$/.test(s)) [y, m] = s.split('-').map(Number);
    else if (/^\d{1,2}$/.test(s)) m = +s;
    else if (/^-\d+$/.test(s)) {
      const d = new Date(y, m - 1 - Math.abs(+s), 1);
      y = d.getFullYear();
      m = d.getMonth() + 1;
    } else throw new Error(`mês inválido: ${v}`);
  }
  const label = `${y}-${String(m).padStart(2, '0')}`;
  return { start: `${label}-01`, end: isoLocal(new Date(y, m, 1)), label };
}

// último dia do mês de um `start` no formato YYYY-MM-DD
export const ultimoDiaDoMes = (start) => {
  const [ano, mes] = start.split('-').map(Number);
  return new Date(ano, mes, 0).getDate();
};

// "parcela 19/36" ou "(1 de 10)" -> avança o contador; ignora o que parece data (07/2026)
export function proximaParcela(desc) {
  if (!desc) return { desc, fim: false };
  const m = desc.match(/(\d{1,3})\s*(\/|\s+de\s+)\s*(\d{1,3})/i);
  if (!m) return { desc, fim: false };
  const [atual, total] = [Number(m[1]), Number(m[3])];
  if (total >= 2000 || total > 120 || atual >= total) return { desc, fim: atual >= total };
  return { desc: desc.replace(m[0], m[0].replace(String(atual), String(atual + 1))), fim: false };
}

// --flag valor | --flag=valor | --flag (booleano); o resto é posicional
export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else pos.push(a);
  }
  return { flags, pos };
}

export function table(rows) {
  if (!rows.length) return '(vazio)';
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ').trimEnd();
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}
