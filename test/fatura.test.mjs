import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categorizar, parseFatura, resumo } from '../lib/fatura.mjs';

const txt = readFileSync(new URL('./fixtures/fatura-exemplo.txt', import.meta.url), 'utf8');
const items = parseFatura(txt, { card: 'cartao-teste', venc: '2026-08-12' });
const acha = (t) => items.find((i) => i.description.includes(t));

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

describe('categorizar', () => {
  it('reconhece os grandes por nome', () => {
    assert.equal(categorizar('IFD*IFOOD'), 'delivery');
    assert.equal(categorizar('SUPERMERCADO EXEMPLO'), 'mercado');
    assert.equal(categorizar('NETFLIX.COM'), 'assinaturas');
    assert.equal(categorizar('AUTO POSTO EXEMPLO'), 'combustivel');
    assert.equal(categorizar('UBER   *TRIP'), 'transporte');
    assert.equal(categorizar('DROGARIA EXEMPLO'), 'saude');
  });

  it('o que não reconhece cai em outros, não some', () => {
    assert.equal(categorizar('ESTABELECIMENTO SEM CATEGORIA'), 'outros');
  });
});
