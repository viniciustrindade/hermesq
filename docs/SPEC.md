# Spec: hermesQ — Centralized Event Ingestion for Hermes

## Problem Statement

O gateway de agentes precisa receber eventos de múltiplos serviços externos (Linear, Stripe, Slack, GitHub) **sem expor portas no host**. Uma arquitetura com webhook push exige firewall, TLS, NAT e causa downtime no restart do gateway.

**Política de acesso**: o Worker valida assinatura e timestamp, deduplica pelo ID da entrega e guarda o evento; o host só **busca** os eventos por conexão de saída autenticada, sem nenhuma porta aberta.

**Objetivo**: Um **Cloudflare Worker centralizado** (`hermesQ`) que:
- Recebe webhooks de todos os serviços (HMAC validado na borda)
- Armazena em KV + enfileira em Cloudflare Queues (uma fila por serviço)
- Hermes faz **long-poll outbound** (`/hermes/poll`) → processa → `/hermes/ack`
- Zero portas no Hermes, deploy independente, escala horizontal via consumer groups
- Instalação pelo botão **Deploy to Cloudflare**, sem CLI local; segredos pelo assistente `/setup` (OAuth) e pelos secrets do próprio Worker

## Solution

**Arquitetura "No Ports" (outbound-only)**:

```
┌─────────────┐   HTTPS POST    ┌──────────────────────┐   Long-poll    ┌─────────────┐
│  Serviços   │ ──────────────▶ │ Cloudflare Worker    │ ◀───────────── │   Hermes    │
│ (Linear,    │   (HMAC valid)  │ cloudflare-webhook   │   (OUTBOUND)   │  (Gateway)  │
│  Stripe,    │                 │ - Rate limit         │                │  SEM PORTAS │
│  Slack,     │                 │ - Retry/DLQ          │                └──────┬──────┘
│  GitHub*)   │                 │ - Transform          │                       │
│             │                 │ - Fan-out            │                       ▼
└─────────────┘                 └──────────┬───────────┘            ┌─────────────────┐
                                            │                        │  Agents       │
                                            ▼                        │  (consumers) │
                                    ┌──────────────────┐            │              │
                                    │ KV / D1 / Queues │            │  - Code review│
                                    │ (estado/eventos) │            │  - Provision  │
                                    └──────────────────┘            │  - Orchestrate│
                                                                    └─────────────────┘
```
*GitHub: solução final é esta rota. Até ela entrar, a revisão de PR roda **temporariamente** pelo ticker por polling do Hermes; quando o GitHub estiver no transfer, o ticker é desligado.

**Componentes**:
1. **Cloudflare Worker** (`hermesQ`) — Receiver + Queue Consumer + Hermes Poll Endpoint
2. **Hermes Poller** (roda DENTRO do gateway, background task/plugin) — Consome `/hermes/poll`, executa agentes, faz `/hermes/ack`
3. **CI/CD Pipeline** — `ci.yml` (testes, lint, build) + `cd.yml` (deploy, install/uninstall no Cloudflare)
4. **Botão Deploy to Cloudflare** — provisiona KV, Queues, D1, Durable Object e Worker a partir do `wrangler.jsonc` do repo (Workers Builds); sem Terraform
5. **Subscriptions configuráveis** (KV/D1) — Mapeiam evento → prompt + skills + delivery target
6. **OAuth Token Manager** — Refresh automático, reconexão, expiração proativa

## User Stories

### Core Ingestion
1. As a **platform engineer**, I want a single Cloudflare Worker receiving all external webhooks, so that I manage one endpoint and one TLS cert.
2. As a **security engineer**, I want HMAC validation per-service at the edge, so that invalid payloads never reach Hermes.
3. As a **reliability engineer**, I want idempotency via `Linear-Delivery` / Stripe event ID stored in KV (TTL 7d), so that retries don't create duplicate work.
4. As a **platform engineer**, I want per-service Cloudflare Queues (linear, stripe, slack, github), so that backpressure and retry policies are isolated.

### Hermes Integration (No Ports)
5. As a **Hermes operator**, I want Hermes to make **only outbound HTTPS calls** (long-poll `/hermes/poll`), so that no firewall rules, NAT, or TLS termination are needed on the Hermes host (§3).
6. As a **Hermes operator**, I want multiple Hermes instances to share a consumer group via `lastDeliveryId`, so that scaling Hermes horizontally doesn't duplicate work.
7. As a **Hermes operator**, I want the poller to run as a background task inside the gateway process (plugin or cron), so that it starts/stops with Hermes automatically.

