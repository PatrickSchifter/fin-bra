# fin-bra

CLI de finanças pessoais sobre Postgres. Toda escrita passa pelo `node fin.mjs` —
**não escreva SQL de escrita direto, não crie scripts novos.**

Este arquivo é a instrução para agentes (Claude Code e afins). Se você é humano, o
[README.md](README.md) é mais útil.

**Economia de contexto.** A saída dos comandos é curta de propósito: `sum` resume o mês em
~1 KB, `saldo` em menos de 300 bytes. Prefira sempre o agregado (`sum`, `due`, `saldo`,
`budget`, `q` com `GROUP BY`) a puxar a lista crua — um banco em uso tem centenas de
lançamentos, e despejar todos gasta o contexto sem responder melhor. `list` é para achar um
lançamento específico, com `--search` ou `--limit`, não para ler o mês.

O `.claude/settings.json` do projeto já libera consulta, `add`, `ok` e `roll` sem pedir
permissão. `del`, `edit` e `init` ficam fora da allowlist de propósito — eles reescrevem
histórico e o usuário quer ser perguntado. Não contorne isso via `q` ou `psql`.

## Configuração (`.env`)

Só `DATABASE_URL` é obrigatória; o resto tem default. O arquivo **não é versionado** — se ele
não existir, o erro já diz o que fazer, então não invente conexão nem crie `.env` sem pedir.
Variável de ambiente tem precedência sobre o arquivo.

| Variável | Default | Para que serve |
|---|---|---|
| `DATABASE_URL` | — | **Obrigatória.** Procurada no ambiente e, se ausente, no `.env` da raiz. |
| `DATABASE_SSL` | decidido pelo host | `disable` \| `no-verify` \| `require`. Remoto liga TLS, `localhost` desliga; isto força. |
| `PORT` | `4173` | Porta do painel. |
| `HOST` | `127.0.0.1` | Interface do painel. **Não mude para `0.0.0.0`** — o painel não tem autenticação. |
| `CONTA_METHOD` | `conta` | Qual `method` é movimento de conta corrente (não cartão). Alimenta o aviso de "mês incompleto" do painel. |

## Modelo de dados

`tx(id, kind expense|income, amount, category, description, occurred_on, method, recurring, due_day, series, pending, notes)`
`budget(id, category, amount, month)` · `saldo(conta, amount, observed_on)` · `fatura(cartao, vencimento, amount, pago)`

- `occurred_on` = quando foi pago. `due_day` = dia do vencimento do recorrente. **São coisas
  diferentes, não confunda.**
- `pending` = previsto (ainda não aconteceu) vs realizado. `sum` mostra as duas linhas
  separadas — **nunca some previsão com fato num número só.**
- `saldo` é retrato do que existe na conta, não lançamento.
- `fatura` é evento de **caixa**. As compras já estão em `tx` pela data da compra, então
  **nunca lance a fatura em `tx`** — dobraria a despesa. Só a projeção de saldo soma as duas
  tabelas. Pagamento de fatura é transferência, não gasto.
- `series` é a chave estável do recorrente. A descrição muda todo mês ("Geladeira parcela 19/36")
  e a categoria agrupa demais (`assinaturas` tem vários), então `due`/`roll` usam
  `COALESCE(series, category)`. **Todo recorrente novo precisa de `--series`.**
- Recorrente cujo `method` bate com um `fatura.cartao` **não é boleto a pagar**: a cobrança
  chega na fatura e entra item a item na importação. O `due` mostra `fatura <cartao>` e o
  `roll` pula. Criar previsto duplicaria o gasto.

## Comandos

