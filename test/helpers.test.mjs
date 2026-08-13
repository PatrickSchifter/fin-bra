import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  money, monthRange, nullable, num, parseArgs, proximaParcela, table, toDate, ultimoDiaDoMes,
} from '../lib/helpers.mjs';

describe('num', () => {
  it('lê os formatos que uma pessoa digita de verdade', () => {
    assert.equal(num('35.90'), 35.9);
    assert.equal(num('35,90'), 35.9);
    assert.equal(num('1.200,50'), 1200.5);      // pt-BR
    assert.equal(num('1,200.50'), 1200.5);      // en-US
    assert.equal(num('R$ 1200'), 1200);
    assert.equal(num('R$ 1.234,56'), 1234.56);
    assert.equal(num(42), 42);
  });

  it('recusa o que não é número em vez de virar NaN silencioso', () => {
    assert.throws(() => num('abc'), /valor inválido/);
    assert.throws(() => num(''), /valor inválido/);
  });
});

describe('money', () => {
  it('sempre com duas casas', () => {
    assert.equal(money(5), '5.00');
    assert.equal(money('1200.5'), '1200.50');
  });
});

describe('nullable', () => {
  it('"null", vazio e flag sem valor limpam o campo', () => {
    assert.equal(nullable('null'), null);
    assert.equal(nullable(''), null);
    assert.equal(nullable(true), null);
    assert.equal(nullable('texto'), 'texto');
  });
});

describe('toDate', () => {
  const hoje = new Date(2026, 7, 13);   // 13/08/2026, hora local

  it('aceita ISO, dd/mm e dd/mm/aaaa', () => {
    assert.equal(toDate('2026-08-05', hoje), '2026-08-05');
    assert.equal(toDate('05/08', hoje), '2026-08-05');
    assert.equal(toDate('5/8', hoje), '2026-08-05');
    assert.equal(toDate('05/08/2025', hoje), '2025-08-05');
    assert.equal(toDate('05/08/25', hoje), '2025-08-05');
  });

  it('aceita atalhos relativos', () => {
    assert.equal(toDate('hoje', hoje), '2026-08-13');
    assert.equal(toDate('ontem', hoje), '2026-08-12');
    assert.equal(toDate('-3', hoje), '2026-08-10');
  });

  it('atravessa a virada do mês para trás', () => {
    assert.equal(toDate('-13', new Date(2026, 7, 3)), '2026-07-21');
    assert.equal(toDate('ontem', new Date(2026, 0, 1)), '2025-12-31');
  });

  it('sem valor é null (o banco usa current_date)', () => {
    assert.equal(toDate(undefined), null);
    assert.equal(toDate(''), null);
  });

  it('recusa data inválida', () => {
    assert.throws(() => toDate('semana passada'), /data inválida/);
  });
});

describe('monthRange', () => {
  const hoje = new Date(2026, 7, 13);

  it('mês explícito', () => {
    assert.deepEqual(monthRange('2026-08', hoje), { start: '2026-08-01', end: '2026-09-01', label: '2026-08' });
  });

  it('mês atual quando não vem nada', () => {
    assert.equal(monthRange(undefined, hoje).label, '2026-08');
    assert.equal(monthRange(true, hoje).label, '2026-08');       // --month sem valor
    assert.equal(monthRange('atual', hoje).label, '2026-08');
  });

  it('offset negativo anda para trás, virando o ano', () => {
    assert.equal(monthRange('-1', hoje).label, '2026-07');
    assert.equal(monthRange('-8', hoje).label, '2025-12');
  });

  it('dezembro fecha em janeiro do ano seguinte', () => {
    assert.deepEqual(monthRange('2026-12', hoje), { start: '2026-12-01', end: '2027-01-01', label: '2026-12' });
  });

  it('recusa mês inválido', () => {
    assert.throws(() => monthRange('agosto', hoje), /mês inválido/);
  });
});

describe('ultimoDiaDoMes', () => {
  it('conhece fevereiro e ano bissexto', () => {
    assert.equal(ultimoDiaDoMes('2026-02-01'), 28);
    assert.equal(ultimoDiaDoMes('2028-02-01'), 29);
    assert.equal(ultimoDiaDoMes('2026-04-01'), 30);
    assert.equal(ultimoDiaDoMes('2026-12-01'), 31);
  });
});

