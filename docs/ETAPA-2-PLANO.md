# Etapa 2: planejamento técnico (perfis, permissões, módulos e validação no servidor)

Status: **proposta, nada foi alterado em produção nem no código.** Só começa depois da aprovação.

## 1. Ponto de partida (o que existe hoje)

- 3 perfis fixos no código (`ROLES` em `server.js`): `admin`, `gerente`, `caixa`. Cada um tem: abas visíveis, regex de documentos graváveis (`write`), permissão de exclusão (`del`).
- O servidor já bloqueia gravação por perfil (403), mas **não filtra leitura**: quem tem sessão recebe todos os documentos pela API, mesmo que o menu esconda a aba.
- Os usuários ficam em `app_users` (1 conta hoje). O perfil é uma coluna de texto.
- Desde a Etapa 1, toda gravação chega ao servidor como lista de operações por registro (`put`/`del`/`list`/`field`/`value` em `docdiff.js`). **Isso é o que torna a validação fina possível**: dá para saber se alguém mexeu em `clientes`, em `produtos` (custo, preço) ou em `config`.

## 2. Catálogo de permissões

Formato `modulo.acao`. Ações: `ver`, `criar`, `editar`, `excluir`, mais ações especiais.

| Módulo | Permissões |
|---|---|
| Painel | `painel.ver` |
| Caixa/PDV | `caixa.ver`, `caixa.vender`, `caixa.abrir_fechar`, `caixa.sangria`, `caixa.desconto` |
| Vendas | `vendas.ver`, `vendas.editar`, `vendas.excluir` (cancelar venda finalizada) |
| Clientes e fiado | `clientes.ver/criar/editar/excluir`, `fiado.receber` |
| Produtos | `produtos.ver`, `produtos.editar`, `produtos.excluir`, `produtos.ver_custo` (custo e margem) |
| Movimentações/estoque | `estoque.ver`, `estoque.movimentar` |
| Notas fiscais | `notas.ver/criar/editar/excluir` |
| Compras | `compras.ver/criar/editar/cancelar/excluir`, `compras.receber` |
| Fornecedores | `fornecedores.ver/editar/excluir` |
| Financeiro | `financeiro.ver`, `financeiro.lancar`, `financeiro.baixar`, `financeiro.editar`, `financeiro.excluir`, `financeiro.solicitar_pagamento` |
| Análise | `analise.ver` |
| Aprovações (Etapa 4) | `aprovacao.ver`, `aprovacao.aprovar`, `aprovacao.config` |
| Administração | `usuarios.gerir`, `backup.copiar`, `backup.restaurar`, `dados.apagar`, `auditoria.ver`, `config.editar` |

## 3. Perfis padrão (editáveis pelo administrador)

| Perfil | Pode | Não pode |
|---|---|---|
| **Administrador** | tudo, inclusive aprovar tudo | (nada) |
| **Financeiro** | ver/lançar/editar financeiro, solicitar pagamento, acompanhar aprovações, ver vendas, compras, fornecedores, análise | aprovar (por padrão), PDV, apagar dados, usuários |
| **Caixa/Vendas** | PDV, vendas, clientes e fiado, ver produtos (sem custo), abrir/fechar caixa | financeiro, compras, custo/margem, exclusão |
| **Estoque** | produtos, movimentações, notas, ver compras, receber compra | financeiro, vendas, PDV |
| **Compras** | compras, fornecedores, notas, ver produtos e estoque | baixa de pagamentos, PDV |
| **Consulta/Gerência** | ver tudo (leitura) e poder receber as permissões `aprovacao.aprovar` que o administrador escolher | gravar, a menos que o administrador conceda |

Decisões que preciso de você na seção 9 (principalmente: Estoque e Compras veem custo? Consulta vê financeiro completo?).

**Compatibilidade com o que já existe:** os perfis atuais `admin`, `gerente` e `caixa` continuam funcionando **com as mesmas permissões de hoje** (viram perfis do sistema "Administradora", "Gerente (atual)" e "Caixa (atual)"). Nenhum usuário perde ou ganha acesso na migração. O administrador depois troca cada pessoa para o perfil novo quando quiser.

