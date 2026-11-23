# Rose Mercearia e Bazar · Sistema de gestão

Sistema da loja: caixa, vendas, fiado, produtos, estoque com lote e validade, notas fiscais de entrada, compras, fornecedores, financeiro e relatórios. Funciona no computador e no celular.

---

## 1. Tecnologia

| Parte | O que é |
|---|---|
| Site (front-end) | **HTML, CSS e JavaScript puros**, num único arquivo (`public/index.html`). Sem framework, sem etapa de build. As telas trocam pelo endereço (`#caixa`, `#vendas`…). Os gráficos são desenhados em SVG pelo próprio código. |
| Fontes | Playfair Display e Inter, carregadas do Google Fonts. Sem internet, o navegador usa fontes parecidas. |
| Servidor (back-end) | **Node.js 20 ou mais novo**, só com o módulo `http` nativo. Entrega o site e uma API de documentos JSON (`server.js`). |
| Banco de dados | **PostgreSQL**, com a tabela `app_docs` (JSONB) (`storage.js` e `db/schema.sql`). Sem `DATABASE_URL`, grava no arquivo `data/banco-local.json`, que serve só para testes. |
| Ligação site ↔ banco | `public/db-adapter.js`. O site foi feito para o armazenamento do claude.ai; este arquivo oferece a mesma interface falando com o servidor. Por isso o `index.html` é o mesmo do site original, com uma única linha a mais, que carrega o adaptador. |
| Dependência | só `pg` (driver do PostgreSQL). |
| Segurança | página de entrada (`/login`) com contas de usuário (administradora ou operador), senhas guardadas só como hash scrypt, sessão por cookie seguro (HttpOnly, 30 dias), bloqueio após 10 tentativas erradas em 15 minutos. |

## 2. Arquivos

```
rose-gestao/
├── public/
│   ├── index.html        ← o site completo
│   ├── login.html        ← página de entrada
│   ├── usuarios.html     ← cadastro de usuários (só administradora)
│   ├── sessao.js         ← mostra quem está conectado e o botão Sair
│   └── db-adapter.js     ← liga o site ao servidor
├── db/
│   └── schema.sql        ← cria a tabela no PostgreSQL (o servidor roda sozinho)
├── exemplos/
│   └── NFe-exemplo-4521.xml   ← nota fiscal de teste para a importação
├── server.js             ← servidor: site + API + senha
├── storage.js            ← grava no PostgreSQL ou no arquivo local
├── package.json          ← scripts e dependências
├── render.yaml           ← Blueprint do Render (site + banco já conectados)
├── .node-version         ← versão do Node (22)
├── .env.example          ← modelo das variáveis de ambiente
├── .gitignore
└── README.md
```

## 3. Funcionalidades que precisam de banco de dados

Tudo o que a loja registra fica no banco, dividido em documentos JSON na coleção `loja`:

| Documento | O que guarda | Telas que usam |
|---|---|---|
| `cadastros` | produtos (código, nome, categoria, custo, preço, mínimo, código de barras), fornecedores (contatos, CNPJ, prazos, preços, códigos de item da nota), clientes (telefone, limite e prazo do fiado), configurações (saldo inicial, taxas da maquininha) e a numeração de vendas e pedidos | Produtos, Fornecedores, Clientes e fiado, Fluxo de caixa, todas as vendas |
| `vendas-AAAA-MM` (um por mês) | vendas com itens, preços, custo, desconto, forma de pagamento, cliente, hora e caixa | Caixa, Vendas, Painel, Financeiro, Análise |
| `caixas` | abertura (troco, operador), sangrias, suprimentos e fechamento (contado e diferença) | Caixa |
| `lancamentos` | contas a pagar e a receber: fixas, parcelas de nota e de pedido, fiado, pagamentos, quebra de caixa | Financeiro, Clientes e fiado, Painel |
| `compras` | pedidos de compra: itens, previsão, situação, recebimento, lote e validade | Compras e reposição |
| `notas-AAAA-MM` (um por mês) | notas fiscais de entrada: itens, lote, validade, fornecedor, chave | Notas fiscais |
| `movimentos` | entradas e saídas manuais de estoque (ajustes, perdas, devoluções, estoque inicial) | Entradas e saídas |

