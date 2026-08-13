# fin-bra

> Personal-finance CLI for Brazil, **designed to be driven by a terminal AI agent**
> (Claude Code, Codex, Aider…): compact output, `--json` everywhere, and a `CLAUDE.md` that
> teaches the agent the domain rules. Credit-card statements imported line by line,
> `parcelas`, recurring bills, cash-flow projection. Postgres, no build step, one dependency.
> **Docs and CLI are in Portuguese.**

CLI de finanças pessoais que não tenta ser um app de banco. Você lança no terminal, o dado
mora num Postgres **seu**, e nada sai da sua máquina.

```
$ fin add 35,90 mercado pão e leite
id  kind     amount  category  description    date
--  -------  ------  --------  -------------  ----------
41  expense  35.90   mercado   pão e leite    2026-08-13

$ fin saldo
conta       amount   data
----------  -------  ----------
principal   2840.15  2026-08-12

saldo        2840.15
+ entradas    500.00   previstas até o fim do mês
− saídas      612.30   previstas até o fim do mês
− faturas    1180.44   cartões a vencer
= projeção   1547.41
```

## Feito para você conversar com uma IA, não para decorar flag

Este é o jeito principal de usar. Você não precisa saber que existe `--series` nem lembrar que
parcela usa a data do vencimento — abra um agente de terminal na pasta do projeto e fale:

> **você:** paguei 35,90 no mercado e 48 no ifood ontem
> **agente:** `fin add --json '[{"amount":35.90,"category":"mercado",…},{"amount":48,…}]'`

> **você:** dá pra pagar o notebook de 3 mil esse mês?
> **agente:** `fin saldo` → projeção 1.547,41 no fim do mês. Não dá sem atrasar algo.

> **você:** onde meu dinheiro foi em agosto?
> **agente:** `fin sum --by category --month 2026-08`

Não é acidente que funcione bem — o CLI foi construído para isso:

- **`CLAUDE.md` vem no repositório.** O agente lê e já sabe as regras do domínio: que fatura
  de cartão nunca vira lançamento, que previsto e realizado não somam, que recorrente precisa
  de `--series`. São exatamente os erros que ele cometeria sozinho, e que fazem o número sair
  errado sem ninguém perceber. Funciona com qualquer agente que leia instruções de projeto.
- **A saída é curta de propósito.** O mês inteiro em `sum` custa ~1 KB; `saldo` custa menos de
  300 bytes. Despejar os lançamentos crus de um ano custaria dezenas de KB — o contexto do
  agente acaba e ele começa a errar. Por isso os comandos já devolvem o **agregado**, não a
  lista.
- **`--json` em todo comando**, para o agente encadear sem parsear tabela.
- **`add --json` em lote:** "gastei isso, isso e aquilo" vira uma chamada só, não cinco.
- **`q "SELECT ..."` é read-only** e recusa qualquer coisa que não seja `SELECT`/`WITH`. O
  agente tem liberdade de fazer a pergunta que quiser sem poder estragar o seu dado.
- **`.claude/settings.json` já vem com uma allowlist:** consulta e `add` rodam sem ficar
  pedindo permissão a cada passo; `del`, `edit` e `init` ficam de fora **de propósito** — são
  os que reescrevem histórico em silêncio, e você quer ser perguntado.

Nada disso impede o uso na mão: os comandos abaixo funcionam iguais digitados por você.

## Por que não lançar "Nubank 3.200" e pronto

Porque aí você não sabe onde o dinheiro foi. O ponto do `fin-bra` é o oposto: a fatura entra
**item a item**, cada compra com sua categoria e sua data real. É assim que aparece que o
delivery virou o terceiro maior gasto do mês.

Três decisões que vêm daí e que explicam o resto do sistema:

- **Compra à vista usa a data da compra; parcela usa o vencimento da fatura.** Uma fatura cai
  em dois meses no banco. É de propósito: mostra quando você gastou, não quando o banco cobrou.
- **A fatura nunca vira lançamento.** As compras já estão lá. A fatura é evento de *caixa* e
  mora na tabela própria; lançá-la de novo dobraria a despesa. Pagar a fatura é transferência,
  não gasto.
- **Previsto e realizado nunca somam num número só.** `sum` mostra as duas linhas separadas.
  Previsão que se disfarça de fato é como se erra o mês inteiro.

## Instalação

Precisa de Node 20+ e um Postgres.

```bash
git clone https://github.com/PatrickSchifter/fin-bra.git
cd fin-bra
npm install
cp .env.example .env      # coloque sua DATABASE_URL
node fin.mjs init         # cria o schema  (ATENÇÃO: apaga tudo que existir)
node fin.mjs add 35,90 mercado pão
```

