-- 004: histórico de alterações (Etapa 3, parte A). Só acrescenta: nenhuma tabela existente é alterada.
-- Cada linha diz quem fez o quê, quando, e como o registro era antes e ficou depois.
-- Registro somente de inclusão: o sistema nunca altera nem apaga estas linhas.
CREATE TABLE IF NOT EXISTS audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   text,                 -- quem fez (NULL = o próprio sistema)
  user_name text,
  perfil    text,
  acao      text NOT NULL,        -- criar | alterar | excluir | config | lista | apagar_documento | usuario_* | perfil_* | ...
  alvo      text NOT NULL,        -- documento ou área (ex.: vendas-2026-11, lancamentos, usuarios)
  lista     text,                 -- parte do documento (items, produtos, clientes...)
  registro  text,                 -- id do registro mexido
  resumo    text,                 -- frase curta para a tela (ex.: "Venda nº 12 criada")
  antes     jsonb,
  depois    jsonb,
  detalhe   jsonb                 -- campos alterados, tamanhos, etc.
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_alvo ON audit_log (alvo, registro);
CREATE INDEX IF NOT EXISTS audit_log_user ON audit_log (user_id);
CREATE OR REPLACE FUNCTION audit_log_imutavel() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log é um registro somente de inclusão'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_imutavel ON audit_log;
CREATE TRIGGER audit_log_imutavel BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_imutavel();
DROP TRIGGER IF EXISTS audit_log_imutavel_trunc ON audit_log;
CREATE TRIGGER audit_log_imutavel_trunc BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_imutavel();