O estoque, o lucro, o fluxo de caixa, os lotes em estoque e os rankings **não são gravados**: são calculados na hora a partir desses documentos.

**O que não vai para o banco (fica só no aparelho):**
- período escolhido no topo e as datas personalizadas (memória do navegador);
- filtros e buscas das telas;
- a venda em andamento no Caixa, antes de finalizar (perde-se ao recarregar a página).

Os documentos grandes (vendas e notas) são divididos por mês para cada gravação continuar pequena. Cada documento aceita até 5 MB.

## 4. Executar no seu computador

Precisa do Node.js 20 ou mais novo.

```bash
npm install
npm start
```

Abra `http://localhost:3000`. Sem `DATABASE_URL`, os dados ficam em `data/banco-local.json`.

Para testar com PostgreSQL e senha, copie `.env.example` para `.env`, preencha e rode:

```bash
node --env-file=.env server.js
```

## 5. Publicar no Render

### Opção A, mais simples: Blueprint

1. Tenha um banco PostgreSQL pronto e copie o endereço de conexão (`postgres://...`). Pode ser do Supabase, do Neon ou um Postgres criado no próprio Render.
2. Coloque esta pasta num repositório no GitHub, GitLab ou Bitbucket.
3. No painel do Render: **New › Blueprint**, escolha o repositório.
4. O Render lê o `render.yaml` e cria o Web Service `rose-gestao`. Quando pedir:
   - **DATABASE_URL**: cole o endereço do banco;
   - **APP_PASSWORD**: digite a senha da loja.
5. **PGSSL** já vem como `true`, o certo para bancos externos. Se usar a *Internal Database URL* de um Postgres do próprio Render, mude para `false` em Environment.
6. Confirme. Ao final, o site fica em `https://rose-gestao.onrender.com`, ou um nome parecido. O navegador pede usuário (`rose`) e a senha.

### Opção B: manual

