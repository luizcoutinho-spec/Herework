# HereWork — Ledger de Achados de Auditoria

> HEAD `239d9ae` · Iniciado: 2026-06-15 · Auditor: Claude Code

---

## Legenda de Severidade
- **P0** — Crítico: compromete dinheiro, segurança ou autenticação
- **P1** — Alto: quebra fluxo principal em produção
- **P2** — Médio: afeta estabilidade ou pode tornar-se P1
- **P3** — Baixo: melhoria recomendada

---

## ETAPA 1 — Inventário (2026-06-15)

| # | Evidência | Arquivo | Função/Seção | Linha | Causa-raiz | Impacto | Risco | Correção | Prioridade |
|---|-----------|---------|--------------|-------|-----------|---------|-------|----------|-----------|
| E1-01 | `api/_helpers.js:12` usa `STRIPE_SECRET_KEY`; `api/release-payment.js:28` usa `STRIPE_SECRET_KEY_TEST`; `api/cancel-contract.js:27` idem | `api/_helpers.js`, `api/release-payment.js`, `api/cancel-contract.js` | `getStripe()`, módulo nível | 12, 28, 27 | Duas variáveis de ambiente distintas para chave Stripe nas Vercel Functions: webhook/pix/status usam a genérica (`STRIPE_SECRET_KEY`), release/cancel forçam a test (`STRIPE_SECRET_KEY_TEST`) | Se `STRIPE_SECRET_KEY=sk_live_` → webhook processa dinheiro real; release-payment usa `STRIPE_SECRET_KEY_TEST` → transferência ao freelancer **nunca ocorre em produção** | **Dinheiro retido indefinidamente; inconsistência live/test silenciosa** | Unificar em uma variável única ou separar explicitamente live/test em todos os arquivos com validação de prefixo no boot | **P0** |
| E1-02 | L10380: `_EDGE_BASE + '/create-payment-intent'`; L10395: `/release-payment`; L10409: `/refund-payment` — nenhuma dessas Edge Functions existe (existem: `hw-create-payment-intent`, `hw-create-subscription`, `hw-deploy-test`) | `app.html` | `_stripeCreatePayment`, `_stripeReleasePayment`, `_stripeRefund` | 10380, 10395, 10409 | Funções legadas apontam para Edge Functions que não existem ou foram renomeadas | Chamadas retornam 404; fluxo legado de escrow quebrado | Código morto não removido; se reativado, fará escrow quebrar silenciosamente | Remover ou arquivar o bloco L10372-10416; nunca ativar sem criar as Edge Functions correspondentes | **P1** |
| E1-03 | `feat/escrow-rebuild` commit `ff1c786`: "Fix dangerous pk_live fallback in test-mode Stripe instantiation" — não mergeado em `main` | Branch `feat/escrow-rebuild` | — | — | Branch com fix de segurança crítico nunca mergeada (17 commits exclusivos) | Bug de segurança que o próprio time identificou e corrigiu permanece ativo em produção | `pk_live` pode ser usado onde deveria ser `pk_test` | Auditar, testar e mergear `feat/escrow-rebuild` → `main` | **P1** |
| E1-04 | `config.toml:3-7`: `verify_jwt=false` para `hw-create-payment-intent` e `hw-create-subscription`; auth interna via `getUid()` em ambas | `supabase/config.toml`, `supabase/functions/hw-create-payment-intent/index.ts:35-43`, `supabase/functions/hw-create-subscription/index.ts:45-53` | `getUid()` | 35, 45 | JWT bypass no nível Supabase; autenticação reimplementada internamente | Se `getUid()` falhar ou for bypassado, qualquer um pode criar PaymentIntents/Subscriptions | Risco se `SUPABASE_SERVICE_ROLE_KEY` vazar; atualmente mitigado pela validação interna | Avaliar se `verify_jwt=true` é viável; no mínimo adicionar rate-limiting por IP | **P1** |
| E1-05 | `.env.example` documenta `GMAIL_USER`/`GMAIL_APP_PASSWORD`; `package.json` lista `nodemailer`; `api/send-email.js` usa Resend via fetch sem SDK | `.env.example`, `package.json`, `api/send-email.js` | — | send-email:72 | Três stacks de e-mail conflitantes: código usa Resend, deps/docs apontam para Gmail/nodemailer | Novo colaborador configura variáveis Gmail inexistentes → e-mails não funcionam | Baixo impacto atual (Resend funciona), alto impacto de manutenção | Remover `nodemailer` de `package.json`; atualizar `.env.example` com `RESEND_API_KEY` e `RESEND_FROM` | **P2** |
| E1-06 | `SUPABASE_ANON_KEY` usada em 7 arquivos `api/` (`approve-contract`, `confirm-contract`, `cancel-contract`, `create-connect-account`, `connect-account-status`, `send-email`, `data-request`) mas **ausente do `.env.example`** | `api/*.js`, `.env.example` | — | — | `.env.example` incompleto | Ausência desta var em produção causa falha de JWT silenciosa ou 401 não diagnosticável | Médio: quebra fluxos de contrato/e-mail | Adicionar `SUPABASE_ANON_KEY` ao `.env.example` | **P2** |
| E1-07 | 3 branches com fixes pendentes não mergeados em `main` (`feat/escrow-rebuild`: 17 commits; `fix/payments`: 5; `fix/proposals`: 3) | Git | — | — | Desenvolvimento fragmentado sem processo de merge/release definido | Fixes de bugs existentes (3DS/SCA, PIX, proposals) ausentes em produção | Drift crescente; quanto mais tempo, mais difícil de mergear | Definir processo de merge e release; mergear as branches após validação | **P2** |
| E1-08 | `index.full.backup.html` (1 MB), `ai_script.html` (35 KB), `inject_ai.js` (35 KB) na raiz; não referenciados por `app.html` | Raiz do repo | — | — | Artefatos de desenvolvimento não limpos | Sem impacto funcional; aumenta superfície de exposição e tamanho do deploy | Baixo: arquivos acessíveis publicamente via Vercel; `inject_ai.js` pode revelar features experimentais | Adicionar ao `.gitignore` e/ou deletar; se necessários, mover para diretório protegido | **P3** |
| E1-09 | `hw-deploy-test` deployado em produção como Edge Function pública | `supabase/functions/hw-deploy-test/index.ts` | handler | — | Artefato de teste de CI permaneceu em produção | Endpoint público retorna `{"ok":true}` sem autenticação (verify_jwt padrão=true neste caso) | Baixo risco funcional; sinal de ausência de processo de limpeza pós-deploy | Remover `hw-deploy-test` da produção após validar que não há dependência | **P3** |
| E1-10 | `app.html` tem 25.060 linhas, ~1.45 MB, 469 funções inline; `jest.coverageFrom` cobre apenas `api/**` | `app.html`, `package.json` | — | — | SPA monolítico sem framework, sem testes de frontend | Zero cobertura de teste nos 25k linhas do frontend | **Alto:** lógica financeira, RLS client-side e UI de escrow sem testes | Plano de migração para framework + testes E2E (Playwright) | **P2** |