## 4. Modelo de dados (migração `002`, só acrescenta)

- `app_roles(id, label, system bool, perms jsonb, created_at, updated_at)`: perfis e suas permissões. Semeada com os 6 novos + 3 atuais.
- `app_users`: novas colunas `role_id` (preenchida a partir de `role`), `perm_grant jsonb default '[]'`, `perm_deny jsonb default '[]'`. A coluna `role` antiga **não é removida** (rollback).
- Permissão efetiva = permissões do perfil + `perm_grant` − `perm_deny`. Calculada no servidor a cada requisição (nunca confiada ao navegador).
- Administrador não pode ficar sem nenhum administrador ativo (trava no servidor), nem retirar de si mesmo `usuarios.gerir`.

## 5. Validação no servidor

**Escrita.** Um classificador mapeia cada operação do lote para a permissão exigida: `(documento, op.k, tipo da operação, registro)` → permissão. Exemplos:
- `put` em `cadastros.clientes` → `clientes.criar` ou `.editar`; `del` → `clientes.excluir`.
- `put` em `cadastros.produtos` que muda `custo` → `produtos.editar` **e** `produtos.ver_custo`.
- `put` em `vendas-AAAA-MM` novo → `caixa.vender`; `del` → `vendas.excluir`.
- `put` em `lancamentos` com `status` mudando para pago → `financeiro.baixar`.
- Operação desconhecida → **negada** (negar por padrão). O lote inteiro é recusado (403) se qualquer operação não for permitida, sem gravar nada (já é transacional).
- O PUT legado de documento inteiro passa pelo mesmo classificador (já vira diff desde a Etapa 1).

**Leitura.** `GET` devolve cada documento filtrado: documento sem `ver` volta vazio com marca `negado`; `cadastros` é filtrado por seção (um Caixa recebe `produtos` sem `custo`). O menu do navegador continua escondendo abas, mas **a barreira é o servidor**. O painel inicial de cada perfil (item 6 do pedido) fica para a Etapa 5.

**Interruptor de segurança:** variável `RBAC_V2=off` volta ao comportamento atual (`ROLES` antigo) sem novo deploy de código.

## 6. Proteção de estoque na venda simultânea (incluída a seu pedido)

Problema: duas vendas do último item, feitas ao mesmo tempo por pessoas diferentes, hoje deixam o estoque negativo.

Desenho:
1. Dentro da transação do lote, para cada produto cuja saída aumenta (venda nova, aumento de quantidade em venda editada, movimentação de saída, exclusão de compra já recebida), o servidor toma um **trava por produto** (`pg_advisory_xact_lock`, em ordem de id, para não gerar deadlock).
2. Com a trava, calcula o saldo atual no próprio banco (entradas − saídas, mesma fórmula da tela) e confere se `saldo − quantidade pedida ≥ 0`.
3. Se não couber, **recusa o lote inteiro** com 409 `estoque_insuficiente` (produto, disponível, pedido). A tela do PDV avisa "só há N unidades" e a venda não é gravada.
4. A segunda venda simultânea espera a primeira terminar e então enxerga o saldo já descontado.

Cuidados:
- A fórmula do servidor precisa ser **idêntica** à da tela. Teste de paridade: calcular o saldo de todos os produtos nos dados reais pelos dois caminhos e exigir diferença zero antes de ligar a regra.
- Produtos que hoje já estão com saldo ≤ 0 por falta de lançamento de entrada passariam a **não poder ser vendidos**. Por isso proponho mostrar a lista deles antes de ativar e oferecer, por produto, a opção "não controlar estoque" ou o ajuste do saldo (movimentação de acerto). Excluir ou diminuir venda nunca é bloqueado.
- Exceção configurável: administrador pode autorizar venda acima do saldo, registrada na auditoria. Padrão: **bloqueado**.

## 7. Como as regras de aprovação se encaixam (Etapa 2 prepara, Etapa 4 implementa)

A Etapa 2 não cria aprovações, mas já define o que elas precisam:
- Permissões `aprovacao.*`, `financeiro.solicitar_pagamento`, `caixa.sangria`, `caixa.desconto`, `vendas.excluir`, e o classificador que reconhece cada operação sujeita a regra.

