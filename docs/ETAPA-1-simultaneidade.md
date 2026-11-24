# Etapa 1: vários usuários ao mesmo tempo, sem sobrescrever

## Problema encontrado
O site gravava o **documento inteiro** (ex.: todas as vendas do mês). Quem gravava por último apagava o que outra
pessoa tinha acabado de salvar. O número da venda era calculado no navegador, então dois caixas podiam repetir o mesmo.

## Como funciona agora
1. **Gravação por diferença.** O navegador compara o documento com a base que conhecia e envia só os registros que
   mudaram: "o registro X era assim e agora é assim" (`public/docdiff.js`, o mesmo código no servidor e no navegador).
2. **Conferência no servidor, em transação.** `POST /api/col/loja/_batch` trava os documentos (`SELECT … FOR UPDATE`, em
   ordem fixa, sem deadlock) e aplica cada mudança só se o registro ainda estiver como o navegador o conhecia.
   Registros diferentes somam; o **mesmo** registro alterado por outra pessoa gera conflito (HTTP 409).
3. **Lote atômico.** Todos os documentos de uma ação (ex.: venda + lançamento do fiado) entram juntos ou nenhum entra.
4. **Numeração no servidor.** Tabela `app_counters` (venda, compra): o número definitivo é dado dentro da mesma
   transação, sem repetição e sem buracos. Um lote recusado não consome número. A tela mostra o número definitivo
   (inclusive no lançamento do fiado, que cita "Venda nº N").
5. **Reenvio seguro.** Se a internet cair e o navegador reenviar o mesmo pedido, nada duplica e o número é o mesmo.
6. **Atualização da tela.** Dados novos que chegam enquanto há alterações não salvas são mesclados registro a registro;
   se o mesmo registro mudou nos dois lados, vale o da outra pessoa e aparece um aviso.
7. **Restaurar backup / carregar exemplo** (só administradora) mantêm os números originais e empurram o contador para cima.
8. **Compatibilidade.** O `PUT` de documento inteiro continua existindo (clientes antigos), mas passa pelas mesmas regras.
9. **Permissões (sem mudar o que cada perfil já podia).** O perfil Caixa não apaga registros também pela API nova.

## Resultados dos testes (PostgreSQL 16 local, separado da produção)
Testes de banco (`test/etapa1.test.js`): **29 verificações, todas passaram**
- 60 vendas simultâneas: números 121 a 180, únicos e contínuos; contador = 180; nenhuma venda perdida.
- 150 gravações simultâneas em registros diferentes do mesmo documento: nenhuma perdida; `rev` subiu 150 vezes.
- Mesmo registro ao mesmo tempo: um grava, o outro recebe conflito; o registro não mistura as duas versões.
- Duas edições do mesmo campo: a segunda recebe conflito (nada se perde em silêncio).
- Lote com um conflito é recusado inteiro: documento, `rev` e contador intactos.
- Reenvio do mesmo pedido: sem duplicar, mesmo número. Importação em massa mantém números; a próxima venda continua depois do maior.
Teste de navegador com 2 usuários reais (administradora + caixa), `test/e2e-simultaneo.js`: **22 verificações, todas passaram**
- 12 vendas simultâneas pela tela (6 de cada): números únicos e contínuos; as duas telas iguais ao banco; número da tela = número gravado.
- Preço alterado por uma pessoa enquanto a outra vende: as duas coisas gravadas; a outra tela vê o novo preço.
- Mesmo lançamento baixado ao mesmo tempo: o banco guarda uma só versão; as duas telas terminam iguais.
- Caixa recebe 403 ao gravar compras, apagar por lote e apagar por PUT antigo. Recarregar a página mantém tudo.
- Venda fiado feita junto com vendas da outra pessoa: o lançamento cita o número definitivo.
Regressão do PDV (`test/e2e-pdv.js`): venda dividida, espera, atalhos, cupom, tela cheia, celular: tudo passou.

## Limites conhecidos
- A tela atualiza por consulta a cada 4 s: outra pessoa pode levar até ~4 s para ver uma venda nova.
- Conflito no mesmo registro: a segunda pessoa vê um aviso, a tela é atualizada e ela refaz a alteração.
- Excluir registros que outra pessoa alterou antes também gera conflito (de propósito).
- O estoque é calculado a partir de vendas e movimentos; duas vendas simultâneas do último item podem deixar o saldo negativo
  (não há trava de estoque no servidor; isso será tratado junto com as permissões).
