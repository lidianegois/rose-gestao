-- Etapa 2: perfis e permissões, configurações e registro da proteção de estoque.
-- Só acrescenta: nada é removido ou alterado nos dados existentes. A coluna app_users.role continua valendo
-- para a versão anterior do sistema (rollback).

CREATE TABLE IF NOT EXISTS app_roles (
  id         text PRIMARY KEY,
  label      text NOT NULL,
  perms      jsonb NOT NULL DEFAULT '[]'::jsonb,
  system     boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role_id text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS perm_grant jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS perm_deny jsonb NOT NULL DEFAULT '[]'::jsonb;

-- cada usuário recebe o perfil equivalente ao papel que já tinha (mesmas permissões de hoje)
UPDATE app_users SET role_id = CASE role WHEN 'admin' THEN 'administrador' WHEN 'caixa' THEN 'caixa_atual' ELSE 'gerente_atual' END
 WHERE role_id IS NULL;

CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- proteção de estoque começa em modo de aviso; o bloqueio só é ligado pela administradora, depois da conferência
INSERT INTO app_settings (key, value) VALUES ('estoque_modo', '"aviso"'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('estoque_aviso_desde', to_jsonb(now())) ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_stock_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL,          -- aviso | bloqueio | excecao
  product_id    text NOT NULL,
  product_name  text,
  saldo         numeric,                -- saldo antes da mudança
  qty           numeric,                -- quanto a mudança consumia
  user_id       text,
  user_name     text,
  authorized_by text,
  justification text,
  detail        jsonb
);
CREATE INDEX IF NOT EXISTS app_stock_log_at ON app_stock_log (at DESC);
-- registro só de inclusão: nunca alterado nem apagado pelo sistema
CREATE OR REPLACE FUNCTION app_stock_log_imutavel() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'app_stock_log é um registro somente de inclusão'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_stock_log_imutavel ON app_stock_log;
CREATE TRIGGER app_stock_log_imutavel BEFORE UPDATE OR DELETE ON app_stock_log FOR EACH ROW EXECUTE FUNCTION app_stock_log_imutavel();