Regras acordadas e como serão detectadas depois (limites todos configuráveis em tabela, nada fixo no código):

| Regra | Detecção no classificador |
|---|---|
| Baixa de conta a pagar > R$ 500 | `lancamentos` mudando para pago com valor > limite |
| Alteração de valor de lançamento | `put` em `lancamentos` com `valor` diferente |
| Alteração de vencimento de lançamento já aprovado | `venc` diferente em lançamento com `aprovado=true` |
| Exclusão/cancelamento de lançamento | `del` em `lancamentos` ou status cancelado |
| Desconto no PDV > 15% | venda nova com desconto/total bruto acima do limite |
| Sangria > R$ 300 | movimento de sangria acima do limite |
| Cancelamento de venda finalizada | `del` em `vendas-*` |
| Estorno de pagamento | reversão de baixa de lançamento/venda |

Fluxo previsto: o servidor não grava a mudança, cria uma **solicitação pendente** com o lote guardado; ao ser aprovada por quem tem `aprovacao.aprovar`, o lote é aplicado em transação (e revalidado: se o registro mudou, a solicitação é marcada como desatualizada). Pagamento recorrente aprovado: autorização vinculada ao "modelo" (fornecedor, valor, periodicidade); qualquer mudança no modelo pede nova aprovação. Administrador aprovando a própria solicitação: permitido enquanto a opção estiver ligada e **sempre registrado como exceção** na auditoria.

## 8. Plano de execução, testes e rollback

Cada passo só com resultado apresentado e aprovação sua.

1. **Preparação (sem produção):** novo backup completo do banco, conferência por hash, restauração em esquema separado (mesmo procedimento da Etapa 0). Tag git `pre-etapa2`.
2. **Desenvolvimento e testes locais** (PostgreSQL de teste, nunca produção):
   - migração `002` em cópia dos dados reais: dados idênticos (hash), usuário atual com as mesmas permissões;
   - matriz perfil × operação pela API (esperado 200/403), inclusive tentativa de burlar com chamada direta, leitura filtrada e negado por padrão;
   - estoque: 60 vendas simultâneas do último item (só 1 passa), paridade da fórmula nos dados reais, produtos negativos listados;
   - navegador: cada perfil vê só os seus módulos; regressão completa das Etapas 0 e 1 (29 + 22 testes) e do PDV.
3. **Relatório para você** com resultados e documento `docs/ETAPA-2-...md`. **Aguardo aprovação.**
4. **Ensaio da migração na cópia no Supabase** (esquema separado), com comparação de hash.
5. **Deploy em produção** com backup imediatamente antes, regra de estoque em modo **"só avisar"** primeiro (registra o que bloquearia, sem bloquear), e depois ativada com seu OK.

**Rollback em cada etapa:**
- Migração só acrescenta: reverter = ignorar as colunas/tabelas novas, nada some.
- `RBAC_V2=off` e `ESTOQUE_BLOQUEIO=off` desligam as regras novas sem mexer nos dados.
- Render permite voltar ao deploy anterior (29aaaf1) em um clique; a versão antiga continua compatível com o banco migrado.
- Em último caso, restaurar o esquema de backup tirado no passo 1.

## 9. Decisões que dependem de você

1. Aprovar a matriz de perfis da seção 3 ou ajustar (em especial: **Estoque e Compras podem ver custo e margem? Consulta/Gerência vê o financeiro inteiro?**).
2. Estoque: confirmar bloqueio como padrão e o período em "só avisar" antes de bloquear, e o que fazer com produtos hoje com saldo zero ou negativo.
3. Confirmar que os perfis atuais ficam como "Gerente (atual)" e "Caixa (atual)" até você reatribuir.
4. Excluir venda de teste e numeração: a numeração é por contador no servidor e **não volta atrás**; uma venda excluída deixa um número sem uso. Aceitável? (Alternativa: cancelamento que mantém a venda registrada como "cancelada", a ser feito na Etapa 4 junto da aprovação.)