```
node fin.mjs add <valor> <categoria> [descrição]   # --date 05/08|hoje|-2  --kind income  --method pix  --recurring  --due 7  --series x  --notes ".."
node fin.mjs add --json '[{"amount":..,"category":"..","date":".."}]'   # lote
node fin.mjs list        # --month 2026-08|-1  --from --to  --cat x  --kind  --search termo  --limit 30
node fin.mjs sum         # --month|--year 2026|--all   --by category|method|kind|month
node fin.mjs edit <id>   # --amount --cat --desc --date --kind --method --notes --recurring --due --series
node fin.mjs del <id> [id...]
node fin.mjs roll        # materializa recorrentes do mês como previstos  [--month] [--dry]
node fin.mjs ok <id>     # previsto -> realizado  [--date] [--amount]
node fin.mjs pend        # o que está previsto e não confirmou
node fin.mjs due         # recorrentes: PENDENTE | PREVISTO | lançado | fatura <cartao>
node fin.mjs saldo       # saldo <valor> registra | sem args mostra atual + projeção
node fin.mjs fatura      # fatura <cartao> <valor> --venc <data> [--pago] | fatura pago <cartao> <data>
node fin.mjs budget      # status do mês | budget set <cat> <valor> | budget del <id>
node fin.mjs cats
node fin.mjs q "SELECT ..."   # consulta ad-hoc, read-only
```

Qualquer comando aceita `--json` (sozinho) para saída JSON. Valores aceitam `35,90`,
`1.200,50`, `R$ 1200`. Categorias são texto livre em minúsculas.

`node fin.mjs init` **apaga tudo** e recria o schema — só rodar se pedido explicitamente.

## Convenções de uso

- Vários gastos de uma vez: use `add --json` numa chamada só.
- Antes de deletar ou editar, confirme o id com `list --search`.
- Para relatório ou análise, prefira `sum` e `q` a puxar a lista inteira.
- `--notes null` / `--desc null` limpam o campo (viram NULL, não a string "null").
- Recorrentes: sempre `--recurring --due <dia> --series <chave>`.
- Recorrente cobrado no cartão precisa do `--method <cartao>` certo — é isso que faz
  `due`/`roll` tratarem como fatura em vez de boleto.
- Descrição de recorrente não pode ter mês nem referência fixa ("aluguel de agosto"): o `roll`
  copia a descrição para o mês seguinte. Detalhe do mês vai em `notes`.
- Só marque `--recurring` o que o usuário confirmou ser mensal. Valor que varia por uso
  (combustível, cloud, IOF) não é recorrente, mesmo aparecendo todo mês.

## Importar fatura

```bash
pdftotext -upw <senha> -layout fatura.pdf fatura.txt
node parse-fatura.mjs fatura.txt --layout caixa --card caixa --venc 2026-08-11 --dry   # confere
node parse-fatura.mjs fatura.txt --layout caixa --card caixa --venc 2026-08-11 > lote.json
node fin.mjs add --json "$(cat lote.json)"
```

`--layout` é o banco que imprimiu (`santander` | `porto` | `caixa`); `--card` é o `method`
no banco de dados. São coisas diferentes: dois cartões Porto = dois `--card`, um `--layout`.

**Sempre confira o total do parser contra o total de compras impresso na fatura antes de
importar.** Santander: "Total de Despesas". Caixa: "Total final" de cada cartão. Porto: soma
dos "Lançamentos no cartão" com o "Total lançamentos internacionais". **Não confira contra o
valor da capa** — ele vem líquido de estorno, desconto e saldo anterior, e o parser importa
só despesa; a diferença é a linha `créditos ignorados`.

Não há detecção automática de layout e **não invente uma**: o layout errado não falha, devolve
resultado parcial que parece certo. Se o usuário não disser o banco, pergunte. Banco fora
dessa lista precisa de um layout novo em `lib/fatura.mjs` (com fixture e total conferido em
`test/`) — não force um layout existente.

## Ao mexer no código

- Lógica pura vai para `lib/`, não para dentro de um comando — é o que a torna testável.
  `npm test` roda sem banco.
- Data de lançamento é calendário local: use `isoLocal()`, nunca `toISOString()`.
- SQL de escrita sempre parametrizado (`$1`). Interpolação só com allowlist.
- O painel segue a skill `dataviz`: categoria nominal usa **uma cor só** (nunca rampa por
  valor), 2 séries exigem legenda, rótulo direto só no mês corrente.
- O painel avisa sozinho quando o mês está incompleto (compara a última compra de cartão com
  hoje) — **não remova esse aviso**: sem ele o mês corrente parece bom só porque falta fatura.
