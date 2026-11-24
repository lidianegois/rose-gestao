# Etapa 2: roteiro de publicação e de teste por perfil

## A. Antes de publicar (pré-requisitos)
1. Backup interno: esquema `rose_bk_pre2_20261123` (9 documentos, 1 usuário, contadores, migrações). Hash igual ao da produção (`b0ddc35946311383e2b41937d1c88615`). O usuário do site não lê esse esquema.
2. **Backup externo (depende da administradora):** Administração › Copiar backup, guardar o arquivo fora do Supabase. Conferir: arquivo abre como JSON, tem os 9 documentos (cadastros, compras, movimentos, lançamentos, caixas, vendas e notas do mês) e o tamanho é parecido com o de hoje.
3. Repetir o hash da produção imediatamente antes do deploy; se mudou (houve vendas), tirar novo backup interno.
4. **Atenção ao Render:** o serviço está com *Auto-Deploy por commit* ligado em `main`. Enviar o merge para `main` publica sozinho. Por isso o merge só será enviado após a confirmação final (ou o auto-deploy deve ser desligado antes).

## B. Publicação (só com confirmação final)
1. `git checkout main && git merge --ff-only etapa-2 && git push` (fast-forward, sem conflitos; já verificado).
2. Render publica. Nos logs conferir: `002_perfis_estoque` aplicada, perfis semeados, servidor ouvindo.
3. Conferir no banco: hash dos documentos igual ao do backup; usuário existente com perfil Administrador; `estoque_modo = aviso`.
4. Entrar com a conta administradora e fazer o roteiro abaixo.

## C. Rollback (qualquer momento)
`RBAC_V2=off` no Render; modo de estoque "Desligar" na Conferência; voltar o deploy ao commit `29aaaf1`; restaurar `rose_bk_pre2_20261123` se algum dado for afetado.

## D. Roteiro por perfil
Criar um usuário de teste por perfil em *Usuários* (senha provisória, desativar ao final). Usar produtos e vendas de teste e excluí-las depois.

| Perfil | Deve conseguir | Não deve conseguir |
|---|---|---|
| Administrador | tudo; abrir Usuários, Perfis, Conferência de estoque, backup | remover o último administrador |
| Financeiro | ver e lançar contas, baixar, editar e excluir lançamentos; ver vendas, compras, fornecedores, DRE, custo e margem | usar o PDV; gerir usuários |
| Caixa/Vendas | abrir caixa, vender no PDV (dinheiro, Pix, cartão, fiado), receber fiado, cadastrar clientes, sangria | ver custo, compras, fornecedores, financeiro, movimentos |
| Estoque | cadastrar produtos (sem custo), entradas e saídas, notas, receber compra | ver custo, vendas, financeiro |
| Compras | compras, fornecedores, notas, custo de aquisição | ver margem, vendas, financeiro |
| Consulta/Gerência | abrir todas as telas, inclusive financeiro, DRE, custo e margem | gravar qualquer coisa |
| Gerente (atual) / Caixa (atual) | o mesmo que faziam antes | nada novo |

Para cada perfil, conferir:
1. **Leitura:** menu mostra só as telas permitidas; custo/margem ausentes onde negados. Pela API (`GET /api/data/...` com o login do perfil) os documentos negados vêm vazios ou sem os campos.
2. **Gravação:** uma ação permitida grava e aparece em outro aparelho; uma ação negada é recusada (mensagem na tela, dados recarregados).
3. **Permissões individuais:** conceder uma permissão a um usuário e negar outra; a pessoa precisa entrar de novo; conferir o efeito.
4. **PDV (Caixa/Vendas e Administrador):** venda simples; pagamento dividido; fiado; desconto; venda em espera; cupom; venda em outro aparelho conferida.
5. **Estoque no PDV:** com um produto de saldo 1, vender 2 unidades. Em modo aviso a venda passa e aparece em Conferência › avisos. Pedir exceção só tem efeito com o bloqueio ligado.
6. **Simultaneidade:** duas pessoas vendendo o último item em dois aparelhos ao mesmo tempo (no modo aviso as duas passam e o aviso registra; só testar bloqueio depois da conferência).

## E. Conferência de estoque (7 dias)
- Modo permanece **Só avisar** por 7 dias a partir da publicação. O sistema não liga o bloqueio sozinho.
- Diariamente abrir *Conferência de estoque*, exportar o CSV, conferir os saldos físicos, registrar entradas ou ajustes.
- Atenção especial: BEB003, HIG001 e MER002 (saldo zero na cópia).
- Ao final dos 7 dias, se não houver divergência pendente, a administradora liga o bloqueio na própria tela (marcando que conferiu).
