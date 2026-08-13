-- Finanças pessoais — schema simples (uma tabela de lançamentos + orçamentos opcionais)
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

CREATE TABLE tx (
  id          serial PRIMARY KEY,
  kind        text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income')),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  category    text NOT NULL,
  description text,
  occurred_on date NOT NULL DEFAULT current_date,
  method      text,                       -- pix, credito, debito, dinheiro, boleto...
  recurring   boolean NOT NULL DEFAULT false,
  due_day     int CHECK (due_day BETWEEN 1 AND 31),  -- dia do vencimento, p/ recorrentes
  series      text,                       -- chave estável do recorrente (ex: 'internet', 'consorcio'); descrição muda todo mês
  pending     boolean NOT NULL DEFAULT false,  -- true = previsto (ainda não aconteceu), false = realizado
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tx_occurred_on_idx ON tx (occurred_on DESC);
CREATE INDEX tx_category_idx ON tx (category);

-- Orçamento mensal por categoria (opcional). month = primeiro dia do mês, ou NULL = padrão sempre.
CREATE TABLE budget (
  id       serial PRIMARY KEY,
  category text NOT NULL,
  amount   numeric(12,2) NOT NULL CHECK (amount > 0),
  month    date,
  UNIQUE (category, month)
);

-- Saldo observado em conta. É um retrato num instante, não um lançamento:
-- o fluxo vive em tx; aqui fica quanto realmente existe na conta na data.
CREATE TABLE saldo (
  id          serial PRIMARY KEY,
  conta       text NOT NULL DEFAULT 'principal',
  amount      numeric(12,2) NOT NULL,
  observed_on date NOT NULL DEFAULT current_date,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saldo_conta_data_idx ON saldo (conta, observed_on DESC);

-- Fatura de cartão: é evento de CAIXA (dinheiro saindo da conta no vencimento).
-- As compras já estão em tx pela data da compra; lançar a fatura em tx dobraria a despesa.
-- Por isso ela mora aqui e só entra na projeção de saldo.
CREATE TABLE fatura (
  cartao     text NOT NULL,
  vencimento date NOT NULL,
  amount     numeric(12,2) NOT NULL,
  pago       boolean NOT NULL DEFAULT false,
  notes      text,
  PRIMARY KEY (cartao, vencimento)
);
