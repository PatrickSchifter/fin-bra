// Converte o texto de uma fatura de cartão (saída do `pdftotext -layout`) em lançamentos.
//
// Regra de data: compra à vista usa a data da compra; parcela usa o vencimento da fatura
// (é quando aquela fração sai do bolso) e guarda a origem em `notes`. Por isso uma fatura
// cai em dois meses no banco — é intencional: mostra quando você gastou, não quando o
// banco cobrou.
//
// Cada banco imprime de um jeito, e o layout é escolhido explicitamente no `--layout`.
// NÃO há detecção automática de propósito: rodar o regex errado não falha, devolve um
// resultado parcial que parece certo. Lida com o parser do Santander, a fatura da Caixa
// devolvia um único "item": o pagamento da fatura anterior, um crédito lido como despesa,
// com valor a centavos do total impresso. Passaria por uma conferência apressada. Daí as
// três defesas: layout explícito, crédito contado à parte em vez de descartado no
// silêncio, e erro quando não sai nada.

const brl = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));
const limpar = (s) => String(s).trim().replace(/\s+/g, ' ');

// Palpite de categoria pelo nome do estabelecimento. É só um chute para você não
// categorizar 80 itens na mão — confira e corrija o que errar. Adicione os seus.
export const CATEGORIAS = [
  // Ancorado no início: "ANUIDADE DIFERENCIADA" é tarifa do banco, mas "<seguradora>
  // SEGURO" é uma despesa de seguro de verdade. Sem a âncora, todo seguro contratado
  // que você paga no cartão viraria tarifa.
  [/^(IOF|ANUIDADE|TARIFA|ENCARGO|JUROS|MULTA|MENSALIDADE|CARTAO PROTEGIDO)/i, 'tarifas'],
  [/IFD\*|IFOOD|RAPPI|99FOOD|UBER ?\*? ?EATS|DELIVERY/i, 'delivery'],
  [/SHOPEE|MERCADOLIVRE|MERCADO ?LIVRE|MELIMAIS|MP\*|MERCADOPAGO|SHEIN|AMAZON|AMERICANAS|MAGALU|MAGAZINE|ALIEXPRESS|TEMU/i, 'compras-online'],
  [/SUPERMERCAD|ATACAD|CARREFOUR|ASSAI|PAO DE ACUCAR|HIPER|HORTIFRUTI|ACOUGUE|SACOLAO|MERCEARIA/i, 'mercado'],
  [/PADARIA|CONFEITARIA|LANCHONETE|PASTELARIA|CAFETERIA|CAFE |MCDONALD|ARCOS DOURADOS|BURGER|SUBWAY|PIZZA|RESTAURANTE/i, 'padaria-lanche'],
  [/AUTO POSTO|POSTO |IPIRANGA|SHELL|PETROBRAS|COMBUSTIVEL|SHELLBOX/i, 'combustivel'],
  [/UBER|99 ?APP|99 ?TECNOLOGIA|CABIFY|ESTAPAR|ALLPARK|ESTACIONAMENTO|PEDAGIO/i, 'transporte'],
  [/APPLE|GOOGLE|YOUTUBE|NETFLIX|SPOTIFY|DISNEY|HBO|PRIME VIDEO|CRUNCHYROLL|OPENAI|ANTHROPIC|CLAUDE|GITHUB|MICROSOFT|DIGITALOCEAN|TOTALPASS/i, 'assinaturas'],
  [/FARMACIA|DROGARIA|DROGASIL|PACHECO|RAIA|CLINICA|ODONTO|LABORATORIO|UNIMED|HOSPITAL/i, 'saude'],
  [/CINEMA|CINEMARK|INGRESSO|TEATRO|SYMPLA|TICKET/i, 'lazer'],
];

export const categorizar = (desc) => (CATEGORIAS.find(([r]) => r.test(desc)) || [, 'outros'])[1];

// Linhas de resumo da fatura não são compra.
const RUIDO = /PAGAMENTO DE FATURA|VALOR TOTAL|SALDO|TOTAL DE|TOTAL DA|LIMITE|ANTERIOR/i;

