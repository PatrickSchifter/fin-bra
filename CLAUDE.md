# fin-bra

CLI de finanças pessoais sobre Postgres. Toda escrita passa pelo `node fin.mjs` —
**não escreva SQL de escrita direto, não crie scripts novos.**

Este arquivo é a instrução para agentes (Claude Code e afins). Se você é humano, o
[README.md](README.md) é mais útil.

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
node parse-fatura.mjs fatura.txt --card santander --venc 2026-08-12 --dry   # confere
node parse-fatura.mjs fatura.txt --card santander --venc 2026-08-12 > lote.json
node fin.mjs add --json "$(cat lote.json)"
```

**Sempre confira o total do parser contra o "Total Despesas" impresso na fatura antes de
importar.** O regex é do layout Santander (2 colunas); outros bancos precisam ser lançados à
mão ou ganhar um parser.

## Ao mexer no código

- Lógica pura vai para `lib/`, não para dentro de um comando — é o que a torna testável.
  `npm test` roda sem banco.
- Data de lançamento é calendário local: use `isoLocal()`, nunca `toISOString()`.
- SQL de escrita sempre parametrizado (`$1`). Interpolação só com allowlist.
- O painel segue a skill `dataviz`: categoria nominal usa **uma cor só** (nunca rampa por
  valor), 2 séries exigem legenda, rótulo direto só no mês corrente.
- O painel avisa sozinho quando o mês está incompleto (compara a última compra de cartão com
  hoje) — **não remova esse aviso**: sem ele o mês corrente parece bom só porque falta fatura.
