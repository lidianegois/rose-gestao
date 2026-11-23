-- Banco da Rose Mercearia e Bazar (PostgreSQL).
-- O servidor executa este arquivo sozinho ao iniciar; ele pode rodar quantas vezes for preciso.

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
