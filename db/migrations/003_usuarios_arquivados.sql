-- Arquivar usuários (somem da lista principal, mas continuam cadastrados e podem voltar). Só acrescenta.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