---

## FASE 2 — A01 + A03 (fix/stripe-unify-test, 2026-06-15)

| # | Finding | Arquivo | Status | Notas |
|---|---------|---------|--------|-------|
| A01 | URL morta `create-payment-intent` (sem `hw-`) → 404 em todos os pagamentos de não-TEST_UIDS | `app.html:22662` (anterior) | **FECHADO** — substituído por `hw-create-payment-intent` para todos os usuários |
| A03 | Inconsistência Stripe live/test: `_helpers.js` usava `STRIPE_SECRET_KEY`, demais usavam `_TEST` | `api/_helpers.js:12`, `api/webhook.js:65` | **FECHADO (temp)** — ambos migrados para `*_TEST`; débito D8 abaixo |

### Débito D8 — GO-LIVE (não resolver nesta fase)

> **TEMP (fase de testes):** `api/_helpers.js` e `api/webhook.js` unificados em `STRIPE_SECRET_KEY_TEST` / `STRIPE_WEBHOOK_SECRET_TEST`. Front (`app.html`) unificado em `_STRIPE_PK_TEST`; bifurcação `_isTestMode` removida.
>
> **GO-LIVE:** (1) trocar `STRIPE_SECRET_KEY_TEST` → `STRIPE_SECRET_KEY` em `_helpers.js` e definir valor `sk_live_` no Vercel; (2) trocar `STRIPE_WEBHOOK_SECRET_TEST` → `STRIPE_WEBHOOK_SECRET` em `webhook.js` e garantir que o `whsec_` live corresponde ao endpoint de produção no Stripe Dashboard; (3) no front, restaurar bifurcação `_isSubscription` (pk_test) vs escrow (pk_live) via `initStripe()`; (4) adicionar guard de boot que valida prefixo (`sk_test_` em staging, `sk_live_` em produção) e recusa subir se incoerente; (5) unificar os dois singletons Stripe (`_stripe`/`_initStripe` e `_stripeInstance`/`initStripe`) em um só.

### PASSO 0 — Gap de Webhook Test (ABERTO)