Postgres local em um comando:

```bash
docker run --name fin-pg -e POSTGRES_PASSWORD=senha -p 5432:5432 -d postgres
# DATABASE_URL=postgres://postgres:senha@localhost:5432/postgres
```

Serve qualquer Postgres gerenciado (Neon, Supabase, RDS). SSL liga sozinho para host remoto
e desliga para `localhost` — não precisa configurar.

### Configuração: o `.env`

Só a primeira linha é obrigatória. O resto tem default e só existe para quando o default não
serve. Qualquer uma delas também funciona como variável de ambiente
(`PORT=8080 node painel.mjs`), que tem precedência sobre o arquivo.

```bash
# obrigatório — string de conexão do seu Postgres
DATABASE_URL=postgres://usuario:senha@host:5432/banco
```

| Variável | Default | Para que serve |
|---|---|---|
| `DATABASE_URL` | — | **Obrigatória.** Onde o dado mora. O CLI a procura no ambiente e, se não achar, no `.env` da pasta do projeto. |
| `DATABASE_SSL` | decidido pelo host | Força a decisão de TLS: `disable`, `no-verify` ou `require`. Só precisa se o palpite automático errar (ex.: Postgres remoto com certificado self-signed → `no-verify`). |
| `PORT` | `4173` | Porta do painel. |
| `HOST` | `127.0.0.1` | Interface do painel. **Só mude sabendo que o painel não tem autenticação** — em `0.0.0.0` qualquer um na sua rede lê seu extrato inteiro. |
| `CONTA_METHOD` | `conta` | Qual `method` você usa para movimento de conta corrente (o seu pode ser `nubank-conta`, `itau-conta`…). O painel usa isso para separar movimento de conta de compra no cartão ao avisar que o mês está incompleto. Se estiver errado, o aviso erra. |

O `.env` **nunca é versionado** — já está no `.gitignore`, junto com `faturas/`, PDFs, CSVs,
OFX e `ESTADO.md`. Veja [`.env.example`](.env.example) para copiar e preencher.

Sem `DATABASE_URL` o CLI não adivinha nada: falha na hora dizendo o que fazer (e `fin help`
continua funcionando, para você não ficar sem saída).

```
$ fin saldo
erro: DATABASE_URL não definida.

  cp .env.example .env    # e coloque a string de conexão do seu Postgres

Postgres local:  postgres://user:senha@localhost:5432/fin
Neon / Supabase: pegue a connection string no painel do serviço
```

Para chamar de `fin` em vez de `node fin.mjs`:

```bash
npm link      # ou: npm install -g .
fin saldo
```

### Usando com um agente

Não tem passo de configuração: abra seu agente de terminal **dentro da pasta do projeto** e
comece a falar. Ele lê o [`CLAUDE.md`](CLAUDE.md) sozinho e já sabe operar o CLI.

```bash
cd fin-bra
claude          # ou codex, aider, opencode...
```

Se o seu agente lê um arquivo de instruções com outro nome (`AGENTS.md`, `.cursorrules`,
`GEMINI.md`), aponte para o mesmo conteúdo:

```bash
ln -s CLAUDE.md AGENTS.md
```

Vale manter um `ESTADO.md` **fora do git** com o que o banco não guarda: quem é quem nos seus
lançamentos, o que já foi decidido, o que não perguntar de novo. O agente lê junto e para de
repetir pergunta. Não versione — é o arquivo mais pessoal que você vai ter aqui.

## Comandos

```
fin add <valor> <categoria> [descrição]   # --date 05/08|hoje|-2  --kind income  --method pix
                                          # --recurring --due 7 --series vivo  --notes ".."
fin add --json '[{"amount":..,"category":"..","date":".."}]'   # lote
fin list        # --month 2026-08|-1  --from --to  --cat x  --kind  --search termo  --limit 30
fin sum         # --month|--year 2026|--all   --by category|method|kind|month
fin edit <id>   # --amount --cat --desc --date --kind --method --notes --recurring --due --series
fin del <id> [id...]
fin roll        # materializa os recorrentes do mês como previstos  [--month] [--dry]
fin ok <id>     # previsto -> realizado  [--date] [--amount]
fin pend        # o que está previsto e não confirmou
fin due         # recorrentes do mês: PENDENTE | PREVISTO | lançado | fatura <cartao>
fin saldo       # saldo <valor> registra | sem args mostra atual + projeção
fin fatura      # fatura <cartao> <valor> --venc <data> [--pago] | fatura pago <cartao> <data>
fin cats
fin budget      # status do mês | budget set <cat> <valor> | budget del <id>
fin q "SELECT ..."   # consulta ad-hoc, read-only
```

