#!/usr/bin/env bash
# Cria ou desativa as contas temporárias de teste (uma por perfil) pela API do site.
# Nunca altera o administrador: só mexe em usuários cujo nome de acesso começa com "teste_".
# Uso: URL=https://rose-gestao.onrender.com ADMIN_USER=... ADMIN_PASS=... ./scripts/contas-teste.sh criar|desativar|listar
# As senhas das contas de teste são geradas aqui e ficam só em contas-teste.txt (local, fora do git).
set -euo pipefail
: "${URL:?}" "${ADMIN_USER:?}" "${ADMIN_PASS:?}"
J=$(mktemp); trap 'rm -f "$J"' EXIT
export ADMIN_USER ADMIN_PASS
python3 -c 'import json,os;print(json.dumps({"usuario":os.environ["ADMIN_USER"],"senha":os.environ["ADMIN_PASS"]}))' \
  | curl -fsS -c "$J" -H 'Content-Type: application/json' -d @- "$URL/api/login" >/dev/null
PERFIS="financeiro caixa_vendas estoque compras consulta gerente_atual caixa_atual"
lista() { curl -fsS -b "$J" "$URL/api/usuarios" | python3 -c 'import sys,json
for u in json.load(sys.stdin)["users"]:
    if u["username"].startswith("teste_"): print(u["id"], u["username"], "ativo" if u["active"] else "inativo")'; }
case "${1:-}" in
  criar)
    umask 077; : > contas-teste.txt
    for p in $PERFIS; do
      s=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)
      P=$p S=$s python3 -c 'import json,os;p=os.environ["P"];print(json.dumps({"usuario":"teste_"+p,"nome":"TESTE "+p,"senha":os.environ["S"],"perfil":p}))' \
        | curl -fsS -b "$J" -H 'Content-Type: application/json' -d @- "$URL/api/usuarios" >/dev/null
      echo "teste_$p $s" >> contas-teste.txt
    done; echo "criadas 7 contas; senhas em contas-teste.txt";;
  desativar)
    lista | while read -r id nome _; do
      curl -fsS -b "$J" -X PATCH -H 'Content-Type: application/json' -d '{"ativo":false}' "$URL/api/usuarios/$id" >/dev/null && echo "desativado $nome"
    done;;
  listar) lista;;
  *) echo "use: criar | desativar | listar"; exit 1;;
esac