// Aceita "12/12" e "12 DE 12". Recusa o que não é parcela: total 1, contador maior que o
// total, e sequência longa demais para ser parcelamento (ano, CEP, número de loja).
function lerParcela(a, b) {
  const [atual, total] = [Number(a), Number(b)];
  if (!Number.isFinite(atual) || !Number.isFinite(total)) return null;
  if (total < 2 || total > 120 || atual < 1 || atual > total) return null;
  return `${String(atual).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ Santander
// Layout de 2 colunas: "DD/MM  DESCRIÇÃO  [PP/NN]  VALOR", em qualquer posição da linha.
//
// O (?=[A-Z0-9]) não é enfeite: sem ele a descrição podia casar só com espaço, e uma linha
// tipo "ANUIDADE PARC 02/12    29,90" virava um lançamento de descrição vazia datado em
// 02/dezembro — o "02/12" da parcela era lido como se fosse a data da compra.
const RE_ITEM = /(\d{2}\/\d{2})\s+((?=[A-Z0-9])[A-Z0-9*@#&.,\/\- ]{4,40}?)\s{2,}(?:(\d{2}\/\d{2})\s+)?(-?[\d.]+,\d{2})/g;

// Tarifas do banco vêm sem data ("IOF DESPESA NO EXTERIOR   0,93") — datam no vencimento.
const RE_SEM_DATA = /^\s*((?:IOF|ANUIDADE|SEGURO|TARIFA|ENCARGO|JUROS|MULTA|MENSALIDADE)[A-Z0-9 .*\/-]{0,40}?)\s{2,}([\d.]+,\d{2})\s*$/;

function layoutSantander(txt) {
  const out = [];

  for (const m of txt.matchAll(RE_ITEM)) {
    const [, data, descRaw, parcela, val] = m;
    const desc = limpar(descRaw);
    if (desc.length < 3 || RUIDO.test(desc)) continue;
    out.push({ desc, data, parcela: parcela || null, amount: brl(val) });
  }

  for (const linha of txt.split('\n')) {
    const m = linha.match(RE_SEM_DATA);
    if (!m) continue;
    out.push({ desc: limpar(m[1]), amount: brl(m[2]), semData: true, category: 'tarifas' });
  }

  return out;
}

// ---------------------------------------------------------------------- Porto
// "DD/MM   ESTABELECIMENTO   VALOR", uma seção por cartão e outra para o internacional.
//
// Duas diferenças que quebravam o regex do Santander: a Porto imprime em caixa mista
// ("PortoSeguroShellBox", "Google Crunchyroll An"), e a seção internacional tem DUAS
// colunas de valor — US$ e R$. Vale sempre a última, que é a que o banco cobra.
//
// A leitura é presa às seções porque o resto da fatura é um campo minado de valores:
// simulações de parcelamento, limites, encargos, tudo com "R$ x.xxx,xx" solto.
const PORTO_INICIO = /^(Lançamentos: compras e saques|Lançamentos Internacionais)/i;
const PORTO_FIM = /^(Lançamentos no cartão|Total lançamentos internacionais)/i;
const PORTO_ITEM = /^\s*(\d{2}\/\d{2})\s{2,}(\S.*?)\s{2,}((?:-?[\d.]*\d,\d{2})(?:\s+-?[\d.]*\d,\d{2})*)\s*$/;

function layoutPorto(txt) {
  const out = [];
  let dentro = false;

  for (const linha of txt.split('\n')) {
    const t = linha.trim();
    if (PORTO_FIM.test(t)) { dentro = false; continue; }
    if (PORTO_INICIO.test(t)) { dentro = true; continue; }
    if (!dentro) continue;

    const m = linha.match(PORTO_ITEM);
    if (!m) continue;

    const [, data, descRaw, valores] = m;
    let desc = limpar(descRaw);
    if (desc.length < 3 || RUIDO.test(desc)) continue;

    // parcela vem colada no fim da descrição: "ANUIDADE DIFERENCIADA 10/12"
    let parcela = null;
    const p = desc.match(/\s(\d{1,3})\/(\d{1,3})$/);
    if (p && (parcela = lerParcela(p[1], p[2]))) desc = desc.slice(0, p.index).trim();

    out.push({ desc, data, parcela, amount: brl(valores.trim().split(/\s+/).pop()) });
  }

  return out;
}

// ---------------------------------------------------------------------- Caixa
// "DD/MM  DESCRIÇÃO  [NN DE NN]  CIDADE  VALOR<D|C>", espalhado pela largura da página.
//
// O sinal do lançamento é o sufixo D/C, não o menos. É o detalhe que fazia
// "OBRIGADO PELO PAGAMENTO  ...C" — o pagamento da fatura anterior — entrar como despesa
// quando lido pelo parser do Santander.
//
// A parcela é escrita "12 DE 12" e a coluna quebra: "11 DE" numa linha e "11" na
// seguinte. Por isso este layout é lido linha a linha, com espiada na próxima.
const CAIXA_INICIO = /^Data\s+Descrição/i;
const CAIXA_FIM = /^(Total|Encargos)\b/i;
const CAIXA_ITEM = /^(\d{2}\/\d{2})\s{2,}(\S.*?)\s{2,}(-?[\d.]*\d,\d{2})\s*([DC])\s*$/;
const CAIXA_SO_VALOR = /^(-?[\d.]*\d,\d{2})\s*([DC])$/;   // ajuste/estorno órfão da descrição
const CAIXA_PARCELA = /\b(\d{1,3})\s+DE(?:\s+(\d{1,3})\b)?/;

function layoutCaixa(txt) {
  const linhas = txt.split('\n').map((l) => l.trim());
  const out = [];
  let dentro = false;

  for (let i = 0; i < linhas.length; i++) {
    const t = linhas[i];
    if (CAIXA_INICIO.test(t)) { dentro = true; continue; }
    if (dentro && CAIXA_FIM.test(t)) { dentro = false; continue; }
    if (!dentro) continue;

    // valor sozinho na linha: a Caixa desgruda o ajuste de crédito da sua descrição.
    // Não dá para saber de que compra veio, mas contar como crédito evita sumir com ele.
    const so = t.match(CAIXA_SO_VALOR);
    if (so) {
      out.push({ desc: 'ajuste sem descrição', amount: so[2] === 'C' ? -brl(so[1]) : brl(so[1]) });
      continue;
    }

    const m = t.match(CAIXA_ITEM);
    if (!m) continue;

    const [, data, descRaw, val, sinal] = m;
    let desc = limpar(descRaw);
    if (desc.length < 3 || RUIDO.test(desc)) continue;

    let parcela = null;
    const p = desc.match(CAIXA_PARCELA);
    if (p) {
      // total na linha de baixo quando a coluna quebrou
      const total = p[2] ?? (linhas[i + 1]?.match(/^(\d{1,3})$/) || [])[1];
      parcela = lerParcela(p[1], total);
      if (parcela) desc = limpar(desc.replace(p[0], ' '));
    }

    out.push({ desc, data, parcela, amount: sinal === 'C' ? -brl(val) : brl(val) });
  }

  return out;
}

export const LAYOUTS = { santander: layoutSantander, porto: layoutPorto, caixa: layoutCaixa };

function montar(b, { card, venc, anoRef }) {
  const [dd, mm] = String(b.data ?? '').split('/');
  return {
    amount: b.amount,
    category: b.category || categorizar(b.desc),
    description: b.parcela ? `${b.desc} ${b.parcela}` : b.desc,
    date: b.parcela || b.semData ? venc : `${anoRef}-${mm}-${dd}`,
    method: card,
    notes: b.parcela
      ? `parcela ${b.parcela}; compra em ${b.data}`
      : b.semData
        ? 'lançamento sem data na fatura; datado no vencimento'
        : null,
  };
}

/**
 * @param {string} txt   texto da fatura (pdftotext -layout)
 * @param {{card: string, venc: string, ano?: string, layout?: string}} opts  venc no formato YYYY-MM-DD
 * @returns {{items: Array<{amount, category, description, date, method, notes}>, creditos: {n: number, total: number}}}
 */
export function parseFaturaCompleto(txt, { card = 'cartao', venc, ano, layout = 'santander' } = {}) {
  const ler = LAYOUTS[layout];
  if (!ler) throw new Error(`layout desconhecido: ${layout} (use ${Object.keys(LAYOUTS).join(', ')})`);
  const anoRef = ano || (venc ? venc.slice(0, 4) : String(new Date().getFullYear()));

  const brutos = ler(txt);
  // Crédito não é despesa negativa, é dinheiro que não saiu: pagamento da fatura, estorno,
  // desconto. Entra em `tx` dobraria a conta. Mas é devolvido no resumo, porque é ele que
  // explica a diferença entre a soma dos itens e o total impresso na fatura.
  const creditos = brutos.filter((b) => b.amount <= 0);

  return {
    items: brutos.filter((b) => b.amount > 0).map((b) => montar(b, { card, venc, anoRef })),
    creditos: { n: creditos.length, total: creditos.reduce((s, b) => s + Math.abs(b.amount), 0) },
  };
}

export const parseFatura = (txt, opts) => parseFaturaCompleto(txt, opts).items;

export const resumo = (items) => {
  const por = {};
  for (const i of items) {
    (por[i.category] ??= { n: 0, total: 0 });
    por[i.category].n++;
    por[i.category].total += i.amount;
  }
  return {
    n: items.length,
    total: items.reduce((s, i) => s + i.amount, 0),
    categorias: Object.entries(por).sort((a, b) => b[1].total - a[1].total),
  };
};