### Event Processing & Routing
8. As a **consumer**, I want GitHub `pull_request_review_requested` to create a Kanban card for the requested reviewer with an idempotency key, so that reviews are tracked and deduplicated.
9. As a **consumer**, I want GitHub `check_run.completed` for a review check to update gate status, so that merge readiness is visible.
10. As a **consumer**, I want Linear `Issue.assigned` to create/assign a Kanban card **mirroring Linear assignee**, so that Kanban and Linear stay in sync.
11. As a **consumer**, I want Stripe `invoice.payment_succeeded` to create a provisioning task, so that customer onboarding is automated.
12. As a **consumer**, I want Slack `app_mention` mentioning the bot to create a response task, so that chat interactions are tracked.

### Subscriptions & Extensibility
13. As a **platform engineer**, I want subscriptions stored in KV/D1 (not code), so that adding a new event route doesn't require Worker redeploy.
14. As a **platform engineer**, I want each subscription to define: `events[]`, `prompt template`, `skills[]`, `deliver target`, optional `filter script`, so that routing is declarative.
15. As a **developer**, I want filter scripts (Python/JS) to transform or silence payloads before prompting agents, so that only relevant events trigger work.

### OAuth Token Lifecycle & Reconnection
16. As a **platform engineer**, I want **automatic token refresh** before expiration (proactive at 80% TTL), so that OAuth tokens never expire during operation.
17. As a **platform engineer**, I want a **reconnection mechanism** (`/oauth/reconnect?service=X`) that re-runs OAuth flow when refresh token is revoked/expired, without manual intervention.
18. As a **platform engineer**, I want **token health monitoring** (`/oauth/health`) showing expiration status, last refresh, and refresh errors per service.
19. As a **security engineer**, I want refresh tokens encrypted at rest (AES-GCM) and rotated on each successful refresh, so that compromise of one token doesn't persist.

### Observability & Operations
20. As an **operator**, I want Cloudflare Workers logs (`wrangler tail`) + Queues metrics + KV usage as the single source of truth, so that debugging is centralized.
21. As an **operator**, I want dead-letter events (max retries exceeded) to remain in KV with status `dead-letter` for manual reprocessing, so that no event is lost.
22. As an **operator**, I want to install the whole stack with the **Deploy to Cloudflare** button, so that setup needs only a Cloudflare and a GitHub account.

### Segredos e Instalação
23. As a **community user**, I want an inline `/setup` wizard that connects Linear and Slack via OAuth and shows the exact webhook URL and secret field for GitHub and Stripe, so that I never touch a CLI or a vault. Secrets live only as Worker secrets or encrypted in the Durable Object.
24. As a **maintainer**, I want the project in a GitHub repo with README, license and Deploy button (private until validated, public afterwards), so that anyone can then install or fork it.

## Implementation Decisions

### 1. Cloudflare Worker — `hermesQ`

**Runtime**: Cloudflare Workers (TypeScript, `nodejs_compat`)

**Bindings** (`wrangler.jsonc` é o formato canônico, exigido pelo botão Deploy; abaixo em TOML só por legibilidade):
```toml
kv_namespaces = [
  { binding = "EVENT_STORE", id = "<prod>", preview_id = "<dev>" }  # events + deliveries + subscriptions
]
queues = [
  { binding = "EVENT_QUEUE_GITHUB", queue_name = "webhook-github" },
  { binding = "EVENT_QUEUE_LINEAR", queue_name = "webhook-linear" },
  { binding = "EVENT_QUEUE_STRIPE", queue_name = "webhook-stripe" },
  { binding = "EVENT_QUEUE_SLACK",  queue_name = "webhook-slack" },
  { binding = "HERMES_QUEUE", queue_name = "hermes-deliveries" }  # deliveries for Hermes poller
]
d1_databases = [
  { binding = "DB", database_name = "hermesQ", database_id = "<prod>" }  # audit log, subscription metadata
]
durable_objects.bindings = [{ name = "OAUTH_STORE", class_name = "OAuthStore" }]  # com migration new_sqlite_classes
triggers.crons = ["0 * * * *"]  # refreshAllIfNeeded()
```