describe('proximaParcela', () => {
  it('avança o contador', () => {
    assert.deepEqual(proximaParcela('Geladeira parcela 19/36'), { desc: 'Geladeira parcela 20/36', fim: false });
    assert.deepEqual(proximaParcela('Geladeira (1 de 10)'), { desc: 'Geladeira (2 de 10)', fim: false });
  });

  it('para quando a última parcela chegou — é isso que impede o roll de cobrar para sempre', () => {
    assert.deepEqual(proximaParcela('Sofá 10/10'), { desc: 'Sofá 10/10', fim: true });
    assert.deepEqual(proximaParcela('Sofá 11/10'), { desc: 'Sofá 11/10', fim: true });
  });

  it('não confunde data com parcela', () => {
    assert.deepEqual(proximaParcela('Aluguel 07/2026'), { desc: 'Aluguel 07/2026', fim: false });
  });

  it('descrição sem parcela passa intacta', () => {
    assert.deepEqual(proximaParcela('Internet'), { desc: 'Internet', fim: false });
    assert.deepEqual(proximaParcela(null), { desc: null, fim: false });
  });
});

describe('parseArgs', () => {
  it('separa flags de posicionais', () => {
    assert.deepEqual(
      parseArgs(['35,90', 'mercado', 'pão', '--date', '05/08', '--kind=income']),
      { flags: { date: '05/08', kind: 'income' }, pos: ['35,90', 'mercado', 'pão'] },
    );
  });

  it('flag sem valor é true', () => {
    assert.deepEqual(parseArgs(['--dry', '--json']), { flags: { dry: true, json: true }, pos: [] });
  });

  it('valor negativo não é confundido com flag', () => {
    assert.equal(parseArgs(['--date', '-3']).flags.date, '-3');
  });
});

describe('table', () => {
  it('alinha as colunas', () => {
    const t = table([{ id: 1, cat: 'mercado' }, { id: 22, cat: 'uber' }]);
    assert.equal(t, 'id  cat\n--  -------\n1   mercado\n22  uber');
  });

  it('lista vazia não quebra', () => {
    assert.equal(table([]), '(vazio)');
  });

  it('null vira coluna em branco, não a string "null"', () => {
    assert.match(table([{ a: 1, b: null }]), /^a  b\n/);
  });
});

// ---------------------------------------------------------------------------
// Regressão de fuso horário. Lançamento é um fato do calendário do usuário; usar
// toISOString() (que é UTC) fazia "hoje" às 22h em São Paulo virar amanhã, e o fim
// do mês voltar um dia em qualquer fuso a leste de Greenwich — o que silenciosamente
// deixava o último dia do mês fora de todo relatório.
describe('fuso horário', () => {
  const rodar = (tz, código) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', código], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      cwd: new URL('..', import.meta.url).pathname,
    }).trim();

  for (const tz of ['America/Sao_Paulo', 'UTC', 'Europe/Lisbon', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
    it(`o fim do mês é o dia 1º do mês seguinte em ${tz}`, () => {
      const saida = rodar(tz, `
        import { monthRange } from './lib/helpers.mjs';
        console.log(monthRange('2026-08').end);
      `);
      assert.equal(saida, '2026-09-01');
    });

    it(`"hoje" é a data do calendário local em ${tz}`, () => {
      const saida = rodar(tz, `
        import { toDate, isoLocal } from './lib/helpers.mjs';
        const agora = new Date();
        console.log(toDate('hoje') === isoLocal(agora) ? 'ok' : toDate('hoje') + ' != ' + isoLocal(agora));
      `);
      assert.equal(saida, 'ok');
    });
  }

  it('lançamento feito às 22h fica no dia de hoje, não no de amanhã', () => {
    // 13/08 22:30 em São Paulo já é 14/08 01:30 em UTC — é aqui que o toISOString errava
    const saida = rodar('America/Sao_Paulo', `
      import { toDate } from './lib/helpers.mjs';
      console.log(toDate('hoje', new Date('2026-08-13T22:30:00-03:00')));
    `);
    assert.equal(saida, '2026-08-13');
  });
});
