#!/usr/bin/env node
// CLI de finanças pessoais. Saída compacta de propósito (é feita para caber num terminal
// e para ser lida por um agente sem gastar contexto).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarPool } from './lib/db.mjs';
import {
  isoLocal, money, monthRange, nullable, num, parseArgs, proximaParcela, table, toDate, ultimoDiaDoMes,
} from './lib/helpers.mjs';

const root = dirname(fileURLToPath(import.meta.url));

// pool preguiçoso: criar no topo do módulo jogaria o erro de DATABASE_URL fora do try/catch
// lá embaixo, e quem acabou de clonar o projeto receberia um stack trace em vez da instrução
let pool;
const q = (text, params) => (pool ??= criarPool()).query(text, params);

const argv = process.argv.slice(2);
const cmd = argv.shift();
const { flags, pos } = parseArgs(argv);

// --json sozinho = saída JSON; --json '<payload>' é entrada (add em lote)
const asJson = flags.json === true;
const out = (rows) => console.log(asJson ? JSON.stringify(rows) : table(rows));

// ---------- comandos ----------
const commands = {
  async init() {
    const sql = readFileSync(join(root, 'schema.sql'), 'utf8');
    await q(sql);
    console.log('schema recriado (tx, budget, saldo, fatura)');
  },

  // add <valor> <categoria> [descrição]  [--date] [--kind income] [--method pix] [--recurring] [--notes]
  // add --json '[{amount,category,description,date,kind,method,recurring,notes}, ...]'
  async add() {
    const items = flags.json && flags.json !== true
      ? JSON.parse(flags.json)
      : [{
          amount: pos[0],
          category: pos[1],
          description: pos.slice(2).join(' ') || null,
          date: flags.date ?? flags.d,
          kind: flags.kind ?? (flags.income ? 'income' : 'expense'),
          method: flags.method ?? flags.m,
          recurring: !!flags.recurring,
          notes: flags.notes,
          due_day: flags.due,
          series: flags.series,
          pending: !!flags.pending,
        }];
    const rows = [];
    for (const it of items) {
      const r = await q(
        `INSERT INTO tx (kind, amount, category, description, occurred_on, method, recurring, notes, due_day, series, pending)
         VALUES ($1,$2,$3,$4,COALESCE($5::date, current_date),$6,$7,$8,$9,$10,$11)
         RETURNING id, kind, amount, category, description, occurred_on::text AS date`,
        [
          it.kind || 'expense',
          num(it.amount),
          String(it.category || 'outros').toLowerCase(),
          it.description || null,
          toDate(it.date),
          it.method || null,
          !!it.recurring,
          it.notes || null,
          it.due_day ? Number(it.due_day) : null,
          it.series || null,
          !!it.pending,
        ],
      );
      rows.push(r.rows[0]);
    }
    out(rows);
  },

  // list [--month] [--from] [--to] [--cat] [--kind] [--search] [--limit 30]
  async list() {
    const w = [];
    const p = [];
    if (flags.month !== undefined) {
      const { start, end } = monthRange(flags.month);
      p.push(start, end);
      w.push(`occurred_on >= $${p.length - 1} AND occurred_on < $${p.length}`);
    }
    if (flags.from) { p.push(toDate(flags.from)); w.push(`occurred_on >= $${p.length}`); }
    if (flags.to) { p.push(toDate(flags.to)); w.push(`occurred_on <= $${p.length}`); }
    if (flags.cat) { p.push(String(flags.cat).toLowerCase()); w.push(`category = $${p.length}`); }
    if (flags.kind) { p.push(flags.kind); w.push(`kind = $${p.length}`); }
    if (flags.search) { p.push(`%${flags.search}%`); w.push(`(description ILIKE $${p.length} OR notes ILIKE $${p.length})`); }
    p.push(Number(flags.limit) || 30);
    const r = await q(
      `SELECT id, occurred_on::text AS date, kind, amount, category, description, method,
              CASE WHEN pending THEN 'previsto' END AS st
       FROM tx ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
       ORDER BY occurred_on DESC, id DESC LIMIT $${p.length}`,
      p,
    );
    out(r.rows);
    if (!asJson && r.rows.length) {
      const tot = r.rows.reduce((s, x) => s + (x.kind === 'income' ? +x.amount : -x.amount), 0);
      console.log(`\n${r.rows.length} lançamentos | líquido ${money(tot)}`);
    }
  },

  // sum [--month] [--year 2026] [--by category|method|kind|month]
  async sum() {
    let where = '';
    const p = [];
    let label = 'tudo';
    if (flags.year) {
      p.push(`${flags.year}-01-01`, `${+flags.year + 1}-01-01`);
      where = 'WHERE occurred_on >= $1 AND occurred_on < $2';
      label = String(flags.year);
    } else if (flags.month !== undefined || (!flags.all && !flags.from)) {
      const { start, end, label: l } = monthRange(flags.month);
      p.push(start, end);
      where = 'WHERE occurred_on >= $1 AND occurred_on < $2';
      label = l;
    } else if (flags.from) {
      p.push(toDate(flags.from), toDate(flags.to) || '2999-12-31');
      where = 'WHERE occurred_on >= $1 AND occurred_on <= $2';
      label = `${p[0]}..${p[1]}`;
    }
    // allowlist: `by` entra na query por interpolação, não pode vir do usuário cru
    const by = flags.by === 'month'
      ? `to_char(occurred_on, 'YYYY-MM')`
      : (['category', 'method', 'kind'].includes(flags.by) ? flags.by : 'category');
    const r = await q(
      `SELECT ${by} AS ${flags.by === 'month' ? 'mes' : 'grupo'},
              SUM(amount) FILTER (WHERE kind='expense') AS despesas,
              SUM(amount) FILTER (WHERE kind='income')  AS receitas,
              COUNT(*) AS n
       FROM tx ${where} GROUP BY 1 ORDER BY 2 DESC NULLS LAST`,
      p,
    );
    // separa o que já aconteceu do que é só previsão
    const t = await q(
      `SELECT pending,
              COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS despesas,
              COALESCE(SUM(amount) FILTER (WHERE kind='income'),0)  AS receitas
       FROM tx ${where} GROUP BY pending`,
      p,
    );
    out(r.rows);
    if (!asJson) {
      const pick = (pend) => t.rows.find((x) => x.pending === pend) || { despesas: 0, receitas: 0 };
      const real = pick(false);
      const prev = pick(true);
      const line = (tag, x) =>
        `${tag} receitas ${money(x.receitas)} | despesas ${money(x.despesas)} | saldo ${money(x.receitas - x.despesas)}`;
      console.log(`\n[${label}] ${line('realizado:', real)}`);
      if (+prev.receitas || +prev.despesas) {
        console.log(`${' '.repeat(label.length + 2)} ${line('previsto: ', prev)}`);
        console.log(
          `${' '.repeat(label.length + 2)} total:     receitas ${money(+real.receitas + +prev.receitas)}` +
          ` | despesas ${money(+real.despesas + +prev.despesas)}` +
          ` | saldo ${money(+real.receitas + +prev.receitas - real.despesas - prev.despesas)}`,
        );
      }
    }
  },

  // saldo [<valor>] [--conta] [--date] — registra o saldo observado; sem valor, mostra o atual e a projeção
  async saldo() {
    if (pos[0]) {
      const r = await q(
        `INSERT INTO saldo (conta, amount, observed_on, notes)
         VALUES ($1,$2,COALESCE($3::date, current_date),$4)
         RETURNING id, conta, amount, observed_on::text AS data`,
        [flags.conta || 'principal', num(pos[0]), toDate(flags.date), flags.notes || null],
      );
      return out(r.rows);
    }
    const atual = await q(
      `SELECT DISTINCT ON (conta) conta, amount, observed_on::text AS data
       FROM saldo ORDER BY conta, observed_on DESC, id DESC`,
    );
    if (!atual.rows.length) return console.log('nenhum saldo registrado — use: fin saldo <valor>');
    out(atual.rows);
    if (asJson) return;

    // projeção: saldo de hoje +/- o que ainda está previsto até o fim do mês
    const { end } = monthRange(flags.month);
    const f = await q(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS entra,
              COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS sai
       FROM tx WHERE pending AND occurred_on >= current_date AND occurred_on < $1`,
      [end],
    );
    const fat = await q(
      `SELECT COALESCE(SUM(amount),0) AS total FROM fatura
       WHERE NOT pago AND vencimento >= current_date AND vencimento < $1`,
      [end],
    );
    const base = atual.rows.reduce((s, x) => s + +x.amount, 0);
    const { entra, sai } = f.rows[0];
    const faturas = +fat.rows[0].total;
    console.log(
      `\nsaldo      ${money(base).padStart(9)}` +
      `\n+ entradas ${money(entra).padStart(9)}   previstas até o fim do mês` +
      `\n− saídas   ${money(sai).padStart(9)}   previstas até o fim do mês` +
      `\n− faturas  ${money(faturas).padStart(9)}   cartões a vencer` +
      `\n= projeção ${money(base + +entra - sai - faturas).padStart(9)}`,
    );
  },

  // fatura [<cartao> <valor> --venc <data> [--pago]] — sem args, lista as em aberto
  async fatura() {
    if (pos[0]) {
      if (pos[0] === 'pago') {
        const r = await q(
          'UPDATE fatura SET pago = true WHERE cartao = $1 AND vencimento = $2::date RETURNING *',
          [pos[1], toDate(pos[2])],
        );
        if (!r.rowCount) throw new Error('fatura não encontrada');
        return out(r.rows);
      }
      if (!flags.venc) throw new Error('informe --venc <data>');
      const r = await q(
        `INSERT INTO fatura (cartao, vencimento, amount, pago, notes) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (cartao, vencimento) DO UPDATE SET amount = EXCLUDED.amount, pago = EXCLUDED.pago
         RETURNING cartao, vencimento::text, amount, pago`,
        [pos[0], toDate(flags.venc), num(pos[1]), !!flags.pago, flags.notes || null],
      );
      return out(r.rows);
    }
    const r = await q(
      `SELECT cartao, vencimento::text AS vence, amount, CASE WHEN pago THEN 'pago' ELSE 'EM ABERTO' END AS status
       FROM fatura ORDER BY vencimento DESC LIMIT 20`,
    );
    out(r.rows);
  },

  // roll [--month] [--dry] — materializa os recorrentes do mês como previstos (pending)
  async roll() {
    const { start, end, label } = monthRange(flags.month);
    const ultimoDia = ultimoDiaDoMes(start);

    const r = await q(
      `WITH ult AS (
         SELECT DISTINCT ON (COALESCE(series, category))
                COALESCE(series, category) AS chave, kind, amount, category,
                description, method, due_day, series
         FROM tx WHERE recurring
         ORDER BY COALESCE(series, category), occurred_on DESC, id DESC
       )
       SELECT u.*,
              u.method IN (SELECT cartao FROM fatura) AS no_cartao,
              (SELECT b.amount FROM budget b WHERE b.category = u.chave AND b.month IS NULL) AS ref,
              EXISTS (SELECT 1 FROM tx t WHERE COALESCE(t.series, t.category) = u.chave
                        AND t.occurred_on >= $1 AND t.occurred_on < $2) AS ja
       FROM ult u ORDER BY u.due_day NULLS LAST, u.chave`,
      [start, end],
    );

    const criar = [];
    const pular = [];
    for (const u of r.rows) {
      if (u.ja) { pular.push(`${u.chave}: já lançado`); continue; }
      // cobrado no cartão: vem item a item na importação da fatura, criar previsto aqui duplicaria
      if (u.no_cartao) { pular.push(`${u.chave}: vem na fatura ${u.method}`); continue; }
      const { desc, fim } = proximaParcela(u.description);
      if (fim) { pular.push(`${u.chave}: parcelas terminaram`); continue; }
      const dia = Math.min(u.due_day || 1, ultimoDia);
      criar.push({
        amount: u.ref ?? u.amount,
        category: u.category,
        description: desc,
        date: `${start.slice(0, 8)}${String(dia).padStart(2, '0')}`,
        kind: u.kind,
        method: u.method,
        recurring: true,
        due_day: u.due_day,
        series: u.series,
        pending: true,
      });
    }

    if (flags.dry) {
      out(criar.map((c) => ({ date: c.date, kind: c.kind, amount: money(c.amount), series: c.series, description: c.description })));
    } else {
      for (const c of criar) {
        await q(
          `INSERT INTO tx (kind, amount, category, description, occurred_on, method, recurring, due_day, series, pending)
           VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,true)`,
          [c.kind, c.amount, c.category, c.description, c.date, c.method, c.due_day, c.series],
        );
      }
      console.log(`[${label}] criados ${criar.length} previstos`);
    }
    if (!asJson && pular.length) console.log(`pulados: ${pular.join(' | ')}`);
  },

  // ok <id> [--date] [--amount] — previsto virou realizado (ajusta data/valor se veio diferente)
  async ok() {
    const id = Number(pos[0]);
    if (!id) throw new Error('informe o id');
    const sets = ['pending = false'];
    const p = [];
    if (flags.date) { p.push(toDate(flags.date)); sets.push(`occurred_on = $${p.length}`); }
    if (flags.amount) { p.push(num(flags.amount)); sets.push(`amount = $${p.length}`); }
    p.push(id);
    const r = await q(
      `UPDATE tx SET ${sets.join(', ')} WHERE id = $${p.length}
       RETURNING id, occurred_on::text AS date, kind, amount, category, description, pending`,
      p,
    );
    if (!r.rowCount) throw new Error(`id ${id} não existe`);
    out(r.rows);
  },

  // pend [--month] — o que está previsto e ainda não se confirmou
  async pend() {
    const { start, end, label } = monthRange(flags.month);
    const r = await q(
      `SELECT id, occurred_on::text AS date, kind, amount, category, description
       FROM tx WHERE pending AND occurred_on >= $1 AND occurred_on < $2
       ORDER BY occurred_on`,
      [start, end],
    );
    out(r.rows);
    if (!asJson && r.rows.length) {
      const ent = r.rows.filter((x) => x.kind === 'income').reduce((s, x) => s + +x.amount, 0);
      const sai = r.rows.filter((x) => x.kind === 'expense').reduce((s, x) => s + +x.amount, 0);
      console.log(`\n[${label}] previsto: entra ${money(ent)} | sai ${money(sai)}`);
    }
  },

  // del <id> [id2 ...]
  async del() {
    const ids = pos.map(Number).filter(Boolean);
    if (!ids.length) throw new Error('informe ao menos um id');
    const r = await q('DELETE FROM tx WHERE id = ANY($1) RETURNING id, amount, category, description', [ids]);
    console.log(`removidos: ${r.rowCount}`);
    if (r.rowCount) out(r.rows);
  },

  // edit <id> [--amount] [--cat] [--desc] [--date] [--kind] [--method] [--notes] [--recurring true|false]
  async edit() {
    const id = Number(pos[0]);
    if (!id) throw new Error('informe o id');
    const map = {
      amount: () => num(flags.amount),
      category: () => String(flags.cat).toLowerCase(),
      description: () => nullable(flags.desc),
      occurred_on: () => toDate(flags.date),
      kind: () => flags.kind,
      method: () => nullable(flags.method),
      notes: () => nullable(flags.notes),
      recurring: () => flags.recurring === 'false' ? false : !!flags.recurring,
      due_day: () => flags.due === 'null' ? null : Number(flags.due),
      series: () => nullable(flags.series),
      pending: () => flags.pending === 'false' ? false : !!flags.pending,
    };
    const has = { amount: 'amount', category: 'cat', description: 'desc', occurred_on: 'date', kind: 'kind', method: 'method', notes: 'notes', recurring: 'recurring', due_day: 'due', series: 'series', pending: 'pending' };
    const sets = [];
    const p = [];
    for (const [col, flag] of Object.entries(has)) {
      if (flags[flag] === undefined) continue;
      p.push(map[col]());
      sets.push(`${col} = $${p.length}`);
    }
    if (!sets.length) throw new Error('nada para atualizar');
    p.push(id);
    const r = await q(
      `UPDATE tx SET ${sets.join(', ')} WHERE id = $${p.length}
       RETURNING id, occurred_on::text AS date, kind, amount, category, description, method, recurring, due_day`,
      p,
    );
    out(r.rows);
  },

  // due [--month] — recorrentes: o que vence, o que já foi lançado no mês
  async due() {
    const { start, end, label } = monthRange(flags.month);
    const r = await q(
      `WITH ult AS (
         SELECT DISTINCT ON (COALESCE(series, category))
                COALESCE(series, category) AS chave, category, amount, due_day, method
         FROM tx WHERE recurring AND kind = 'expense'
         ORDER BY COALESCE(series, category), occurred_on DESC, id DESC
       )
       SELECT u.chave, u.category, u.due_day, u.amount, u.method,
              u.method IN (SELECT cartao FROM fatura) AS no_cartao,
              (SELECT b.amount FROM budget b WHERE b.category = u.chave AND b.month IS NULL) AS ref,
              -- previsto não é pago: separar os dois, senão o roll faz tudo parecer quitado
              (SELECT max(t.occurred_on)::text FROM tx t
                WHERE COALESCE(t.series, t.category) = u.chave
                  AND t.occurred_on >= $1 AND t.occurred_on < $2
                  AND NOT t.pending) AS pago_em,
              (SELECT max(t.occurred_on)::text FROM tx t
                WHERE COALESCE(t.series, t.category) = u.chave
                  AND t.occurred_on >= $1 AND t.occurred_on < $2
                  AND t.pending) AS previsto_em
       FROM ult u ORDER BY u.due_day NULLS LAST, u.chave`,
      [start, end],
    );
    const hoje = isoLocal(new Date());
    const rows = r.rows.map((x) => ({
      item: x.chave,
      categoria: x.category,
      vence: x.due_day ? `${label}-${String(x.due_day).padStart(2, '0')}` : '?',
      // valor variável usa a referência do budget; fixo usa o último lançado
      valor: x.ref ? `~${money(x.ref)}` : x.amount,
      // cobrado no cartão não é boleto a pagar: entra quando a fatura for importada.
      // previsto aparece antes de `fatura` de propósito — nesse caso ele é erro de dado
      // (o roll pula cartão), e esconder duplicaria o gasto na importação sem avisar
      status: x.pago_em ? `lançado ${x.pago_em}`
        : x.previsto_em ? `PREVISTO ${x.previsto_em}`
        : x.no_cartao ? `fatura ${x.method}`
        : 'PENDENTE',
    }));
    out(rows);
    if (!asJson) {
      // pendente = ainda não saiu do bolso; previsto conta aqui, só realizado quita
      const pend = r.rows.filter((x) => !x.pago_em && !x.no_cartao);
      const total = pend.reduce((s, x) => s + +(x.ref ?? x.amount), 0);
      const atrasados = pend.filter((x) => x.due_day && `${label}-${String(x.due_day).padStart(2, '0')}` < hoje);
      const naFatura = r.rows.filter((x) => !x.pago_em && x.no_cartao);
      console.log(
        `\n[${label}] ${pend.length} pendente(s), ~${money(total)}` +
        (atrasados.length ? ` | vencidos: ${atrasados.map((x) => x.chave).join(', ')}` : '') +
        (naFatura.length ? `\naguardando fatura: ${naFatura.map((x) => `${x.chave} (${x.method})`).join(', ')}` : ''),
      );
    }
  },

  async cats() {
    const r = await q(
      `SELECT category, COUNT(*) AS n, SUM(amount) AS total, MAX(occurred_on)::text AS ultimo
       FROM tx GROUP BY 1 ORDER BY 3 DESC`,
    );
    out(r.rows);
  },

  // budget set <categoria> <valor> [--month 2026-08]  |  budget (sem args) = status do mês
  async budget() {
    if (pos[0] === 'set') {
      const month = flags.month !== undefined ? monthRange(flags.month).start : null;
      const r = await q(
        `INSERT INTO budget (category, amount, month) VALUES ($1,$2,$3)
         ON CONFLICT (category, month) DO UPDATE SET amount = EXCLUDED.amount
         RETURNING id, category, amount, month::text`,
        [String(pos[1]).toLowerCase(), num(pos[2]), month],
      );
      return out(r.rows);
    }
    if (pos[0] === 'del') {
      const r = await q('DELETE FROM budget WHERE id = $1 RETURNING id', [Number(pos[1])]);
      return console.log(`removidos: ${r.rowCount}`);
    }
    const { start, end, label } = monthRange(flags.month);
    const r = await q(
      // o orçamento casa tanto com uma categoria quanto com uma série (ex: a categoria 'agua' ou a serie 'internet')
      `WITH b AS (
         SELECT DISTINCT ON (category) category, amount FROM budget
         WHERE month = $1::date OR month IS NULL ORDER BY category, month NULLS LAST
       )
       SELECT b.category, b.amount AS orcado,
              COALESCE(g.gasto,0) AS gasto,
              b.amount - COALESCE(g.gasto,0) AS resta
       FROM b
       LEFT JOIN LATERAL (
         SELECT SUM(t.amount) AS gasto FROM tx t
         WHERE t.kind = 'expense' AND t.occurred_on >= $1 AND t.occurred_on < $2
           AND (t.category = b.category OR t.series = b.category)
       ) g ON true
       ORDER BY resta ASC`,
      [start, end],
    );
    out(r.rows);
    if (!asJson) console.log(`\norçamento ${label}`);
  },

  // q "<SELECT ...>"  — somente leitura, para consultas ad-hoc
  async q() {
    const sql = pos.join(' ');
    if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('somente SELECT/WITH');
    const r = await q(sql);
    out(r.rows);
  },

  help() {
    console.log(`fin <cmd>
  init                                   recria o schema (APAGA TUDO)
  add <valor> <cat> [descrição]          [--date 05/08|hoje|-2] [--kind income] [--method pix] [--recurring] [--due 7] [--series x] [--pending] [--notes ..]
  add --json '[{amount,category,description,date,kind,method}]'   lote
  list                                   [--month 2026-08|-1] [--from --to] [--cat x] [--kind] [--search t] [--limit 30]
  sum                                    [--month|--year|--all] [--by category|method|kind|month]
  edit <id>                              [--amount] [--cat] [--desc] [--date] [--kind] [--method] [--notes] [--series]
  del <id> [id...]
  roll                                   materializa os recorrentes do mês como previstos [--month] [--dry]
  ok <id>                                previsto -> realizado [--date] [--amount]
  pend                                   o que está previsto e não confirmou [--month]
  due                                    recorrentes do mês: vencimento, valor, pendente ou lançado [--month]
  saldo [<valor>]                        registra o saldo da conta; sem valor mostra atual + projeção
  fatura <cartao> <valor> --venc <data>  registra a fatura | fatura pago <cartao> <data> | sem args lista
  cats                                   categorias usadas
  budget                                 status do mês | budget set <cat> <valor> [--month] | budget del <id>
  q "SELECT ..."                         consulta ad-hoc (read-only)
  (qualquer cmd aceita --json)`);
  },
};

const run = commands[cmd] || commands.help;
try {
  await run();
  process.exit(0);
} catch (e) {
  console.error('erro:', e.message);
  process.exit(1);
}