**Routes**:
- `POST /github` — GitHub App webhook (HMAC `X-Hub-Signature-256`, dedupe `X-GitHub-Delivery`)
- `POST /linear` — Linear webhook (HMAC `Linear-Signature`, header `Linear-Delivery` para idempotência)
- `POST /stripe` — Stripe webhook (HMAC `Stripe-Signature`)
- `POST /slack` — Slack Events API (signing secret `X-Slack-Signature`, `X-Slack-Request-Timestamp`)
- `GET /hermes/poll?lastDeliveryId=&limit=` — Long-poll endpoint for Hermes (5s hold)
- `POST /hermes/ack` — Hermes confirms delivery (`{deliveryId, status, result}`, HMAC `HERMES_WEBHOOK_SECRET`)
- `GET /health` — Health check
- `GET /setup` — OAuth setup wizard (HTML/JS)
- `POST /setup/start` — Inicia fluxo OAuth
- `GET /oauth/callback` — Callback OAuth (troca code por tokens)
- `GET /oauth/status` — Status das conexões (`{ connected: string[] }`)
- `POST /oauth/refresh?service=X` — Força refresh imediato do access token
- `POST /oauth/disconnect?service=X` — Desconecta serviço
- `POST /oauth/reconnect?service=X` — Força reconexão (re-inicia OAuth flow)
- `GET /oauth/health` — Health check dos tokens (`{ service, expires_at, needs_refresh, last_refresh_error }`)

**Queue Consumers** (one per service queue):
- Batch size: 10, max batch wait: 100ms
- Process → match subscriptions → create deliveries in `HERMES_QUEUE` + KV `delivery:{id}`
- Retry with exponential backoff (1s, 2s, 4s...), max 3 retries → dead-letter

**Delivery Schema** (KV `delivery:{deliveryId}` + `HERMES_QUEUE`):
```typescript
interface HermesDelivery {
  deliveryId: string;           // UUID
  subscriptionName: string;     // e.g. "linear-issue-synced"
  event: string;                // original event type
  prompt: string;               // rendered prompt
  skills: string[];             // skills to load
  deliver: string;              // slack | telegram | log
  deliverChatId?: string;       // target channel/user
  payload: unknown;             // filtered/original payload
  sourceDeliveryId: string;     // original webhook delivery ID (idempotency)
  createdAt: string;            // ISO8601
  attempts: number;
  maxAttempts: number;
  status: 'pending' | 'processing' | 'delivered' | 'failed' | 'dead-letter';
}
```

**Subscription Schema** (KV `subscriptions:list` or D1):
```typescript
interface Subscription {
  name: string;                 // unique key
  events: string[];             // event types this subscription matches
  prompt: string;               // template with {payload.field} placeholders
  skills: string[];             // Hermes skills to load
  deliver: string;              // delivery target
  deliverChatId?: string;
  filterScript?: string;        // optional Python/JS filter (returns '[SILENT]' to drop)
  enabled: boolean;
}
```

### 2. OAuth Token Manager (Durable Object `OAuthStore`)

**Responsabilidades**:
- Armazenar tokens criptografados (AES-GCM) por serviço
- **Refresh proativo**: background task roda a cada 1h, refresh se `expires_at < now + 20% TTL`
- **Refresh reativo**: endpoint `/oauth/refresh?service=X` força refresh imediato
- **Reconexão**: `/oauth/reconnect?service=X` limpa tokens e redireciona para OAuth flow
- **Health check**: `/oauth/health` retorna status de expiração, último refresh, erros
- **Rotação de refresh token**: novo refresh token a cada refresh bem-sucedido

**Schema de tokens**:
```typescript
interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;           // Unix ms
  scope: string;
  token_type: 'Bearer';
  // Provider-specific
  team_id?: string;        // Slack
  workspace_id?: string;   // Linear
}
```