1. **New › Postgres**: crie o banco e copie a *Internal Database URL*.
2. **New › Web Service**: escolha o repositório.
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/health`
3. Em **Environment**, adicione:
   - `DATABASE_URL` = a Internal Database URL
   - `APP_USER` = `rose`
   - `APP_PASSWORD` = a senha da loja
   - `NODE_VERSION` = `22`
4. Crie o serviço. A tabela do banco é criada sozinha na primeira vez.

### Levar os dados do site antigo

O banco do Render começa vazio. Os dados do site no claude.ai **não passam sozinhos**:

1. No site antigo, no rodapé ou no menu **Mais**: **Copiar backup**.
2. Cole num arquivo de texto e guarde.
3. No site novo: **Restaurar backup** e cole o texto.

## 6. Antes de usar de verdade

- **Plano gratuito do Render:**
  - o site "dorme" depois de 15 minutos sem uso e leva cerca de 1 minuto para acordar;
  - o banco gratuito **expira em 30 dias**: depois disso há 14 dias para passar para um plano pago, ou os dados são apagados.

  Para a loja, use um plano pago no banco e, se quiser o site sempre acordado, também no serviço. No `render.yaml`, troque `plan: free`.
- **Sempre defina `APP_PASSWORD`.** Sem ela, qualquer pessoa com o link vê e altera vendas, clientes e o financeiro.
- **Backup:** continue usando **Copiar backup** toda semana. O Render também faz backups do banco nos planos pagos.
- **Mais de um aparelho ao mesmo tempo:** os dados se atualizam nos outros aparelhos em até 4 segundos. Se dois aparelhos gravarem a mesma parte (por exemplo, dois caixas vendendo no mesmo minuto), vale a última gravação, como no site original. Uma pessoa por vez no caixa evita isso.
- **Nota fiscal de venda (NFC-e):** o sistema não emite. Continue com o emissor fiscal.
- **Leitor de código de barras:** USB ou Bluetooth, funcionando como teclado.

## 7. Verificação do projeto

| Item | Situação |
|---|---|
| Site completo num arquivo, sem build | ok |
| Arquivos externos | só Google Fonts (opcional) |
| Servidor sem framework, uma dependência (`pg`) | ok |
| Tabela criada sozinha ao iniciar | ok |
| Senha opcional para site e API | ok |
| `/health` para o Render | ok |
| Banco externo com SSL (`sslmode` no endereço é tratado pelo servidor) | ok |
| Proteção contra acesso a arquivos fora de `public/` | ok |
| Teste local com arquivo: semear dados, recarregar, ver em outro aparelho | ok |
| Comandos SQL testados num PostgreSQL 16 | ok |
| Conexão do servidor com o PostgreSQL pelo driver `pg` | não executada no teste (o driver não pôde ser instalado aqui); confira no primeiro deploy: o log deve mostrar `armazenamento: PostgreSQL` |
| `package-lock.json` | não incluído: será gerado no primeiro `npm install` |

## 8. Publicação atual

| Item | Valor |
|---|---|
| Site | https://rose-gestao.onrender.com (Render, plano Free, região Virgínia) |
| Banco | Supabase, projeto `rose-gestao` (`wzxibciutvfdstkzkwvd`), região us-east-1, esquema `rose`, usuário `rose_app` (sem poderes de administrador) |
| Conexão | pooler de sessão do Supabase (`aws-1-us-east-1.pooler.supabase.com:5432`) com SSL |
| Código | https://github.com/lidianegois/rose-gestao, branch `main` |

**Como atualizar o site:** envie as mudanças para a branch `main` e, no painel do Render, clique em **Manual Deploy › Deploy latest commit**. Para publicar sozinho a cada envio, conecte o GitHub em Render › Account Settings › Git providers.

**Depois de atualizar:** recarregue a página de verdade (F5). Só trocar de aba no menu não baixa a versão nova.

## 9. Usuários, perfis e acesso (RBAC)

- **Entrada:** `/login`. Quem não entrou é levado para lá.
- **Primeira administradora:** criada sozinha na primeira vez que o servidor sobe, com `APP_USER` e `APP_PASSWORD`. Depois disso essas variáveis não mudam mais nada: usuários e senhas passam a ser cuidados na tela **Usuários e perfis**.
- **Menu lateral:** mostra só as telas do perfil. No computador fica fixo à esquerda; no celular abre pelo botão ☰ ou por **Mais**.

| Perfil | Telas | Pode alterar |
|---|---|---|
| Administradora | todas, mais Usuários e perfis, backup e apagar dados | tudo |
| Gerente | todas as telas da loja | tudo, menos usuários, backup e apagar dados |
| Caixa | Caixa, Vendas, Clientes e fiado | vendas, caixa, fiado e clientes; não exclui vendas nem clientes |

- **Proteção no servidor**, além de esconder na tela:
  - o perfil Caixa só consegue gravar os documentos `cadastros`, `caixas`, `lancamentos` e `vendas-*`, e não apaga documentos;
  - só a administradora acessa `/usuarios` e `/api/usuarios`.
- **Limite:** como os dados são guardados por documento, o servidor não separa, dentro de `cadastros` e `lancamentos`, o que o Caixa altera. Esses limites mais finos (não excluir venda ou cliente, não mexer em produtos) são aplicados pela tela.
- **Desativar** tira o acesso na hora, sem apagar o histórico. Não existe exclusão de usuários.
- Cada venda e cada abertura de caixa guardam o nome de quem estava conectado ("Registrada por", nos detalhes da venda).
- **`SESSION_SECRET`:** chave que assina as sessões. Sem ela, todos saem do sistema quando o servidor reinicia.
