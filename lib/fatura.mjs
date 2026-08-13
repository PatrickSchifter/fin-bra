// Converte o texto de uma fatura de cartão (saída do `pdftotext -layout`) em lançamentos.
//
// Regra de data: compra à vista usa a data da compra; parcela usa o vencimento da fatura
// (é quando aquela fração sai do bolso) e guarda a origem em `notes`. Por isso uma fatura
// cai em dois meses no banco — é intencional: mostra quando você gastou, não quando o
// banco cobrou.

// Layout de 2 colunas do Santander: "DD/MM  DESCRIÇÃO  [PP/NN]  VALOR", em qualquer
// posição da linha. Outros bancos imprimem diferente — veja CONTRIBUTING.md.
//
// O (?=[A-Z0-9]) não é enfeite: sem ele a descrição podia casar só com espaço, e uma linha
// tipo "ANUIDADE PARC 02/12    29,90" virava um lançamento de descrição vazia datado em
// 02/dezembro — o "02/12" da parcela era lido como se fosse a data da compra.
const RE_ITEM = /(\d{2}\/\d{2})\s+((?=[A-Z0-9])[A-Z0-9*@#&.,\/\- ]{4,40}?)\s{2,}(?:(\d{2}\/\d{2})\s+)?(-?[\d.]+,\d{2})/g;

// Tarifas do banco vêm sem data ("IOF DESPESA NO EXTERIOR   0,93") — datam no vencimento.
const RE_SEM_DATA = /^\s*((?:IOF|ANUIDADE|SEGURO|TARIFA|ENCARGO|JUROS|MULTA|MENSALIDADE)[A-Z0-9 .*\/-]{0,40}?)\s{2,}([\d.]+,\d{2})\s*$/;

// Linhas de resumo da fatura não são compra.
const RUIDO = /PAGAMENTO DE FATURA|VALOR TOTAL|SALDO|TOTAL DE|LIMITE|ANTERIOR/i;

// Palpite de categoria pelo nome do estabelecimento. É só um chute para você não
// categorizar 80 itens na mão — confira e corrija o que errar. Adicione os seus.
export const CATEGORIAS = [
  [/IFD\*|IFOOD|RAPPI|99FOOD|UBER ?\*? ?EATS|DELIVERY/i, 'delivery'],
  [/SHOPEE|MERCADOLIVRE|MERCADO ?LIVRE|MP\*|MERCADOPAGO|SHEIN|AMAZON|AMERICANAS|MAGALU|MAGAZINE|ALIEXPRESS|TEMU/i, 'compras-online'],
  [/SUPERMERCAD|ATACAD|CARREFOUR|ASSAI|PAO DE ACUCAR|HIPER|HORTIFRUTI|ACOUGUE|SACOLAO|MERCEARIA/i, 'mercado'],
  [/PADARIA|CONFEITARIA|LANCHONETE|PASTELARIA|CAFETERIA|CAFE |MCDONALD|ARCOS DOURADOS|BURGER|SUBWAY|PIZZA|RESTAURANTE/i, 'padaria-lanche'],
  [/AUTO POSTO|POSTO |IPIRANGA|SHELL|PETROBRAS|COMBUSTIVEL/i, 'combustivel'],
  [/UBER|99 ?APP|99 ?TECNOLOGIA|CABIFY|ESTAPAR|ALLPARK|ESTACIONAMENTO|PEDAGIO/i, 'transporte'],
  [/APPLE|GOOGLE|YOUTUBE|NETFLIX|SPOTIFY|DISNEY|HBO|PRIME VIDEO|OPENAI|ANTHROPIC|CLAUDE|GITHUB|MICROSOFT/i, 'assinaturas'],
  [/FARMACIA|DROGARIA|DROGASIL|PACHECO|RAIA|CLINICA|ODONTO|LABORATORIO|UNIMED|HOSPITAL/i, 'saude'],
  [/CINEMA|CINEMARK|INGRESSO|TEATRO|SYMPLA|TICKET/i, 'lazer'],
];

export const categorizar = (desc) => (CATEGORIAS.find(([r]) => r.test(desc)) || [, 'outros'])[1];

/**
 * @param {string} txt   texto da fatura (pdftotext -layout)
 * @param {{card: string, venc: string, ano?: string}} opts  venc no formato YYYY-MM-DD
 * @returns {Array<{amount, category, description, date, method, notes}>}
 */
export function parseFatura(txt, { card = 'cartao', venc, ano } = {}) {
  const anoRef = ano || (venc ? venc.slice(0, 4) : String(new Date().getFullYear()));
  const items = [];

  for (const m of txt.matchAll(RE_ITEM)) {
    const [, data, descRaw, parcela, val] = m;
    const desc = descRaw.trim().replace(/\s+/g, ' ');
    if (desc.length < 3 || RUIDO.test(desc)) continue;
    const amount = Number(val.replace(/\./g, '').replace(',', '.'));
    if (amount <= 0) continue;                    // créditos e estornos não são despesa
    const [dd, mm] = data.split('/');
    items.push({
      amount,
      category: categorizar(desc),
      description: parcela ? `${desc} ${parcela}` : desc,
      date: parcela ? venc : `${anoRef}-${mm}-${dd}`,
      method: card,
      notes: parcela ? `parcela ${parcela}; compra em ${data}` : null,
    });
  }

  for (const linha of txt.split('\n')) {
    const m = linha.match(RE_SEM_DATA);
    if (!m) continue;
    items.push({
      amount: Number(m[2].replace(/\./g, '').replace(',', '.')),
      category: 'tarifas',
      description: m[1].trim().replace(/\s+/g, ' '),
      date: venc,
      method: card,
      notes: 'lançamento sem data na fatura; datado no vencimento',
    });
  }

  return items;
}

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