**Endpoints de gerenciamento**:
| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/oauth/status` | GET | Lista serviços conectados |
| `/oauth/health` | GET | Health check detalhado (expiração, último refresh, erros) |
| `/oauth/refresh?service=X` | POST | Força refresh do access token |
| `/oauth/reconnect?service=X` | POST | Inicia novo OAuth flow (limpa tokens atuais) |
| `/oauth/disconnect?service=X` | POST | Remove tokens e revoga se possível |

**Background Task (Cron Trigger)**:
```toml
[triggers]
crons = ["0 * * * *"]  # A cada hora
```
Executa `refreshAllIfNeeded()` — verifica todos os serviços, refresh se necessário.

### 3. Default Subscriptions (seed data)

| Name | Events | Prompt Template | Skills | Deliver |
|------|--------|-----------------|--------|---------|
| `github-pr-review-requested` | `pull_request_review_requested` | Review PR #{pr.number}: {pr.title}\nRepo: {repo.full_name}\nReviewer: {requested_reviewer.login} | `code-review` | `log` |
| `github-check-completed` | `check_run` (completed) | Check {check_run.name}: {conclusion}\nSHA: {check_run.head_sha} | `code-review` | `log` |
| `github-ci-failed` | `workflow_run.completed` (match `conclusion=failure`, `head_repository.fork=false`) | CI {workflow_run.name} failed on {repository.full_name}\nBranch …\nSHA …\nRun … | — | `log` |
| `github-dependabot-alert` | `dependabot_alert.created`, `.reopened` | Dependabot alert #{alert.number} ({severity}) on {repository.full_name}: {package} | — | `log` |
| `github-code-scanning-alert` | `code_scanning_alert.created`, `.appeared_in_branch` | Code scanning alert #{alert.number} ({alert.rule.id}) on {repository.full_name} | — | `log` |
| `github-secret-scanning-alert` | `secret_scanning_alert.created` | Secret scanning alert #{alert.number} ({alert.secret_type}) on {repository.full_name} (never the secret) | — | `log` |
| `github-pr-review` | `pull_request_review.submitted`, `.dismissed` | Review {review.state} on {repository.full_name}#{pull_request.number} by {review.user.login} | — | `log` |
| `linear-issue-synced` | `Issue.created`, `Issue.updated`, `Issue.assigned` | Linear {entity.identifier} {action}: {entity.title}\nState: {entity.state.name} | `code-review` | `log` |
| `stripe-payment-succeeded` | `invoice.payment_succeeded` | Payment succeeded for {data.object.customer}: {data.object.amount_paid} | `provision` | `log` |
| `slack-mention` | `app_mention` | Slack mention from {event.user} in {event.channel}: {event.text} | configured owner | `slack` |

### 4. CI/CD Pipeline

#### `ci.yml` — Continuous Integration
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

  integration-test:
    runs-on: ubuntu-latest
    needs: lint-and-test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - name: Start local Worker
        run: |
          npx wrangler dev --local --port 8787 &
          npx wait-on http://localhost:8787/health --timeout 60000
      - name: Run integration tests
        run: npm run test:integration
      - name: Stop local Worker
        run: pkill -f "wrangler dev"
```

#### `cd.yml` — Continuous Deployment (Install/Uninstall)
```yaml
name: CD
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      action:
        description: 'Deploy action'
        required: true
        type: choice
        options: [install, uninstall, update]
      environment:
        description: 'Target environment'
        required: true
        type: choice
        options: [staging, production]

permissions:
  contents: read
  deployments: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${{ github.event.inputs.environment || 'staging' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      
      - name: Install/Uninstall
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: ${{ github.event.inputs.action == 'uninstall' && 'delete' || 'deploy' }}
        env:
          # Só CLOUDFLARE_API_TOKEN/ACCOUNT_ID vêm do GitHub Environment; os demais segredos são do /setup
          
      - name: Verify deployment
        if: github.event.inputs.action != 'uninstall'
        run: |
          sleep 10
          curl -f https://${{ vars.WORKER_NAME }}.workers.dev/health
```

**GitHub Environments** (Settings → Environments):
- `staging` — auto-deploy on push to main
- `production` — `workflow_dispatch` com aprovação do proprietário da instalação

**Secrets do GitHub Environment** (só para o CD): `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`. `WORKER_NAME` não é segredo: fica como *variable* do Environment (`vars.WORKER_NAME`).
Todos os demais segredos (client IDs/secrets OAuth, webhook secrets, `OAUTH_ENCRYPTION_KEY`, `HERMES_WEBHOOK_SECRET`) são configurados pelo wizard `/setup` e guardados como secrets do Worker ou cifrados no Durable Object.

