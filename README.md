# 1099 vs W‑2 Calculator Backend

Este repositório contém a API e a camada de cálculo para o MVP do **1099 vs W‑2 Calculator**.  Ele é implementado em Node.js com TypeScript utilizando Express, Supabase para persistência de dados, Clerk para autenticação e Stripe para pagamentos.

## Instalação

> **Observação:** as dependências são listadas em `package.json`, mas não são instaladas neste ambiente. Rode estes comandos localmente para configurar o projeto.

```bash
cd backend
npm install
npm run dev
```

Isso iniciará o servidor na porta `3001` (ou na porta definida pela variável de ambiente `PORT`).

## Variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto com as seguintes chaves:

```env
# Supabase
SUPABASE_URL=your-supabase-url
SUPABASE_ANON_KEY=your-supabase-anon-key

# Clerk
CLERK_SECRET_KEY=your-clerk-secret

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PRICE_MONTHLY=price_id_for_monthly
STRIPE_PRICE_ONE_TIME=price_id_for_one_time
STRIPE_WEBHOOK_SECRET=whsec_...

# Express
PORT=3001
```

## Endpoints

- `POST /api/calc` – calcula a comparação entre W‑2 e 1099. Requer autenticação via Clerk (envie o token no cookie ou cabeçalho). Limita usuários gratuitos a 1 simulação por dia. Retorna um `freeSummaryResult` ou `premiumDetailedResult` dependendo do status premium do usuário.
- `POST /api/billing/checkout` – cria uma sessão de checkout do Stripe para o plano selecionado. Exige um `priceId` válido e URLs de sucesso/cancelamento.
- `POST /api/billing/webhook` – endpoint webhook do Stripe para atualizar a tabela de entitlements quando um pagamento ou assinatura é concluído.

Consulte os arquivos em `src/routes/` para detalhes da implementação.

## Schema do banco

O arquivo `schema.sql` contém o esquema Postgres/Supabase com as tabelas e políticas de RLS. Execute-o no console SQL do Supabase para preparar seu banco.

## Testes

Este projeto utiliza Vitest para testes unitários. Para executar os testes:

```bash
npm run test
```

## Deploy

Para deploy em produção, defina as variáveis de ambiente no serviço de hospedagem (por exemplo, Vercel Serverless Functions ou outra plataforma Node) e aponte o frontend para as rotas `/api` adequadas.
