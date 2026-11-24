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
