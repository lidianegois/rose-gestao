-- 001: base para vários usuários trabalharem ao mesmo tempo. Só acrescenta; não altera nem apaga dados.
--  * app_docs.rev: sobe a cada gravação do documento.
--  * app_counters: numeração única de vendas e compras, controlada pelo servidor.
ALTER TABLE app_docs ADD COLUMN IF NOT EXISTS rev bigint NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS app_counters (
  name       text        PRIMARY KEY,
  value      bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Começa do maior número já usado (nas vendas/compras gravadas e na numeração guardada em "cadastros").
INSERT INTO app_counters (name, value)
SELECT 'venda', GREATEST(
  COALESCE((SELECT (data->'seq'->>'venda')::bigint FROM app_docs
             WHERE col = 'loja' AND id = 'cadastros' AND (data->'seq'->>'venda') ~ '^[0-9]+$'), 0),
  COALESCE((SELECT max((v->>'n')::bigint)
              FROM app_docs d,
                   jsonb_array_elements(CASE WHEN jsonb_typeof(d.data->'items') = 'array' THEN d.data->'items' ELSE '[]'::jsonb END) v
             WHERE d.col = 'loja' AND d.id LIKE 'vendas-%' AND (v->>'n') ~ '^[0-9]+$'), 0))
ON CONFLICT (name) DO NOTHING;

INSERT INTO app_counters (name, value)
SELECT 'compra', GREATEST(
  COALESCE((SELECT (data->'seq'->>'compra')::bigint FROM app_docs
             WHERE col = 'loja' AND id = 'cadastros' AND (data->'seq'->>'compra') ~ '^[0-9]+$'), 0),
  COALESCE((SELECT max((v->>'n')::bigint)
              FROM app_docs d,
                   jsonb_array_elements(CASE WHEN jsonb_typeof(d.data->'items') = 'array' THEN d.data->'items' ELSE '[]'::jsonb END) v
             WHERE d.col = 'loja' AND d.id = 'compras' AND (v->>'n') ~ '^[0-9]+$'), 0))
ON CONFLICT (name) DO NOTHING;
