#!/usr/bin/env node
// Painel local de finanças. Renderiza no servidor — sem build, sem CDN, sem framework.
//   node painel.mjs   ->  http://127.0.0.1:4173
//
// NÃO tem autenticação: entrega o extrato inteiro para quem abrir. Por isso escuta só em
// 127.0.0.1. Se você mudar o HOST, ponha algo com senha na frente.
import http from 'node:http';
import { criarPool } from './lib/db.mjs';
import { isoLocal } from './lib/helpers.mjs';

let pool;
try {
  pool = criarPool();
} catch (e) {
  console.error('erro:', e.message);
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
// `method` da conta corrente: não é cartão, então não conta para "até onde a fatura foi importada"
const CONTA = process.env.CONTA_METHOD || 'conta';
const brl = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dma = (s) => String(s).split('-').reverse().join('/');

// ---------------------------------------------------------------- dados
async function carregar() {
  const hoje = isoLocal(new Date());
  const mesAtual = hoje.slice(0, 7);

  const [porMes, porCategoria, recorrentes, previstos, receitaFixa, comFixo, saldos, faturas, aVir, cartaoAte, movimento] = await Promise.all([
    pool.query(`SELECT to_char(occurred_on,'YYYY-MM') AS mes, kind, pending,
                       SUM(amount) AS total
                FROM tx GROUP BY 1,2,3 ORDER BY 1`),
    pool.query(`SELECT category, SUM(amount) AS total, COUNT(*) AS n
                FROM tx WHERE kind='expense' AND NOT pending
                GROUP BY 1 ORDER BY 2 DESC`),
    pool.query(`WITH ult AS (
                  SELECT DISTINCT ON (COALESCE(series, category))
                         COALESCE(series, category) AS chave, kind, category, amount, due_day
                  FROM tx WHERE recurring
                  ORDER BY COALESCE(series, category), occurred_on DESC, id DESC)
                SELECT u.*, (SELECT b.amount FROM budget b
                             WHERE b.category = u.chave AND b.month IS NULL) AS ref
                FROM ult u ORDER BY u.due_day NULLS LAST, u.chave`),
    pool.query(`SELECT id, occurred_on::text AS data, kind, amount, category, description
                FROM tx WHERE pending AND occurred_on >= $1::date
                ORDER BY occurred_on LIMIT 25`, [hoje.slice(0, 8) + '01']),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM (
                  SELECT DISTINCT ON (series) amount FROM tx
                  WHERE recurring AND kind='income' AND series IS NOT NULL
                  ORDER BY series, occurred_on DESC) s`),
    pool.query(`SELECT DISTINCT to_char(occurred_on,'YYYY-MM') AS mes FROM tx
                WHERE recurring AND kind='expense' AND NOT pending`),
    pool.query(`SELECT DISTINCT ON (conta) conta, amount, observed_on::text AS data
                FROM saldo ORDER BY conta, observed_on DESC, id DESC`),
    pool.query(`SELECT cartao, vencimento::text AS vence, amount FROM fatura
                WHERE NOT pago AND vencimento >= current_date ORDER BY vencimento`),
    pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE kind='income'),0) AS entra,
                       COALESCE(SUM(amount) FILTER (WHERE kind='expense'),0) AS sai
                FROM tx WHERE pending AND occurred_on >= current_date
                  AND occurred_on < (date_trunc('month', current_date) + interval '1 month')`),
    // parcelas ficam datadas no vencimento (futuro) — só compras já ocorridas dizem até onde a fatura foi importada
    pool.query(`SELECT max(occurred_on)::text AS ate FROM tx
                WHERE method IS NOT NULL AND method <> $1
                  AND NOT pending AND occurred_on <= current_date`, [CONTA]),
    // saldo é retrato, não acumulado: movimento de conta posterior a ele deixa a projeção errada
    // (compra no cartão não conta — ela bate na fatura, não na conta)
    pool.query(`SELECT max(occurred_on)::text AS em FROM tx
                WHERE NOT pending AND occurred_on <= current_date
                  AND (method IS NULL OR method NOT IN (SELECT cartao FROM fatura))`),
  ]);
  const mesesComFixo = new Set(comFixo.rows.map((r) => r.mes));

  // gasto médio dos meses já fechados (só realizado, ignora o mês corrente e futuros)
  const meses = {};
  for (const r of porMes.rows) {
    const m = (meses[r.mes] ??= { mes: r.mes, real: 0, prev: 0, receita: 0, receitaPrev: 0 });
    const v = Number(r.total);
    if (r.kind === 'expense') r.pending ? (m.prev += v) : (m.real += v);
    else r.pending ? (m.receitaPrev += v) : (m.receita += v);
  }
  const lista = Object.values(meses).sort((a, b) => a.mes.localeCompare(b.mes));
  const fechados = lista.filter((m) => m.mes < mesAtual && m.real > 0);
  const mediaGasto = fechados.length ? fechados.reduce((s, m) => s + m.real, 0) / fechados.length : 0;

  const fixo = recorrentes.rows
    .filter((r) => r.kind === 'expense')
    .reduce((s, r) => s + Number(r.ref ?? r.amount), 0);

  const atual = lista.find((m) => m.mes === mesAtual) || { real: 0, prev: 0, receita: 0, receitaPrev: 0 };

  // meses antigos só têm fatura de cartão — o fixo só passou a ser lançado depois
  const parciais = fechados.filter((m) => !mesesComFixo.has(m.mes)).length;

  // o saldo só vale até o próximo movimento de conta; depois disso a projeção conta dinheiro duas vezes
  const saldoEm = saldos.rows.reduce((m, x) => (m && m > x.data ? m : x.data), null);
  const movimentoEm = movimento.rows[0].em;

  return {
    hoje, mesAtual, lista, atual, mediaGasto, fixo, fechados: fechados.length, parciais,
    cartaoAte: cartaoAte.rows[0].ate,
    saldos: saldos.rows,
    saldoEm, movimentoEm,
    saldoVelho: !!(saldoEm && movimentoEm && movimentoEm > saldoEm),
    saldo: saldos.rows.reduce((s, x) => s + Number(x.amount), 0),
    faturas: faturas.rows,
    faturasTotal: faturas.rows.reduce((s, x) => s + Number(x.amount), 0),
    aVir: { entra: Number(aVir.rows[0].entra), sai: Number(aVir.rows[0].sai) },
    categorias: porCategoria.rows,
    recorrentes: recorrentes.rows,
    previstos: previstos.rows,
    receitaFixa: Number(receitaFixa.rows[0].total),
  };
}