Qualquer comando aceita `--json`. Valores aceitam `35,90`, `1.200,50`, `R$ 1200`.
Categorias são texto livre em minúsculas — não existe lista fixa.

### Recorrentes

Todo recorrente precisa de `--series`, uma chave estável:

```bash
fin add 99,90 internet "Fibra 600MB" --recurring --due 15 --series vivo
```

A descrição muda todo mês ("Geladeira parcela 19/36") e a categoria agrupa demais (`assinaturas`
tem vários), então é a `series` que identifica. Sem ela, `due` e `roll` erram.

No começo do mês, `fin roll` cria os previstos (é idempotente: pula o que já existe e para
quando as parcelas acabam). Quando o dinheiro sai de verdade, `fin ok <id>`.

Recorrente cobrado no cartão leva `--method <nome-do-cartao>`. Aí o `roll` pula ele: a cobrança
vai chegar na fatura e entrar item a item na importação. Criar previsto duplicaria.

## Importar fatura de cartão

```bash
pdftotext -upw <senha> -layout fatura.pdf fatura.txt
node parse-fatura.mjs fatura.txt --layout santander --card santander --venc 2026-08-12 --dry
node parse-fatura.mjs fatura.txt --layout santander --card santander --venc 2026-08-12 > lote.json
fin add --json "$(cat lote.json)"
fin fatura santander 1180,44 --venc 2026-08-12      # o total, para a projeção de caixa
```

`--layout` é o banco que imprimiu o PDF; `--card` é o nome do `method` no seu banco de dados.
Costumam coincidir, mas são coisas diferentes — dois cartões Porto são dois `--card` com o
mesmo `--layout`.

| `--layout` | Como a fatura é lida |
|---|---|
| `santander` | duas colunas, `DD/MM DESCRIÇÃO [PP/NN] VALOR`. É o default. |
| `porto` | uma seção por cartão mais a de internacionais; caixa mista e duas colunas de valor (US$ e R$, vale a segunda). |
| `caixa` | colunas espalhadas pela página, parcela escrita `12 DE 12`, sinal no sufixo `D`/`C`. |

**Sempre compare o total do `--dry` com o total de compras impresso na fatura antes de
importar.** Se não bater, o regex não pegou tudo. Onde olhar muda por banco: no Santander é
o "Total de Despesas"; na Caixa, o "Total final" de cada cartão; na Porto, a soma dos
"Lançamentos no cartão" com o "Total lançamentos internacionais".

Não use o valor grande da capa para essa conferência. Ele já vem líquido de estorno,
desconto e saldo anterior, e o parser importa só as despesas — a diferença é justamente o
que ele te mostra na linha `créditos ignorados`.

**Não existe detecção automática de layout, de propósito.** Rodar o banco errado não dá
erro: dá um resultado parcial que parece certo. Lida com o parser do Santander, uma fatura
real da Caixa devolvia um único item — que era o *pagamento da fatura anterior*, um crédito
lido como despesa, a centavos do total impresso. Passaria por uma
conferência apressada. Por isso o layout é explícito, o crédito é contado à parte em vez de
sumir calado, e nenhum lançamento encontrado é erro, não lista vazia.

Seu banco não está na tabela? [Contribuições são bem-vindas](CONTRIBUTING.md) — é o lugar
mais útil para ajudar. Um layout novo é uma função em `lib/fatura.mjs` e uma fixture em
`test/fixtures/`, com o total conferido contra o impresso; `npm test` roda sem banco.

A categorização automática é um chute pelo nome do estabelecimento, para você não categorizar
80 itens na mão: confira e corrija o que errar.

## Painel

```bash
node painel.mjs     # http://127.0.0.1:4173
```

Renderizado no servidor, sem build e sem CDN. `/dados.json` devolve o mesmo payload em JSON.

**Não tem autenticação** — entrega o extrato inteiro para quem abrir. Por isso escuta só em
`127.0.0.1`. Se mudar o `HOST`, ponha algo com senha na frente.

O painel avisa quando o mês está incompleto, comparando a última compra de cartão com hoje.
Sem esse aviso o mês corrente sempre parece bom — só falta a fatura chegar.

## Privacidade

Não tem servidor, telemetria nem conta. O banco é seu. O `.gitignore` já bloqueia `.env`,
`faturas/`, PDFs, CSVs e OFX — **confira antes do primeiro commit se você versionar o seu fork**.

## Desenvolvimento

```bash
npm test     # node --test, sem framework e sem banco
```

As funções puras (dinheiro, data, parcela, parser de fatura) vivem em `lib/` justamente para
serem testáveis sem Postgres. Veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE)
