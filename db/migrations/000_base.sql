-- 000: estrutura original (idempotente; nunca apaga nada).
-- Cada linha de app_docs é um "documento" do site, guardado inteiro em JSON.
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
CREATE SEQUENCE IF NOT EXISTS app_docs_rev;
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
