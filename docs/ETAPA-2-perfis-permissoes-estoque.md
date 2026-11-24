# Etapa 2: perfis, permissões, validação no servidor e proteção de estoque

Estado: **desenvolvida e testada localmente. Não foi publicada em produção** (aguarda aprovação). Branch `etapa-2`.

## 1. O que mudou

### Perfis e permissões
- Catálogo de 48 permissões (`lib/perms.js`), agrupadas em telas, caixa/vendas, produtos/estoque, compras, financeiro, aprovações e administração.
- 6 perfis novos (editáveis na tela *Usuários e perfis*) e 2 perfis de transição, que **mantêm as permissões de antes**: *Gerente (atual)* e *Caixa (atual)*.
- Permissão efetiva = perfil + permissões concedidas ao usuário − permissões negadas ao usuário. O administrador cria perfis novos e personaliza cada pessoa.
- `produtos.ver_custo` e `produtos.ver_margem` são separadas, como pedido.
- Nenhuma permissão extra foi concedida automaticamente: os perfis atuais não recebem aprovação, solicitação de pagamento, conferência de estoque nem auditoria.

| Perfil | Resumo do que pode |
|---|---|
| Administrador | tudo |
| Financeiro | financeiro completo (lançar, baixar, editar, excluir, solicitar pagamento), ver vendas, compras, fornecedores, análise, custo e margem; edita compras e fornecedores; não vende no PDV |
| Caixa/Vendas | PDV, vendas, clientes, fiado e recebimentos, abrir/fechar caixa, sangria, desconto; vê produtos sem custo |
| Estoque | produtos (sem custo), entradas e saídas, notas fiscais, receber compras; não vê custo, vendas nem financeiro |
| Compras | compras, fornecedores, notas, estoque, custo de aquisição; não vê margem nem vendas |
| Consulta/Gerência | vê todos os módulos (inclusive financeiro, fluxo de caixa, custo e margem); não grava nada, a menos que o administrador conceda |
| Gerente (atual) | exatamente o que o Gerente fazia (menos usuários/backup/apagar dados) |
| Caixa (atual) | mesmas telas e ações do Caixa/Vendas |

### Validação no servidor
- **Escrita:** todo lote passa por `checkWrite` (mapa documento + tipo de mudança → permissão), dentro da transação. O que não está no mapa é negado (documento desconhecido: só administrador). Vale para o lote, para o PUT antigo de documento inteiro e para o DELETE de mês.
- **Leitura:** `GET` devolve cada documento filtrado por permissão: documento inteiro, seção do cadastro, linhas (lançamentos) e campos (custo do produto, custo nas vendas, compras e notas, saldo inicial). O que o perfil não enxerga não sai do servidor, inclusive por chamada direta à API ou pelo backup, que copia só o que a tela recebeu.
- Quem não lê movimentos, compras e vendas recebe o **saldo de estoque pronto do servidor** (`cadastros.saldos`), para o PDV continuar funcionando.
- Campos escondidos não se perdem: se o Estoque edita um produto, o servidor devolve o custo ao registro; se o Caixa vende, o servidor grava o custo real do produto na venda.
- Último administrador: o sistema recusa tirar ou desativar a última pessoa com `usuarios.gerir`. Mudar perfil ou permissões de alguém encerra a sessão dela.
- Interruptor de segurança: `RBAC_V2=off` volta ao comportamento da Etapa 1 sem alterar dados.

### Proteção de estoque
- Dentro da transação: trava por produto (`pg_advisory_xact_lock`, em ordem), cálculo do saldo antes e depois do lote e comparação. Bloqueia o que **consome** e deixa o saldo abaixo de zero. Cobre vendas (novas e alteradas), saídas, perdas, ajustes, exclusão de entradas, compra recebida excluída e nota excluída. Devoluções e entradas só aumentam o saldo e nunca são barradas; excluir ou diminuir uma venda também não.
- **Modo de aviso por 7 dias** (padrão após a migração): nada é bloqueado; cada caso que seria bloqueado vai para `app_stock_log`. A administradora acompanha na tela *Conferência de estoque* (também em CSV) e só liga o bloqueio depois de marcar que conferiu os saldos. O sistema não liga o bloqueio sozinho depois dos 7 dias.
- **Exceção:** no PDV, ao finalizar uma venda acima do saldo, abre-se a autorização: usuário e senha de um administrador (com a permissão `estoque.excecao`) e justificativa. O servidor emite uma autorização de uso único, válida 10 minutos e só para quem pediu. O registro guarda quem pediu, quem autorizou, a justificativa, o produto, o saldo e a quantidade.
- `app_stock_log` é somente de inclusão (um gatilho do banco recusa UPDATE e DELETE).

### Telas
- Menu e telas conforme a permissão; custo e margem somem dos produtos e das compras para quem não pode ver.
- *Usuários e perfis*: perfil por pessoa, permissões individuais (marcar/desmarcar), edição de perfis, perfil novo a partir de outro.
- *Conferência de estoque* (`/estoque-conferencia`): saldos, divergências, produtos que seriam bloqueados, avisos e exceções, modo de proteção.
- Se o servidor recusar uma gravação por permissão, a tela avisa e recarrega os dados salvos, em vez de manter uma alteração que não foi gravada.

### Banco (migração 002, só acrescenta)
`app_roles`, `app_settings`, `app_stock_log`, colunas `role_id`, `perm_grant`, `perm_deny` em `app_users`. Cada usuário recebe o perfil equivalente ao papel que já tinha. A coluna `role` continua sendo mantida (perfis novos gravam o papel mais restrito) para o rollback.

## 2. Testes executados

