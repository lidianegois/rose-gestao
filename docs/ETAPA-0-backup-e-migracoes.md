# Etapa 0: backup, restauração e migrações seguras

Data: 23/11/2026. Banco: Supabase `rose-gestao` (`wzxibciutvfdstkzkwvd`), esquema `rose`.

## Backup antes de qualquer alteração
| Item | Resultado |
|---|---|
| Cópia completa em esquema próprio `rose_bk_20261123` (docs, usuários, revisão da sequência) | 9 documentos e 1 usuário |
| Conferência produção × cópia (md5 de cada documento + data de gravação) | 9/9 e 1/1 idênticos; hash geral `4fb0394712b4f11046920ef9a8c42b51` nos dois |
| Restauração em ambiente separado (esquema `rose_stage`, criado do zero com a estrutura original) | 9 documentos e 1 usuário restaurados; mesmo hash; sequência 104 idêntica |
| Acesso à cópia | só o administrador do projeto; o usuário do site (`rose_app`) não lê o esquema de backup; RLS ligada |

Limite: o Supabase gratuito não faz backup automático e a cópia fica **no mesmo projeto**. Ela protege contra erro de
código ou migração, não contra exclusão do projeto. Para uma cópia fora dali, use **Administração › Copiar backup** no site.

## Migrações
- Pasta `db/migrations/NNN_nome.sql`, aplicadas em ordem, cada uma **uma só vez**, em transação, com trava
  (`pg_advisory_lock`) contra duas cópias do servidor migrando juntas. Tabela de controle: `schema_migrations` (com checksum).
- `000_base.sql`: estrutura original (idempotente). `001_simultaneidade.sql`: acrescenta `app_docs.rev`, a tabela
  `app_counters` e inicia os contadores do maior número já usado. **Só acrescenta; não altera nem apaga dados.**

## Validação da migração 001
| Onde | Resultado |
|---|---|
| Cópia dos dados reais (`rose_stage`, Supabase) | contadores venda=3135 e compra=24 (= maiores números existentes); hash dos dados **igual** antes e depois; 9/9 documentos com `rev` 1; produção intacta |
| PostgreSQL local, banco vazio | 2 migrações aplicadas; segunda inicialização não reaplica |
| PostgreSQL local, banco com dados no formato de produção | dados idênticos (md5), contadores 120 e 7 corretos |

## Reversão
As mudanças são aditivas: o código anterior continua funcionando com as colunas/tabelas novas. Para voltar ao estado
anterior aos dados, restaure de `rose_bk_20261123` (documentos e usuários).