### 5. Instalação: botão Deploy to Cloudflare (sem Terraform)

- O `README.md` do repo traz o botão (só funciona com repo público; com repo privado, instalar com `wrangler deploy`): `https://deploy.workers.cloudflare.com/?url=https://github.com/<org>/<repo>`.
- O botão cria KV, Queues, D1 e Durable Object a partir do `wrangler.jsonc` e liga o Workers Builds ao repo do usuário.
- Depois do deploy, o usuário abre `/setup`: o wizard gera `OAUTH_ENCRYPTION_KEY` na primeira execução e conduz o OAuth.
- Segredos de webhook (GitHub, Stripe, Hermes HMAC) são pedidos pelo wizard e salvos como secrets do Worker; nunca vão para o git.
- Desinstalar: `cd.yml` com `action: uninstall` (`wrangler delete`); KV, Queues e D1 exigem limpeza manual.
- O repositório público não inclui dados específicos de uma instalação.

### 6. GitHub

- Transição: o ticker por polling cobre a revisão de PR **temporariamente**. Esta rota substitui o ticker quando entrar.
- Webhook URL: `https://hermesQ.<subdomain>.workers.dev/github`; eventos: pull_request, pull_request_review_requested, check_run, issue_comment; secret `GITHUB_WEBHOOK_SECRET`.
- GitHub Apps podem ficar fora da lista de revisores nativos; um comando de revisão em comentário pode acionar o fluxo.

### 7. Linear Webhook Configuration

- Webhook URL: `https://hermesQ.<subdomain>.workers.dev/linear`
- Events: Issue (created, updated, assigned, removed), Comment (created, updated)
- Secret: `LINEAR_WEBHOOK_SECRET`
- **Handler único idempotente**: dedupe por header `Linear-Delivery`; cartão Kanban com `--idempotency-key EXT-N`
- **Kanban espelha Linear**: assignee/delegate muda → handler reatribui cartão para perfil ou lane configurada
- **Sem avisos no Slack DM** (§5: "Slack: nenhum aviso de Kanban, Linear, GitHub ou Orca na DM")

### 8. Stripe Webhook Configuration

- Webhook URL: `https://hermesQ.<subdomain>.workers.dev/stripe`
- Events: invoice.payment_succeeded/failed, customer.subscription.created/updated/deleted, checkout.session.completed
- Secret: `STRIPE_WEBHOOK_SECRET`

### 9. Slack Configuration

- Slack: Events API → Request URL `https://.../slack`, verify `X-Slack-Signature` + timestamp (anti-replay 5min)
- **Allowlist de usuários** (§3: "Cada canal tem allowlist de usuários; sem lista, negar tudo")

## Testing Decisions

### Unit Tests (Vitest)
- **Worker routes**: Mock `Hono` context, verify HMAC validation, idempotency check, queue send
- **Queue consumer**: Mock `MessageBatch`, verify subscription matching, delivery creation, retry logic
- **Prompt rendering**: Test `{payload.field}` interpolation, nested paths, missing fields
- **Filter scripts**: Test mention detection and PR triage (draft/bot filtering)
- **Subscription CRUD**: KV read/write for subscriptions list
- **OAuthStore**: Token encrypt/decrypt, refresh logic, expiration calculation, reconnection flow

### Integration Tests (Local + Staging)
- **Idempotency**: Send same `Linear-Delivery` twice → second returns `duplicate`
- **Retry/DLQ**: Fail Hermes delivery 3x → verify `dead-letter` status in KV
- **Long-poll**: Poll with empty queue → verify 5s hold + return on new delivery
- **Multi-service isolation**: Blast Linear + Stripe + Slack events → verify correct queues consumed
- **Linear → Kanban sync**: Linear issue assigned → Kanban card created/assigned with same `EXT-N` idempotency
- **OAuth flow**: Mock provider → `/setup/start` → `/oauth/callback` → tokens stored → `/oauth/status` shows connected
- **Token refresh**: Advance time → background task runs → tokens refreshed → `/oauth/health` shows new expiry
- **Reconnection**: `/oauth/reconnect` → clears tokens → redirects to OAuth → new tokens stored
- **Token expiration**: Set `expires_at` in past → `/oauth/health` shows `needs_refresh: true` → background task refreshes

