import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categorizar, parseFatura, parseFaturaCompleto, resumo } from '../lib/fatura.mjs';

const fixture = (nome) => readFileSync(new URL(`./fixtures/${nome}`, import.meta.url), 'utf8');
const buscador = (items) => (t) => items.find((i) => i.description.includes(t));

const txt = fixture('fatura-exemplo.txt');
const items = parseFatura(txt, { card: 'cartao-teste', venc: '2026-08-12' });
const acha = buscador(items);

describe('parseFatura', () => {
  it('compra à vista usa a data da compra', () => {
    assert.equal(acha('IFOOD').date, '2026-07-14');
    assert.equal(acha('IFOOD').amount, 48.9);
    assert.equal(acha('IFOOD').notes, null);
  });

  it('parcela usa o vencimento da fatura e guarda a origem em notes', () => {
    const p = acha('LOJA DE MOVEIS');
    assert.equal(p.date, '2026-08-12', 'parcela deve cair no vencimento, não na data da compra');
    assert.equal(p.description, 'LOJA DE MOVEIS EXEMPLO 03/10');
    assert.match(p.notes, /parcela 03\/10; compra em 17\/07/);
  });

  it('tarifa sem data é datada no vencimento', () => {
    const iof = acha('IOF');
    assert.equal(iof.date, '2026-08-12');
    assert.equal(iof.category, 'tarifas');
    assert.equal(iof.amount, 0.93);
  });

  it('pagamento da fatura não vira despesa — lançar dobraria o gasto', () => {
    assert.equal(acha('PAGAMENTO DE FATURA'), undefined);
  });

  it('estorno não vira despesa', () => {
    assert.equal(acha('ESTORNO'), undefined);
  });

  it('linha de resumo não vira lançamento', () => {
    for (const ruido of ['SALDO ANTERIOR', 'TOTAL DE DESPESAS', 'LIMITE']) {
      assert.equal(acha(ruido), undefined, `"${ruido}" não é compra`);
    }
  });

  it('tarifa parcelada é tarifa, não um lançamento de descrição vazia em dezembro', () => {
    // "ANUIDADE DIFERENCIADA PARC 02/12   29,90": o 02/12 é parcela, não data de compra
    const a = acha('ANUIDADE');
    assert.equal(a.category, 'tarifas');
    assert.equal(a.date, '2026-08-12');
    assert.equal(a.amount, 29.9);
  });

  it('nenhum item sai sem descrição', () => {
    for (const i of items) assert.ok(i.description.trim().length >= 3, `descrição vazia em ${JSON.stringify(i)}`);
  });

  it('nenhuma data cai fora do intervalo plausível da fatura', () => {
    for (const i of items) assert.ok(i.date >= '2026-07-01' && i.date <= '2026-08-12', `${i.description} datado em ${i.date}`);
  });

  it('todo item sai com cartão e valor positivo', () => {
    assert.ok(items.length >= 12, `esperava ao menos 12 itens, veio ${items.length}`);
    for (const i of items) {
      assert.equal(i.method, 'cartao-teste');
      assert.ok(i.amount > 0, `${i.description} veio com valor ${i.amount}`);
      assert.match(i.date, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('o total bate com o "Total de Despesas" impresso na fatura', () => {
    // é a conferência que o README manda fazer na mão a cada importação
    assert.equal(resumo(items).total.toFixed(2), '1523.65');
  });
});

// ---------------------------------------------------------------------- Porto
describe('layout porto', () => {
  const r = parseFaturaCompleto(fixture('fatura-porto.txt'), {
    card: 'porto', venc: '2026-08-01', layout: 'porto',
  });
  const achaP = buscador(r.items);

  it('o total bate com a soma dos subtotais impressos por cartão', () => {
    // 185,10 (final *901) + 330,70 (final *902) + 492,40 (internacionais)
    assert.equal(resumo(r.items).total.toFixed(2), '1008.20');
  });

  it('lê descrição em caixa mista — era o que o regex do Santander perdia', () => {
    // o charset só aceitava maiúsculas, então "PostoExemploShellBox" sumia calado
    assert.equal(achaP('PostoExemploShellBox').amount, 118.2);
    assert.equal(achaP('Google Crunchyroll').amount, 27.9);
  });

  it('na seção internacional vale a coluna em R$, não a em US$', () => {
    // "DIGITALOCEAN ...   2,17   12,40": 2,17 é dólar, 12,40 é o que o banco cobra
    assert.equal(achaP('DIGITALOCEAN').amount, 12.4);
  });

  it('pagamento e desconto entram como crédito, nunca como despesa', () => {
    assert.equal(achaP('PAGAMENTO PIX'), undefined);
    assert.equal(achaP('DescPosto'), undefined);
    assert.equal(r.creditos.n, 2);
    assert.equal(r.creditos.total.toFixed(2), '1503.10');   // 1.500,00 + 3,10
  });

  it('parcela colada no fim da descrição vira parcela, não parte do nome', () => {
    const a = achaP('ANUIDADE');
    assert.equal(a.description, 'ANUIDADE DIFERENCIADA 10/12');
    assert.equal(a.date, '2026-08-01', 'parcela cai no vencimento');
    assert.match(a.notes, /parcela 10\/12; compra em 25\/06/);
  });

  it('nada de fora das seções de lançamento vira item', () => {
    // limite, simulação de parcelamento e encargos também são "R$ x" na página
    for (const proibido of [2790, 2664, 2500, 288, 1005.1]) {
      assert.equal(r.items.find((i) => i.amount === proibido), undefined, `${proibido} não é compra`);
    }
  });

  it('a categoria sai do nome do estabelecimento', () => {
    assert.equal(achaP('DIGITALOCEAN').category, 'assinaturas');
    assert.equal(achaP('UNIMED').category, 'saude');
    assert.equal(achaP('MELIMAIS').category, 'compras-online');
    assert.equal(achaP('IOF').category, 'tarifas');
  });
});

// ---------------------------------------------------------------------- Caixa
describe('layout caixa', () => {
  const r = parseFaturaCompleto(fixture('fatura-caixa.txt'), {
    card: 'caixa', venc: '2026-08-11', layout: 'caixa',
  });
  const achaC = buscador(r.items);

  it('o total bate com o "Total final" impresso na fatura', () => {
    assert.equal(resumo(r.items).total.toFixed(2), '275.60');
    assert.equal(r.items.length, 2);
  });

  it('o sufixo C é crédito, não despesa', () => {
    // o bug que motivou este layout: "OBRIGADO PELO PAGAMENTO 275,50C" entrava como
    // despesa — a dois centavos do total impresso, invisível numa conferência apressada
    assert.equal(achaC('OBRIGADO PELO PAGAMENTO'), undefined);
    for (const i of r.items) assert.ok(i.amount > 0, `${i.description} veio com valor ${i.amount}`);
  });

  it('o ajuste órfão da descrição ainda é contado como crédito', () => {
    // a Caixa imprime "AJUSTE CRED PARC S/ JUROS" numa linha e "0,10C" noutra
    assert.equal(r.creditos.n, 3);
    assert.equal(r.creditos.total.toFixed(2), '275.62');   // 275,50 + 0,10 + 0,02
  });

  it('parcela escrita "12 DE 12" vira 12/12 e cai no vencimento', () => {
    const p = achaC('LOJA EXEMPLO');
    assert.equal(p.amount, 210.4);
    assert.equal(p.date, '2026-08-11');
    assert.match(p.description, /12\/12$/);
    assert.match(p.notes, /parcela 12\/12; compra em 27\/08/);
  });

  it('parcela com a coluna quebrada em duas linhas é remontada', () => {
    // "11 DE" fecha a linha e o "11" desce sozinho para a seguinte
    const p = achaC('MERCADO EXEMPLO');
    assert.equal(p.amount, 65.2);
    assert.match(p.description, /11\/11$/);
    assert.equal(p.date, '2026-08-11');
  });

  it('linha de resumo e boleto não viram lançamento', () => {
    for (const proibido of [275.48, 3000, 144.53, 41.32]) {
      assert.equal(r.items.find((i) => i.amount === proibido), undefined, `${proibido} não é compra`);
    }
  });
});

describe('parseFatura: guardas comuns a todo layout', () => {
  it('layout desconhecido falha alto, em vez de devolver lista vazia', () => {
    assert.throws(() => parseFatura('qualquer coisa', { venc: '2026-08-01', layout: 'itau' }), /layout desconhecido/);
  });

  it('o layout errado não devolve a fatura pela metade sem avisar', () => {
    // é o cenário real: a fatura da Caixa lida como Santander devolvia 1 item — o
    // pagamento da fatura anterior — em vez das 2 compras parceladas
    const comoSantander = parseFatura(fixture('fatura-caixa.txt'), { venc: '2026-08-11', layout: 'santander' });
    const comoCaixa = parseFatura(fixture('fatura-caixa.txt'), { venc: '2026-08-11', layout: 'caixa' });
    assert.notEqual(
      resumo(comoSantander).total.toFixed(2),
      resumo(comoCaixa).total.toFixed(2),
      'se os dois batessem, este teste não estaria provando nada',
    );
  });
});

describe('categorizar', () => {
  it('reconhece os grandes por nome', () => {
    assert.equal(categorizar('IFD*IFOOD'), 'delivery');
    assert.equal(categorizar('SUPERMERCADO EXEMPLO'), 'mercado');
    assert.equal(categorizar('NETFLIX.COM'), 'assinaturas');
    assert.equal(categorizar('AUTO POSTO EXEMPLO'), 'combustivel');
    assert.equal(categorizar('UBER   *TRIP'), 'transporte');
    assert.equal(categorizar('DROGARIA EXEMPLO'), 'saude');
  });

  it('tarifa do banco é tarifa; seguro contratado não é', () => {
    // a regra é ancorada no início justamente para separar os dois
    assert.equal(categorizar('ANUIDADE DIFERENCIADA'), 'tarifas');
    assert.equal(categorizar('IOF TRANSACOES INTERNACIONAIS'), 'tarifas');
    assert.equal(categorizar('SEGURADORA EXEMPLO Seg SAO PAULO'), 'outros');
  });

  it('o que não reconhece cai em outros, não some', () => {
    assert.equal(categorizar('ESTABELECIMENTO SEM CATEGORIA'), 'outros');
  });
});