Stripe CLI não está instalado localmente; não foi possível listar endpoints via `stripe webhook_endpoints list`.
Do `vercel env ls`:
- `STRIPE_WEBHOOK_SECRET` — existe (Production+Preview)
- `STRIPE_WEBHOOK_SECRET_TEST` — existe (Production+Preview)

**Gap potencial:** não foi confirmado que há um endpoint de webhook no Stripe **modo test** apontando para `https://herework.vercel.app/api/webhook` com `whsec_` correspondente ao valor de `STRIPE_WEBHOOK_SECRET_TEST`.

**Ação requerida antes do E2E:**
1. Abrir Stripe Dashboard → Developers → Webhooks → **toggle "Test mode"**
2. Verificar se existe endpoint `https://herework.vercel.app/api/webhook` em modo test
3. Se não existir: criar → copiar o `whsec_` → atualizar `STRIPE_WEBHOOK_SECRET_TEST` no Vercel
4. Se existir: confirmar que o `whsec_` coincide com `STRIPE_WEBHOOK_SECRET_TEST` no Vercel
5. Sem isso, o webhook não validará eventos de test e contratos não serão criados

---

## PASSO 2 — Correção de testes obsoletos (fix/payment-confirm-diagnose, 2026-06-15)

| # | Finding | Arquivo(s) | Status | Diagnóstico |
|---|---------|-----------|--------|-------------|
| T01 | `send-email.test.js` mockava nodemailer; `api/send-email.js` usa Resend via fetch; código exige JWT antes de validar campos | `tests/send-email.test.js` | **CORRIGIDO** — reescrito com `global.fetch` mock, `Authorization: Bearer faketoken` em todas as requisições |
| T02 | `webhook.test.js` esperava `PATCH contracts?id=eq.uuid-contract` em `payment_intent.succeeded`; handler atual lê `metadata.proposal_id` e cria contrato via POST | `tests/webhook.test.js` | **CORRIGIDO** — teste atualizado para `metadata.proposal_id`, mock de fetch sequencial para o fluxo proposta→contrato, asserção `POST /rest/v1/contracts` |
| T03 | `data-request.test.js` asseverava `protocol1 !== protocol2` dependendo de granularidade de 1ms de `Date.now()` | `tests/data-request.test.js` | **CORRIGIDO** — substituído por verificação de formato `/^EXPORT-[0-9A-Z]+$/` |

### P3 — Colisão de protocolo em data-request sob concorrência

**Arquivo:** `api/data-request.js:68`

O protocolo é gerado como `TYPE + '-' + Date.now().toString(36).toUpperCase().slice(-8)`, com granularidade de 1 ms. Dois requests simultâneos no mesmo milissegundo produziriam protocolos idênticos, quebrando a propriedade de unicidade necessária para rastreabilidade LGPD.

**Recomendação:** adicionar entropia ao protocolo, ex.: `TYPE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6).toUpperCase()}`.

---

*E2E de validação pendente — aguarda PASSO 0 resolvido pelo usuário.*

---

## PASSO 3 — CSP + _timeAgo guard (fix/csp-realtime-connect, 2026-06-16)

| # | Finding | Arquivo(s) | Status | Diagnóstico |
|---|---------|-----------|--------|-------------|
| C01 | CSP bloqueava WebSocket Supabase Realtime: `wss://*.supabase.co` ausente do `connect-src` | `app.html:13`, `vercel.json:38` | **CORRIGIDO** — `wss://*.supabase.co` adicionado ao `connect-src` em ambos |
| C02 | `_timeAgo(p.created_at)` chamado sem guarda de `typeof` em linha 18291, único ponto sem proteção das 4 chamadas | `app.html:18291` | **CORRIGIDO** — alinhado ao padrão `typeof _timeAgo === 'function' ? ... : ''` |

### Débito D9 — CSP duplicada (não resolver nesta fase)

> **ACHADO:** A política CSP está duplicada: meta tag em `app.html:13` (aplicada pelo browser ao carregar o arquivo diretamente) e header HTTP `Content-Security-Policy` em `vercel.json:38` (aplicado pelo servidor). O browser aplica a interseção de ambas, o que significa que qualquer atualização futura precisa ser feita em dois lugares — fonte de divergência silenciosa.
>
> **Débito:** Consolidar em fonte única (remover a meta tag, deixar apenas o header Vercel) ou garantir processo de manutenção sincronizado (ex.: script de verificação de igualdade no CI).
>
> **Impacto:** baixo agora; médio em manutenção contínua — uma edição esquecida em um dos dois cria restrição inesperada em produção.
