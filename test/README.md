# Testes

Rodam num PostgreSQL local, separado da produção. Não tocam no Supabase.

```bash
# 1) PostgreSQL local (porta 5433, socket em /tmp/pgsock)
# 2) Testes de banco: migrações, numeração, conflitos, atomicidade (28+ verificações)
PGHOST=/tmp/pgsock PGPORT=5433 NODE_PATH=test/shim node test/etapa1.test.js
```

`test/shim/pg` imita o módulo `pg` usando o `psql`; serve só quando não dá para instalar dependências.
Em produção e em desenvolvimento normal vale o módulo `pg` de verdade (`npm install`).

Os testes de navegador (`e2e-simultaneo.js`, `e2e-pdv.js`) usam o Playwright e precisam de uma cópia do
`public/index.html` com a linha `window.__T = {...}` antes do `</script>` final, que expõe o estado interno
só para os testes. Essa linha **nunca** entra no código publicado.

## Etapa 2

```bash
PGHOST=/tmp/pgsock PGPORT=5433 NODE_PATH=test/shim node test/etapa2.test.js   # API: perfis, leitura/escrita, estoque, corrida
PORT=3112 node test/e2e-perfis.js                                              # navegador (mesmo servidor de teste dos outros e2e)
# rollback: com o código da Etapa 1 em /tmp/old (git archive 29aaaf1), depois do etapa2.test.js
PGHOST=/tmp/pgsock PGPORT=5433 NODE_PATH=test/shim node test/rollback.test.js
```

## Piloto do plano Básico (local)

```bash
export PGHOST=/tmp/pgsock PGPORT=5433 NODE_PATH=test/shim
node test/piloto-basico.test.js          # API: plano, perfis, TI-Lidiane, estoque negativo em banco isolado (t_pneg)
node test/e2e-roteiro.js basico          # navegador: roteiro de 7 dias, Rose (plano Básico), banco t_rot_basico
node test/e2e-roteiro.js completo        # navegador: mesmo roteiro, TI-Lidiane (plano Completo), banco t_rot_completo
```

Só dados fictícios; cada cenário cria o próprio banco e uma cópia do site em `/tmp/rot_<cenario>` com o gancho de teste.
O `e2e-perfis.js` espera um banco já com mais de 5 produtos (rode depois do `e2e-simultaneo.js` num banco novo).

Serviço de piloto (`PLANO_PILOTO`, `TI_SENHA`): `node test/piloto-env.test.js` (banco local `rose_gestao_teste_db`).