// ---------------------------------------------------------------- gráficos
// colunas empilhadas: realizado + previsto por mês (2 séries -> legenda obrigatória)
function colunasMes(lista, mesAtual) {
  const W = 720, H = 260, L = 60, R = 16, T = 20, B = 34;
  const pw = W - L - R, ph = H - T - B;
  const max = Math.max(...lista.map((m) => m.real + m.prev), 1);
  const passo = Math.pow(10, Math.floor(Math.log10(max))) / 2;
  const topo = Math.ceil(max / passo) * passo;
  const y = (v) => T + ph - (v / topo) * ph;
  const banda = pw / lista.length;
  const bw = Math.min(24, banda * 0.5);

  // topo arredondado 4px na ponta do dado, reto na base
  const capa = (x, yy, w, h, r = 4) => {
    const rr = Math.min(r, h);
    return `M${x} ${yy + h}V${yy + rr}a${rr} ${rr} 0 0 1 ${rr} -${rr}h${w - 2 * rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}V${yy + h}Z`;
  };

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = (topo / 4) * i;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>` +
         `<text x="${L - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">${v >= 1000 ? (v / 1000) + 'k' : v}</text>`;
  }

  let barras = '';
  lista.forEach((m, i) => {
    const x = L + banda * i + (banda - bw) / 2;
    const hReal = (m.real / topo) * ph;
    const hPrev = (m.prev / topo) * ph;
    const tip = `${m.mes} — realizado R$ ${brl(m.real)}${m.prev ? ` · previsto R$ ${brl(m.prev)}` : ''}`;
    // 2px de respiro entre os segmentos empilhados
    if (hPrev > 0) {
      barras += `<path d="${capa(x, y(m.real + m.prev), bw, Math.max(hPrev - 2, 1))}" class="s2" data-tip="${esc(tip)}"/>`;
      barras += `<rect x="${x}" y="${y(m.real)}" width="${bw}" height="${Math.max(hReal, 0)}" class="s1" data-tip="${esc(tip)}"/>`;
    } else {
      barras += `<path d="${capa(x, y(m.real), bw, Math.max(hReal, 1))}" class="s1" data-tip="${esc(tip)}"/>`;
    }
    const rot = m.mes.slice(5) + '/' + m.mes.slice(2, 4);
    barras += `<text x="${x + bw / 2}" y="${H - 12}" class="tick ${m.mes === mesAtual ? 'agora' : ''}" text-anchor="middle">${rot}</text>`;
  });

  // rótulo direto só no mês corrente — nunca em todos
  const iAtual = lista.findIndex((m) => m.mes === mesAtual);
  if (iAtual >= 0) {
    const m = lista[iAtual];
    const x = L + banda * iAtual + banda / 2;
    barras += `<text x="${x}" y="${y(m.real + m.prev) - 8}" class="valor" text-anchor="middle">${brl(m.real + m.prev)}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Despesas por mês">
    ${g}<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="eixo"/>${barras}</svg>`;
}

// barras horizontais em HTML: uma série, uma cor (nunca rampa em categoria nominal)
function barrasCategoria(rows) {
  let corte = 12;
  const cauda = (k) => rows.slice(k).reduce((s, r) => s + Number(r.total), 0);
  while (corte < rows.length && cauda(corte) > Number(rows[corte - 1].total)) corte++;
  const top = rows.slice(0, corte);
  const resto = cauda(corte);
  if (resto > 0) top.push({ category: 'outras', total: resto, n: rows.length - corte });
  const max = Math.max(...top.map((r) => Number(r.total)), 1);
  return top.map((r) => `
    <div class="linha" data-tip="${esc(r.category)} — R$ ${brl(r.total)} em ${r.n} lançamentos">
      <span class="nome">${esc(r.category)}</span>
      <span class="trilho"><span class="fill" style="width:${(Number(r.total) / max) * 100}%"></span></span>
      <span class="num">${brl(r.total)}</span>
    </div>`).join('');
}

// ---------------------------------------------------------------- página
function pagina(d) {
  const saldoMes = d.atual.receita + d.atual.receitaPrev - d.atual.real - d.atual.prev;
  const diaHoje = Number(d.hoje.slice(8, 10));
  const mesLabel = new Date(d.mesAtual + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const projecao = d.saldo + d.aVir.entra - d.aVir.sai - d.faturasTotal;
  const diasSemCartao = Math.round((Date.parse(d.hoje) - Date.parse(d.cartaoAte)) / 864e5);
  const incompleto = diasSemCartao >= 2;

  const calendario = d.recorrentes.filter((r) => r.due_day).map((r) => {
    const v = Number(r.ref ?? r.amount);
    const passou = r.due_day < diaHoje;
    return `<tr data-tip="${esc(r.chave)} — ${r.kind === 'income' ? 'entra' : 'sai'} R$ ${brl(v)}">
      <td class="dia ${passou ? 'passou' : ''}">${String(r.due_day).padStart(2, '0')}</td>
      <td>${esc(r.chave)}<span class="cat">${esc(r.category)}</span></td>
      <td class="num ${r.kind === 'income' ? 'ent' : ''}">${r.kind === 'income' ? '+' : ''}${brl(v)}${r.ref ? ' ~' : ''}</td>
    </tr>`;
  }).join('');

  // fatura não mora em tx (é caixa, não lançamento) e sumia da agenda — os maiores eventos
  // de caixa do mês ficavam de fora justo da lista onde se olha "o que eu pago agora"
  const agenda = [
    ...d.previstos.map((p) => ({
      data: p.data, texto: p.description || p.category, amount: p.amount, kind: p.kind, tag: '',
    })),
    ...d.faturas.map((f) => ({
      data: f.vence, texto: `Fatura ${f.cartao}`, amount: f.amount, kind: 'expense', tag: 'fatura',
    })),
  ].sort((a, b) => a.data.localeCompare(b.data));

  const previstos = agenda.map((p) => `<tr>
      <td class="dia">${p.data.slice(8)}/${p.data.slice(5, 7)}</td>
      <td>${esc(p.texto)}${p.tag ? `<span class="cat">${esc(p.tag)}</span>` : ''}</td>
      <td class="num ${p.kind === 'income' ? 'ent' : ''}">${p.kind === 'income' ? '+' : '−'}${brl(p.amount)}</td>
    </tr>`).join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Finanças</title><style>
:root{color-scheme:light;
 --plano:#f9f9f7; --surf:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --mut:#898781;
 --grid:#e1e0d9; --eixo:#c3c2b7; --borda:rgba(11,11,11,.10);
 --s1:#2a78d6; --s2:#eb6834; --bom:#006300; --ruim:#d03b3b;}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme=light])){color-scheme:dark;
 --plano:#0d0d0d; --surf:#1a1a19; --ink:#fff; --ink2:#c3c2b7; --mut:#898781;
 --grid:#2c2c2a; --eixo:#383835; --borda:rgba(255,255,255,.10);
 --s1:#3987e5; --s2:#d95926; --bom:#0ca30c; --ruim:#e66767;}}
:root[data-theme=dark]{color-scheme:dark;
 --plano:#0d0d0d; --surf:#1a1a19; --ink:#fff; --ink2:#c3c2b7; --mut:#898781;
 --grid:#2c2c2a; --eixo:#383835; --borda:rgba(255,255,255,.10);
 --s1:#3987e5; --s2:#d95926; --bom:#0ca30c; --ruim:#e66767;}
*{box-sizing:border-box}
body{margin:0;background:var(--plano);color:var(--ink);
 font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 64px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px}
h1{font-size:19px;font-weight:600;margin:0}
.sub{color:var(--mut);font-size:13px}
.card{background:var(--surf);border:1px solid var(--borda);border-radius:12px;padding:20px}
.grade{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-bottom:16px}
.conta{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-top:10px;color:var(--ink2);font-size:13px}
.conta b{color:var(--ink);font-weight:600}.conta .op{color:var(--mut)}
.heroCard{margin-bottom:16px}
.rot{color:var(--ink2);font-size:13px;margin-bottom:6px}
.hero{font-size:52px;font-weight:600;letter-spacing:-.02em;line-height:1.05}
.val{font-size:26px;font-weight:600}
.pos{color:var(--bom)}.neg{color:var(--ruim)}
.nota{color:var(--mut);font-size:12px;margin-top:6px}
.aviso{margin-top:12px;padding:9px 12px;border-radius:8px;background:var(--grid);color:var(--ink2);font-size:12px;line-height:1.45}
.duplo{display:grid;gap:16px;grid-template-columns:1.35fr 1fr;margin-bottom:16px;align-items:start}
.duplo2{display:grid;gap:16px;grid-template-columns:1fr 1fr}
@media(max-width:880px){.duplo,.duplo2{grid-template-columns:1fr}}
h2{font-size:14px;font-weight:600;margin:0 0 2px}
.h2sub{color:var(--mut);font-size:12px;margin-bottom:16px}
svg{width:100%;height:auto;display:block;overflow:visible}
.grid{stroke:var(--grid);stroke-width:1}
.eixo{stroke:var(--eixo);stroke-width:1}
.tick{fill:var(--mut);font-size:11px;font-variant-numeric:tabular-nums}
.tick.agora{fill:var(--ink);font-weight:600}
.valor{fill:var(--ink);font-size:12px;font-weight:600}
.s1{fill:var(--s1)}.s2{fill:var(--s2)}
.leg{display:flex;gap:18px;margin-top:12px;font-size:12px;color:var(--ink2)}
.leg i{width:10px;height:10px;border-radius:3px;display:inline-block;margin-right:6px}
.linha{display:grid;grid-template-columns:118px 1fr 84px;align-items:center;gap:12px;padding:5px 0}
.nome{color:var(--ink2);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trilho{height:14px;background:var(--grid);border-radius:4px;overflow:hidden}
.fill{display:block;height:100%;background:var(--s1);border-radius:0 4px 4px 0}
.num{text-align:right;font-variant-numeric:tabular-nums;font-size:13px}
.num.ent{color:var(--bom)}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:6px 4px;border-bottom:1px solid var(--grid)}
tr:last-child td{border-bottom:0}
.dia{width:44px;color:var(--mut);font-variant-numeric:tabular-nums}
.dia.passou{color:var(--eixo)}
.cat{color:var(--mut);font-size:11px;margin-left:8px}
.rolar{max-height:352px;overflow:auto;padding-right:10px;margin-right:-6px}
#tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .12s;background:var(--ink);
 color:var(--plano);padding:6px 9px;border-radius:6px;font-size:12px;z-index:9;max-width:280px}
[data-tip]{cursor:default}
</style></head><body><div class="wrap">

<header>
  <div><h1>Finanças</h1><div class="sub">${esc(mesLabel)} · atualizado ${d.hoje.split('-').reverse().join('/')}</div></div>
  <div class="sub">${d.fechados} ${d.fechados === 1 ? 'mês fechado' : 'meses fechados'} de histórico</div>
</header>

<div class="card heroCard">
  <div class="rot">Projeção de saldo até o fim de ${esc(mesLabel)}</div>
  <div class="hero ${projecao < 0 ? 'neg' : ''}">${projecao < 0 ? '−' : ''}R$ ${brl(Math.abs(projecao))}</div>
  <div class="conta">
    <span><b>R$ ${brl(d.saldo)}</b> em conta hoje</span>
    <span class="op">+</span><span>R$ ${brl(d.aVir.entra)} a entrar</span>
    <span class="op">−</span><span>R$ ${brl(d.aVir.sai)} a sair</span>
    <span class="op">−</span><span>R$ ${brl(d.faturasTotal)} de fatura${d.faturas.length === 1 ? '' : 's'}</span>
  </div>
  ${d.faturas.length ? `<div class="aviso">A vencer: ${d.faturas.map((f) => `${esc(f.cartao)} R$ ${brl(f.amount)} em ${f.vence.slice(8)}/${f.vence.slice(5, 7)}`).join(' · ')}</div>` : ''}
  ${d.saldoVelho ? `<div class="aviso"><b>Saldo desatualizado.</b> O último registro é de ${esc(dma(d.saldoEm))}, mas já há movimento de conta em ${esc(dma(d.movimentoEm))}. Enquanto não rodar <b>node fin.mjs saldo &lt;valor&gt;</b>, esta projeção está errada — pagamento de fatura e previsto confirmado saem do cálculo sem sair do saldo.</div>` : ''}
</div>

<div class="grade">
  <div class="card"><div class="rot">Saldo do mês (entradas − saídas)</div>
    <div class="val ${incompleto ? '' : saldoMes < 0 ? 'neg' : 'pos'}">${saldoMes < 0 ? '−' : ''}R$ ${brl(Math.abs(saldoMes))}</div>
    <div class="nota">${incompleto ? `incompleto — cartões importados só até ${d.cartaoAte.split('-').reverse().join('/')}` : 'realizado + previsto'}</div></div>
  <div class="card"><div class="rot">Custo fixo mensal</div><div class="val">R$ ${brl(d.fixo)}</div>
    <div class="nota">${d.recorrentes.filter((r) => r.kind === 'expense').length} compromissos recorrentes</div></div>
  <div class="card"><div class="rot">Receita recorrente</div><div class="val">R$ ${brl(d.receitaFixa)}</div>
    <div class="nota">entradas marcadas como mensais</div></div>
  <div class="card"><div class="rot">Gasto médio</div><div class="val">R$ ${brl(d.mediaGasto)}</div>
    <div class="nota">média dos ${d.fechados} meses fechados${d.parciais ? ` · ${d.parciais} deles só têm cartão, sem custo fixo lançado — o número está subestimado` : ''}</div></div>
  <div class="card"><div class="rot">Sobra sobre o fixo</div>
    <div class="val ${d.receitaFixa - d.fixo < 0 ? 'neg' : 'pos'}">R$ ${brl(d.receitaFixa - d.fixo)}</div>
    <div class="nota">antes de qualquer gasto variável</div></div>
</div>

<div class="duplo">
  <div class="card">
    <h2>Despesas por mês</h2><div class="h2sub">meses à frente são projeção dos recorrentes</div>
    ${colunasMes(d.lista, d.mesAtual)}
    <div class="leg"><span><i style="background:var(--s1)"></i>realizado</span><span><i style="background:var(--s2)"></i>previsto</span></div>
  </div>
  <div class="card">
    <h2>Para onde vai</h2><div class="h2sub">todas as despesas realizadas, por categoria</div>
    <div class="rolar">${barrasCategoria(d.categorias)}</div>
  </div>
</div>

<div class="duplo2">
  <div class="card">
    <h2>Calendário do mês</h2><div class="h2sub">recorrentes por dia de vencimento · ~ = valor de referência</div>
    <div class="rolar"><table>${calendario}</table></div>
  </div>
  <div class="card">
    <h2>Ainda vai acontecer</h2><div class="h2sub">previstos e faturas em aberto, do mais próximo ao mais distante</div>
    <div class="rolar"><table>${previstos || '<tr><td class="sub">nada previsto</td></tr>'}</table></div>
  </div>
</div>

</div><div id="tip"></div><script>
const tip = document.getElementById('tip');
addEventListener('mouseover', (e) => {
  const alvo = e.target.closest('[data-tip]');
  if (!alvo) return;
  tip.textContent = alvo.dataset.tip;
  tip.style.opacity = 1;
});
addEventListener('mousemove', (e) => {
  if (tip.style.opacity !== '1') return;
  const b = tip.getBoundingClientRect();
  tip.style.left = Math.min(e.clientX + 14, innerWidth - b.width - 8) + 'px';
  tip.style.top = Math.max(e.clientY - b.height - 12, 8) + 'px';
});
addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) tip.style.opacity = 0; });
</script></body></html>`;
}

// ---------------------------------------------------------------- servidor
http.createServer(async (req, res) => {
  try {
    const d = await carregar();
    if (req.url === '/dados.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(d));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pagina(d));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('erro: ' + e.message);
  }
}).listen(PORT, HOST, () => console.log(`painel em http://${HOST}:${PORT}`));