Todos em PostgreSQL local separado da produção, mais um ensaio da migração na cópia dos dados reais.

| Teste | Resultado |
|---|---|
| `test/etapa1.test.js` (banco: migrações, numeração, conflitos, atomicidade) | 29 de 29 |
| `test/etapa2.test.js` (API HTTP: 8 perfis, leitura filtrada, matriz de escrita, permissões individuais, estoque aviso/bloqueio/exceção, corrida, paridade da fórmula, migração, `RBAC_V2=off`) | 102 de 102 |
| `test/e2e-perfis.js` (navegador: menus, custo escondido, saldo do servidor, exceção no PDV, páginas administrativas) | 21 de 21 |
| `test/e2e-simultaneo.js` (2 usuários simultâneos, regressão da Etapa 1) | 22 de 22 |
| `test/e2e-pdv.js` (regressão do PDV) | 17 de 17, sem erros de página |
| `test/rollback.test.js` (código da Etapa 1 sobre o banco migrado) | 6 de 6 |
| Ensaio da migração 002 na cópia dos dados reais (`rose_stage`) | aplicou; dados idênticos (mesmo hash da produção); usuário mapeado para Administrador; nada criado em `rose` nem `public` |

Pontos que os testes comprovam:
- A corrida de 18 pedidos de 1 unidade (12 vendas de um usuário e 6 saídas de outro, em documentos diferentes) para um saldo de 6: passaram exatamente 6, saldo final 0.
- A fórmula do servidor dá o mesmo saldo da tela em 200 casos aleatórios.
- Nenhum perfil sem permissão obtém custo, lançamentos, compras ou fornecedores pela API; documentos desconhecidos só o administrador altera.
- A autorização de exceção não funciona com senha errada, sem justificativa, para quem não é administrador, mais de uma vez ou por outro usuário.

Dois defeitos meus apareceram nos testes e foram corrigidos antes deste relatório: um impasse quando várias gravações recusadas pediam uma segunda conexão ao banco ao mesmo tempo, e a perda do custo ao receber compra por perfil que não vê custo.

### Prévia com os dados reais (cópia, somente leitura)
Nenhum produto com saldo negativo. Três com saldo **zero**, que o bloqueio impediria de vender até haver entrada registrada: Suco de uva integral 1 L (BEB003), Papel higiênico 12 rolos (HIG001) e Arroz tipo 1 5 kg (MER002), cada um com entradas iguais às vendas. Os saldos reais serão conferidos no relatório durante o aviso.

## 3. Rollback

| Situação | O que fazer |
|---|---|
| Regras novas causando problema | definir `RBAC_V2=off` no Render e reiniciar: volta às regras da Etapa 1, com os dados intactos |
| Bloqueio de estoque atrapalhando | na tela *Conferência de estoque*, mudar para "Só avisar" ou "Desligar" (sem novo deploy) |
| Voltar o código | no Render, voltar ao deploy anterior (commit `29aaaf1`). Testado: esse código funciona no banco já migrado; perfis novos caem no papel Caixa |
| Voltar os dados | restaurar o esquema de backup tirado imediatamente antes do deploy (o `rose_bk_20261123` é o de hoje). A migração só acrescenta, então não é necessário desfazê-la |

## 4. Limitações e pendências

- **Margem unitária:** quem vê custo e preço de um produto (Compras) consegue calcular a margem dele à mão. `ver_margem` esconde a margem nas telas e o custo gravado nas vendas; a margem geral fica protegida porque esses perfis não leem vendas. Esconder também o preço exigiria outra regra.
- **Botões:** perfis sem permissão ainda enxergam alguns botões de criar ou alterar. O servidor recusa, a tela avisa e recarrega. Esconder todos os botões fica para um refinamento.
- **Valores zerados:** onde o custo não é visível (importar nota, formulário de compra do Estoque), a tela pode mostrar R$ 0,00. Os dados corretos continuam no servidor.
- **Exceção só no PDV:** venda manual, entradas e saídas bloqueadas pelo servidor mostram o aviso, mas a autorização do administrador só existe ao finalizar no PDV. Nas outras telas a saída é ajustar o estoque.
- **Saldo no PDV:** para quem recebe o saldo pronto do servidor, ele se atualiza na sincronização da tela (cerca de 4 s), não no instante da própria venda.
- **Desempenho:** cada gravação que mexe em estoque lê os documentos de estoque (hoje cerca de 460 KB). Não foi medido em volume maior; se a loja crescer, o saldo passa a ficar em tabela própria.
- **Trilha de estoque:** `app_stock_log` é provisória. A auditoria geral (usuário, data, hora, operação) é a Etapa 3 e vai absorvê-la.
- **Aprovações (Etapa 4):** as permissões `aprovacao.*` e `financeiro.solicitar_pagamento` existem no catálogo, mas **o fluxo e os limites (R$ 500, 15%, R$ 300) não foram implementados**. Hoje o desconto no PDV exige só `caixa.desconto`, sem teto.
- **Produção:** esta etapa não foi publicada. Falta o teste de uso no site publicado (venda de teste, acesso por outro aparelho) e o backup externo que o usuário vai guardar.

## 5. Ordem prevista para publicar (após aprovação)
1. Novo backup do esquema `rose` e conferência por hash.
2. Merge do branch `etapa-2` e deploy manual.
3. Conferir nos logs: migração 002 aplicada, perfis semeados, dados com o mesmo hash.
4. Entrar com cada perfil e testar leitura e escrita; manter a proteção de estoque em modo de aviso por 7 dias.
5. Revisar o relatório de conferência, corrigir saldos e só então ligar o bloqueio.
