-- Banco da Rose Mercearia e Bazar (PostgreSQL).
-- O servidor executa este arquivo sozinho ao iniciar; ele pode rodar quantas vezes for preciso
-- e nunca apaga nada.

-- Cada linha é um "documento" do site, guardado inteiro em JSON.
-- col = coleção (o site usa "loja"); id = nome do documento, por exemplo:
--   cadastros       produtos, fornecedores, clientes, configurações e numeração
--   compras         pedidos de compra
--   movimentos      entradas e saídas manuais de estoque
--   lancamentos     contas a pagar e a receber
--   caixas          aberturas, sangrias e fechamentos de caixa
--   vendas-AAAA-MM  vendas de um mês
--   notas-AAAA-MM   notas fiscais de entrada de um mês
CREATE TABLE IF NOT EXISTS app_docs (
  col        text        NOT NULL,
  id         text        NOT NULL,
  data       jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (col, id)
);

-- Contador que sobe a cada gravação; o site usa para saber quando recarregar os dados.
CREATE SEQUENCE IF NOT EXISTS app_docs_rev;

-- Pessoas que entram no sistema. A senha é guardada só como hash (scrypt), nunca em texto.
-- role: 'admin' (gerencia usuários) ou 'operador'.
-- pwv: muda quando a senha é trocada ou a conta é desativada, e assim derruba as sessões abertas.
CREATE TABLE IF NOT EXISTS app_users (
  id         text        PRIMARY KEY,
  username   text        NOT NULL UNIQUE,
  name       text        NOT NULL,
  pass       text        NOT NULL,
  role       text        NOT NULL DEFAULT 'operador',
  active     boolean     NOT NULL DEFAULT true,
  pwv        integer     NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login timestamptz
);
