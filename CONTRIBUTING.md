# Contribuindo

Obrigado. Este é um projeto pequeno e quer continuar pequeno — leia a seção "escopo" antes
de investir tempo numa ideia grande.

## Rodando

```bash
npm install
cp .env.example .env
docker run --name fin-pg -e POSTGRES_PASSWORD=senha -p 5432:5432 -d postgres
node fin.mjs init
npm test
```

Os testes não precisam de banco: tudo que é lógica pura mora em `lib/` (`helpers.mjs`,
`fatura.mjs`, `db.mjs`) e é testado com o `node --test`, sem framework. Se você for mexer em
algo que hoje só existe dentro de um comando do `fin.mjs`, extraia para `lib/` primeiro — é
o que torna possível testar.

## O jeito mais útil de ajudar: um parser de fatura novo

O `parse-fatura.mjs` hoje entende Santander, Porto e Caixa. Todo banco imprime diferente, e
ninguém tem fatura de todos os bancos — por isso essa é a contribuição que mais rende.

1. `pdftotext -layout` na sua fatura para ver o formato.
2. Adicione a função em `lib/fatura.mjs` e registre em `LAYOUTS`. Ela recebe o texto e devolve
   lançamentos crus (`{desc, data, parcela, amount}`); data, parcela e categoria são resolvidas
   depois, iguais para todos os bancos. **Crédito sai com valor negativo, não filtrado** — é
   isso que separa desconto e pagamento de despesa, e o que aparece no `créditos ignorados`.
3. Prenda a leitura às seções de lançamento se a fatura tiver simulação de parcelamento,
   limite ou encargo soltos na página. Os layouts `porto` e `caixa` fazem isso; sem essa
   trava, "18x de R$ 155,00" da simulação de parcelamento vira compra.
4. **Anonimize uma fatura** e coloque em `test/fixtures/`: troque nomes de estabelecimento,
   valores e os 4 últimos dígitos do cartão por dados inventados. Mantenha o *espaçamento*
   original, que é o que o regex usa.
5. Escreva o teste em `test/fatura.test.mjs`. O caso que não pode faltar: **o total dos itens
   bate com o total de compras impresso na fatura** (o de cada cartão, não o valor da capa,
   que vem líquido de estorno e saldo anterior). É a conferência que evita importar torto.

O erro que esses testes existem para pegar não é o parser que falha — é o que acerta pela
metade. A fatura da Caixa lida com o regex do Santander devolvia um único item, que era o
pagamento da fatura anterior — um crédito virando despesa, a centavos do total impresso.
Por isso não há detecção automática de layout: ela transformaria esse erro em silêncio.

Nunca abra PR com fatura de verdade. Se acontecer, avise — o histórico precisa ser reescrito,
não basta apagar o arquivo num commit novo.

## Regras que o código segue

Elas não são estilo, são o que impede o número de sair errado:

- **Fatura de cartão nunca vira lançamento em `tx`.** As compras já estão lá pela data da
  compra. A fatura é evento de caixa e mora na tabela `fatura`. Lançar as duas dobra a despesa.
- **Previsto (`pending`) e realizado nunca somam num número só.** Se você adicionar um
  relatório, mostre as duas linhas separadas.
- **Data de lançamento é calendário local, não UTC.** Use `isoLocal()` de `lib/helpers.mjs`.
  `toISOString()` faz "hoje" às 22h no Brasil virar amanhã, e o fim do mês voltar um dia em
  fusos a leste de Greenwich. Existe teste de regressão para isso em cinco fusos.
- **SQL de escrita só via comandos do `fin.mjs`,** sempre com parâmetro (`$1`), nunca
  interpolando string. Onde a interpolação é inevitável (nome de coluna no `sum --by`), use
  allowlist.
- **`series` é a chave do recorrente**, não a descrição nem a categoria. A descrição muda todo
  mês e a categoria agrupa demais.

## Escopo

O projeto é um CLI de finanças pessoais com um painel de leitura. Fica de fora:

- integração com Open Finance / API de banco (muda o projeto de natureza: some o "seus dados
  não saem daqui", que é metade da razão dele existir);
- multiusuário, autenticação, deploy hospedado;
- app mobile, framework de front, build step.

Melhorias de parser, de categorização, de relatório, de teste e de documentação: manda.

## Pull requests

- Um assunto por PR.
- `npm test` passando.
- Se mudou comportamento, atualize o `README.md` junto.
- Mensagem de commit no imperativo, em português ou inglês, tanto faz.

## Idioma

O CLI, os comentários e a documentação são em português. Isso é uma escolha: o projeto é
específico do jeito brasileiro de gastar (fatura, parcela, pix, boleto) e traduzir só o
esqueleto deixaria os dois idiomas piores. O README abre com um parágrafo em inglês para quem
chega de fora entender o escopo e seguir a vida.