### E2E Tests (Staging)
- **Full deploy**: Click Deploy button → resources created → Worker deployed → wizard accessible
- **Service connection**: OAuth wizard → Linear/Slack connected → webhooks configured → events flow
- **Hermes integration**: Poller starts → `/hermes/poll` returns deliveries → agent executes → `/hermes/ack` confirms
- **Uninstall**: `cd.yml` with `action: uninstall` → Worker deleted → resources cleaned up

### Test Seams (existing preferred)
- `vitest` for unit (already in `cloudflare-webhook-broker`)
- `wrangler dev --local` for Worker integration
- Hermes poller test script (`scripts/test_poller_locally.ts` — already created)

## Out of Scope

- **Discord** (fora desta versão; Interactions não entrega menções a bot)
- **Worker-to-Worker communication** (no service mesh needed)
- **Custom domain / Cloudflare Access** for Worker endpoints (use `*.workers.dev` initially)
- **Rate limiting per-client** (Cloudflare built-in WAF handles DDoS)
- **Metrics export to Prometheus/Grafana** (Cloudflare Queues/KV metrics sufficient for MVP)
- **Multi-region Worker deployment** (single region OK for now)
- **Subscription UI** (CLI/KV direct edit for MVP)
- **Webhook replay UI** (manual KV reprocessing via `wrangler kv:key`)

## Further Notes

### Migration from `cloudflare-webhook-broker`
- The existing `cloudflare-webhook-broker` package (Python poller + TypeScript Worker prototype) is **superseded**.
- New package `hermesQ` is the canonical implementation.
- Poller logic moves from standalone Node script → Hermes plugin (runs in gateway).
- Terraform é descartado: a instalação é pelo botão Deploy to Cloudflare.

### File Structure (new package)
```
/infra/packages/hermesQ/
├── package.json
├── tsconfig.json
├── tsconfig.scripts.json
├── wrangler.toml
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── cd.yml
├── src/
│   ├── index.ts           # Worker entry (Hono routes + queue consumers)
│   ├── routes/
│   │   ├── github.ts        
│   │   ├── linear.ts
│   │   ├── stripe.ts
│   │   ├── slack.ts
│   │   ├── hermes-poll.ts
│   │   ├── hermes-ack.ts
│   │   ├── setup.ts
│   │   ├── oauth-callback.ts
│   │   ├── oauth-status.ts
│   │   ├── oauth-refresh.ts
│   │   └── oauth-reconnect.ts
│   ├── durable-objects/
│   │   └── oauth-store.ts
│   ├── queue/
│   │   └── consumer.ts
│   ├── subscriptions/
│   │   ├── store.ts
│   │   ├── matcher.ts
│   │   └── renderer.ts
│   ├── types.ts
│   └── utils/
│       ├── hmac.ts
│       └── idempotency.ts
├── scripts/
│   ├── test_poller_locally.ts
│   └── seed_subscriptions.ts
└── test/
    ├── routes/
    ├── queue/
    ├── subscriptions/
    └── oauth/
```

### Replaces These Files (to be deleted after review)
This spec consolidates earlier architecture notes, prompt templates, event maps, and the legacy webhook broker package.
Keep project-specific locations outside the public repository.

### Transição
- O transfer é a solução final com todos os serviços (Linear, GitHub, Stripe, Slack). Até o GitHub entrar, vale o ticker por polling do Hermes. Discord segue fora (Interactions não entrega menções).

### Responsáveis
- **Núcleo.** Os serviços (Linear, GitHub, Stripe, Slack) dependem do núcleo e só começam depois dele.

### Next Steps (Implementation Order)
1. Create package scaffolding (`package.json`, `tsconfig`, `wrangler.toml`)
2. Implement Worker routes + queue consumers + subscription store + OAuthStore DO
3. Write unit tests (Vitest) — routes, queue, subscriptions, OAuth
4. Add `ci.yml` + `cd.yml` (GitHub Actions)
5. Botão Deploy to Cloudflare + README + repo público + licença
6. Deploy to staging → configure Linear/Stripe/Slack webhooks
7. Implement Hermes poller plugin
8. Seed default subscriptions
9. End-to-end test with real events (OAuth flow, token refresh, reconnection)
10. Deploy to production
11. Deprecate `cloudflare-webhook-broker`