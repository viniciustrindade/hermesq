# hermesQ

Receive webhooks from **GitHub, Linear, Stripe and Slack** on a Cloudflare Worker and hand them to an
agent host that **never opens a port**. The Worker verifies each provider's signature, drops replays and
duplicates, queues the event and turns it into a *delivery*. Your host long-polls the Worker over outbound
HTTPS, runs the delivery and acks it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/viniciustrindade/hermesq)

```
 GitHub / Linear /      HTTPS POST        ┌───────────────────────────────┐    long-poll (outbound)   ┌────────────┐
 Stripe / Slack   ───────────────────────▶│ Worker                        │◀──────────────────────────│ your host  │
                    signature checked      │  verify → dedupe → queue      │   GET  /hermes/poll       │ (Hermes    │
                    at the edge            │  queue → subscriptions →      │   POST /hermes/ack        │  plugin or │
                                           │  deliveries (retry, DLQ)      │   HMAC-signed both ways   │  any HTTP  │
                                           │  OAuth tokens (Durable Object)│                           │  client)   │
                                           └──────────────┬────────────────┘                           └────────────┘
                                                          │ KV · D1 · Queues · Durable Object
```

- One Worker, one URL and one certificate for every provider.
- Signatures and timestamps are checked before anything is stored (`X-Hub-Signature-256`, `Linear-Signature`,
  `Stripe-Signature`, `X-Slack-Signature`; 5-minute replay window where the provider signs a time).
- Idempotent: the provider's delivery id (`X-GitHub-Delivery`, `Linear-Delivery`, Stripe event id, Slack
  `event_id`) is claimed once in D1; a retry answers `{"status":"duplicate"}`.
- One queue per provider; consumer retries with backoff (1 s, 2 s, 4 s…) and keeps dead letters in KV.
- Deliveries are leased to one poller at a time, so several hosts can share the work.
- OAuth for Linear and Slack (connect, refresh at 80% of the token lifetime, rotation, reconnect, revoke),
  tokens encrypted with AES-GCM in a Durable Object, refreshed by an hourly cron.
- Nothing to install locally: the Deploy button, the `/setup` page and Worker secrets cover the setup.

## Install

1. Click **Deploy to Cloudflare** above. Cloudflare copies this repository to your GitHub account, creates
   the KV namespace, D1 database, queues and Durable Object, and deploys the Worker. It asks for one secret,
   `ADMIN_TOKEN` (any long random string, e.g. `openssl rand -hex 32`); it protects `/setup` and `/admin`.
2. Open `https://<your-worker>.workers.dev/setup` and enter the `ADMIN_TOKEN`.
3. **Hermes poller**: press *Generate new secret* and copy it (it is shown once).
4. **Webhooks**: for each provider, paste the URL shown by the page into the provider and save the signing
   secret the provider gives you (table below).
5. **OAuth** (optional, for Linear and Slack API access): create an OAuth app at the provider with the
   redirect URL shown on the page, save its client id and secret, and press *Connect*.

Secrets typed into `/setup` are stored encrypted in the Durable Object. A Worker secret with the same
name (`wrangler secret put NAME`, or the dashboard) always wins over the stored value. The encryption key
is generated on first use and kept in the Durable Object; set `OAUTH_ENCRYPTION_KEY` (32 bytes, base64 or
hex) as a Worker secret if you prefer to hold it yourself.

| Provider | Webhook URL | Secret name | Events the default subscriptions use |
|---|---|---|---|
| GitHub (App or repo webhook) | `/github` | `GITHUB_WEBHOOK_SECRET` | `pull_request` (`review_requested`), `check_run` (`created`, `completed`), `issue_comment` (`created`) |
| Linear | `/linear` | `LINEAR_WEBHOOK_SECRET` | `Issue` created / updated / assigned |
| Stripe | `/stripe` | `STRIPE_WEBHOOK_SECRET` (`whsec_…`) | `invoice.payment_succeeded` |
| Slack (Events API Request URL) | `/slack` | `SLACK_SIGNING_SECRET` | `app_mention` |

Slack's URL verification challenge is answered automatically once the signing secret is saved.

### GitHub: reviews by agents, no polling

Agents that are GitHub Apps cannot be picked as pull request reviewers. The defaults support two ways to
ask them, both event driven:

- **Review check.** A workflow (or anything with the agent's App token) creates a check run named
  `review/<agent>` in `queued` on the PR head. `check_run.created` reaches `github-check-queued`; when the
  agent finishes, `check_run.completed` reaches `github-check-completed` (use it to update a merge gate).
  Every other check (CI, linters) is dropped in the Worker by the subscription's `match`.
- **Comment command.** `/<agent> review` as the first words of a comment on a pull request reaches
  `github-review-command`. The comment is untrusted input: check `comment.author_association` in your
  handler.

### GitHub: red CI, security alerts, PR reviews

- `github-ci-failed`: `workflow_run.completed` with `conclusion=failure`, dropped in the Worker when
  `workflow_run.head_repository.fork` is true (fork PRs). Needs the `Workflow run` event (Actions: read).
- `github-dependabot-alert` (`created`, `reopened`), `github-code-scanning-alert` (`created`,
  `appeared_in_branch`) and `github-secret-scanning-alert` (`created`): one delivery per alert event. The
  secret scanning prompt carries the type, never the secret; keep it that way in your own subscriptions.
- `github-pr-review`: `pull_request_review.submitted`/`.dismissed`, without the review body (untrusted text).

An App that has `checks: read` receives `created`/`completed` for every check run in the repositories it is
installed on. Point each App's webhook at `/github` with the same secret, or give one App the events: the
Worker deduplicates by `X-GitHub-Delivery`, and two Apps get two deliveries of one event, so handlers must be
idempotent.

## Connect Hermes

The [Hermes](https://hermes-agent.nousresearch.com) gateway plugin lives in `hermes-plugin/`:

```sh
hermes plugins install https://github.com/viniciustrindade/hermesq#hermes-plugin
# add both lines to the profile's .env (its path: `hermes config env-path`)
HERMESQ_URL=https://<your-worker>.workers.dev
HERMESQ_SECRET=<the secret from /setup>
# then restart the gateway
```

With both variables set the plugin enables a `hermesq` gateway platform by itself
(`platforms.hermesq.extra.url` / `.secret` in `config.yaml` work too). While the gateway runs it long-polls the Worker,
runs each delivery as an agent turn (the subscription's prompt, wrapped by its first installed skill) and
sends the answer to the subscription's target: `log`, or another connected platform (`slack`, `telegram`,
…) using `deliverChatId` or that platform's home channel. Then it acks the delivery. If the target fails,
it acks `failed` and the Worker retries.

Any other host can use the API directly; `hermes-plugin/transfer_client.py` is a dependency-free client
and CLI:

```sh
HERMESQ_SECRET=... python3 hermes-plugin/transfer_client.py poll-once --url https://<worker> --ack delivered
```

### Poll API

Every request is signed with the shared secret (`HERMES_WEBHOOK_SECRET`):

```
X-Hermes-Timestamp: <unix seconds>            (±5 min)
X-Hermes-Signature: sha256=hex(HMAC_SHA256(secret, "<ts>.<METHOD>.<path?query>.<body>"))
X-Hermes-Consumer:  <stable id of this host>
```

- `GET /hermes/poll?limit=10&wait=5000` holds up to `wait` ms (capped by `HERMES_LONG_POLL_MS`, default
  5000), claims up to `limit` ready deliveries for this consumer and returns `{ deliveries, cursor }`.
  A claim is a lease of `HERMES_LEASE_SECONDS` (default 300); without an ack it returns to the queue.
- `POST /hermes/ack` with `{"deliveryId": "...", "status": "delivered" | "failed", "result": <any>}`.
  `failed` retries after 1 s, 2 s, 4 s… until `MAX_ATTEMPTS` (default 3), then the delivery becomes a
  `dead-letter`.

### Push API (WebSocket)

Instead of polling, a host can open one outbound WebSocket and receive GitHub and Linear events as they
arrive, like a durable RabbitMQ queue. The Worker does not know how many machines there are: whoever connects
and declares what it wants gets it. The poll API above is unchanged.

```
GET /ws?consumer=<name>&filter=repo:infra,ref:main&filter=linear:abc-123     (Upgrade: websocket)
```

Signed like every request of the poll API (`X-Hermes-Timestamp` and `X-Hermes-Signature` over `GET /ws?<query>`
with an empty body, so the consumer and the filters cannot be changed in transit). `consumer` is a lowercase
name (`[a-z0-9-]`, up to 64) and **routes, it does not authorize**: any host that holds the shared secret can
use any name. One socket per consumer; a new connection closes the old one with code `4001` (a client that
gets `4001` must not reconnect on its own, another process took the name).

**Tags.** Every event is stored with tags derived from its payload, lowercase: `source:<github|linear>`,
`type:<push|pull_request|issue|…>`, `repo:<name>` and `ref:<branch>` when the payload has them, and one
`linear:abc-<n>` for each `ABC-<n>` found in the branch name, PR title or body, push commit messages, or the
issue identifier of a Linear event. Only the team keys listed in the Worker secret `LINEAR_TEAM_KEYS`
(comma separated, each `[a-z][a-z0-9]{0,9}`, case-insensitive; example `abc,xyz`) produce a `linear:` tag; empty or
unset means no `linear:` tag. The hub accepts events of any branch: publishing never filters.

**Filters.** The subscriber sends a list of filters. A filter is a comma list of tags that must all match (AND);
the event is delivered when any filter matches (OR). `*` in the value is a glob (`ref:release/*`, `repo:*`).
At most 20 filters of 8 tags each, and 1800 bytes in all (they live in the socket's 2 KiB attachment, not in
the Hibernation tags, which are limited to 10).

Messages (JSON text frames):

| direction | message | meaning |
| --- | --- | --- |
| client → hub | `{"op":"hello","last_id":N}` | Replay what was missed after `N` (omit `last_id` to continue from the consumer's cursor; a consumer never seen before starts at the head). Live events only start after the hello. |
| hub → client | `{"op":"event","id":N,"source","eventKey","eventTypes","tags","payload","receivedAt"}` | One event; `id` grows with the log. |
| hub → client | `{"op":"ready","consumer","filters","last_ack","replayed":N}` | The replay is over; the socket is live. |
| client → hub | `{"op":"ack","id":N}` | Moves the cursor of this consumer to `N` (only forward). Without an ack nothing is resent until the next hello. |
| hub → client | `{"op":"error","reason":"unknown_op"\|"invalid_ack"}` | The socket stays open. |

Keepalive: send the text `ping`; the runtime answers `pong` without waking the Durable Object. The log keeps
7 days of events (a Durable Object alarm drops the older ones); the replay runs only when a client says hello.
A deploy that changes the code of the Durable Object drops the sockets: clients reconnect and say hello.
Stripe and Slack events are not published to the hub.

### Repository sync in the Hermes plugin

The plugin keeps the existing `/hermes/poll` path for ordinary subscriptions (`github-events.sh` and
`hermesq watch` are unchanged). For repo sync, it opens a separate **outbound** `/ws` subscription while
the gateway runs; it does not start a timer, another process, or an agent turn. Install the plugin and copy
`hermes-plugin/sync-repo.sh` **and** `hermes-plugin/sync-repo.ts` together into
`<HERMES_HOME>/scripts/`. The wrapper only calls `node` (>= 22.18); TypeScript runs directly.

```sh
# Set these in the gateway profile environment, then restart its gateway:
HERMESQ_WS_FILTERS='source:github,type:push,repo:*;source:github,repo:example,ref:release/*'
HERMESQ_FILTERS='github-events.sh,sync-repo.sh'
HERMESQ_CONSUMER='hermes-host-a' # optional; default hermes-<hostname>, lowercase
HERMESQ_SYNC_ORG='example-org' # required: GitHub org or user whose repos may sync
HERMESQ_SYNC_ROOT='/path/to/clones' # required: directory containing your clones
HERMESQ_REPO_OWNERS='example=operator,*=fallback' # assignee per repo; `*` is the default
HERMESQ_SYNC_CARD_PREFIX='' # optional prefix for failure card titles and bodies
HERMESQ_SYNC_CREDENTIAL_HELPER='/absolute/path/to/git-credential-helper.ts'
SYNC_APP_ENV='/path/to/app.env' # helper's secure 0600 file, provisioned on this machine
```

Each semicolon-separated group in `HERMESQ_WS_FILTERS` is OR; its comma-separated tags are AND; `*`
is a value glob. Only `source:github` push events with matching `repo:<name>` and `ref:<branch>` and a
`<HERMESQ_SYNC_ORG>/<name>` payload can sync. Other refs only fetch; `main`/`develop` fast-forward an existing,
clean local branch after `git fetch --prune origin`. Clones are located by raw `origin` (SSH or HTTPS) under
`HERMESQ_SYNC_ROOT`. No reset, merge or checkout. A missing `HERMESQ_SYNC_ORG` or `HERMESQ_SYNC_ROOT` exits 1 with
one line naming the variable, and no card is created. Persistent failures
create one idempotent Kanban card `sync-<repo>-<branch>` for the mapped owner; success creates none.

The optional credential helper uses a GitHub App configured in `SYNC_APP_ENV`, not a personal token.
It reads `GH_APP_ID` and `GH_APP_PEM_B64` from this 0600 file, not from the process environment.
Provision the file securely on each authorized host; sharing a PEM increases the blast radius
(a compromised host can mint tokens). Request only `contents: read` when minting installation
tokens, or use a read-only installation until the helper supports permission reduction.
Without the helper, fetch uses unauthenticated host git: the personal `gh`/keyring helper
is disabled, and SSH origins are rewritten to HTTPS. A private repo without App access therefore creates
a failure card rather than using personal credentials. The WebSocket cursor lives at
`<HERMES_HOME>/hermesq-ws-<consumer>.cursor` with mode 0600; reconnect sends `hello {last_id}` and
acknowledges events only after the local filter returns `[SILENT]`. Keep the consumer stable for replay.

## Subscriptions

A subscription maps event types to a prompt. They live in KV (`subscriptions:list`), so changing them
needs no redeploy. Until you save a list, the built-in defaults in `src/subscriptions/defaults.ts` apply.

```json
[
  {
    "name": "slack-mention",
    "events": ["app_mention"],
    "prompt": "Slack mention from {event.user} in {event.channel}: {event.text}",
    "skills": [],
    "deliver": "slack",
    "deliverChatId": "<channel-id>",
    "enabled": true
  }
]
```

- `events`: any of the types the Worker derives, e.g. GitHub `pull_request`, `pull_request.review_requested`
  and `pull_request_review_requested`; Linear `Issue`, `Issue.create`, `Issue.created`, `Issue.assigned`;
  Stripe and Slack event types. `*` matches everything.
- `prompt`: `{path.to.field}` placeholders read the provider payload (`{payload.x}` works too; missing fields
  render empty, objects as JSON).
- `match` (optional): `{ "path.in.payload": "glob" | ["glob", ...] }`. Every path must hold a string,
  number or boolean that matches one of its patterns (`*` = any run of characters, anchored at both ends;
  everything else is literal; consecutive `*` count as one and a pattern with more than 8 `*` is refused).
  A missing field never matches, not even `*`. Example:
  `{ "check_run.name": "review/*", "check_run.status": "queued" }`.
- `filterScript` (optional): the **name** of a script on the agent host (the Worker never sends code). The
  Hermes plugin looks it up directly in `HERMESQ_SCRIPTS_DIR` (default `<HERMES_HOME>/scripts`,
  the cron scripts folder; `.sh`/`.bash` run with bash, `.py` with Hermes' Python) and only runs names listed
  in `HERMESQ_FILTERS` (comma-separated, default `github-events.sh`), writes the delivery JSON
  to its stdin and reads stdout: `[SILENT]` = the script handled the event (no agent turn, ack `delivered`);
  other text = the prompt for the agent turn; empty = keep the subscription's prompt. Non-zero exit or a
  timeout (`HERMESQ_FILTER_TIMEOUT`, default 120 s) acks `failed` and the Worker retries, so make
  the script idempotent. Its environment is an allowlist (`PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`,
  `HERMES_*`); if it cannot be built the script does not run. stdout and stderr are capped at 64 KiB each.
- `consumer` (optional, `^[a-z0-9][a-z0-9-]{0,63}$`): the deliveries of this subscription go only to the poller
  whose `X-Hermes-Consumer` is the same value; without it any consumer may claim them (the queue is competing
  consumers). One subscription per host makes an event reach every host. It routes, it does not authorize: the
  header is declared by the client and every host shares the same `HERMES_WEBHOOK_SECRET`.
  Existing D1 databases get the new `deliveries.consumer` column on first use, with no migration step.

```sh
ADMIN_TOKEN=... npm run seed -- --url https://<worker> --file my-subscriptions.json
ADMIN_TOKEN=... npm run seed -- --url https://<worker> --defaults
```

## Operating it

| Endpoint (Bearer `ADMIN_TOKEN`) | |
|---|---|
| `GET /admin/deliveries?status=dead-letter` | list deliveries by status |
| `GET /admin/deliveries/:id` · `POST /admin/deliveries/:id/requeue` | inspect / reprocess (fresh attempt budget) |
| `GET` · `PUT /admin/subscriptions` | read / replace the subscription list |
| `GET /oauth/status` · `GET /oauth/health` | connected services; expiry, `needs_refresh`, `needs_reconnect`, last error |
| `POST /oauth/refresh?service=linear` | refresh now |
| `POST /oauth/reconnect?service=linear` | drop tokens, start a new authorization |
| `POST /oauth/disconnect?service=linear` | revoke at the provider and forget the tokens |

Dead letters are also written to KV (`delivery:<id>` and `event:<service>:<id>`) without a TTL. `wrangler
tail` shows one JSON log line per accepted, rejected, retried or dead-lettered event. The hourly cron
refreshes due OAuth tokens, returns expired leases to the queue and prunes the 7-day dedupe index.

### Monitor

The plugin ships `hermes hermesq watch`, a cron-friendly check (no LLM) that prints nothing and exits 0 when
healthy. It calls `/health` and reads the last 50 deliveries; it prints one line and exits 1 on `failed`,
`dead-letter` or anything `pending`/`processing` for more than 10 minutes. It needs Node >= 22.18 (it runs
`hermes-plugin/watch.ts` with type stripping, no build), `HERMESQ_URL` and the admin token
(`HERMESQ_ADMIN_TOKEN`, or `HERMESQ_ADMIN_TOKEN_FILE`, default `~/.config/hermesq/admin_token`).

It runs from a host cron, outside the gateway, so it still alerts when the gateway is down. A Hermes cron
script must be a regular file inside `~/.hermes/scripts/` (a symlink pointing outside is refused):

```sh
# install: the plugin + one cron
hermes plugins install https://github.com/viniciustrindade/hermesq#hermes-plugin
printf '#!/bin/sh\nexec hermes hermesq watch\n' > ~/.hermes/scripts/hermesq-watch.sh
chmod +x ~/.hermes/scripts/hermesq-watch.sh
hermes cron create every 10m --name hermesq-watch --script hermesq-watch.sh --no-agent --deliver origin

# uninstall
hermes cron remove <id>   # id from `hermes cron list`
rm ~/.hermes/scripts/hermesq-watch.sh
hermes plugins remove hermesq
```

## Deploy

The `staging` GitHub Environment (Settings, Environments) needs exactly this before `cd.yml` can deploy:

| Kind | Name | Notes |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | API token with **edit** permission on Workers Scripts, Queues, KV and D1 |
| secret | `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account that owns the Worker |
| variable | `WORKER_URL` | public URL of the Worker, used by the health check (`GET /health`) |

If a secret is missing the deploy job stops in its first step, naming the missing variable (never a value), instead of failing
queue by queue. A token that can deploy production does not isolate staging: scope the token to what the environment
needs, or use a separate token per environment (a separate `production` Environment with required reviewers).

## CI/CD (for forks that deploy from GitHub Actions)

- `ci.yml`: job `checks` (the required status check on `main`): lint, typecheck, unit tests (inside `workerd`),
  poller tests and build; after it, `integration-test` against `wrangler dev --local` and `mutation`, a check
  that breaks each mechanism and expects a test to fail.
- `cd.yml`: on push to `main`, CI then deploy to the `staging` environment (`wrangler deploy --env staging`).
  `workflow_dispatch` with `environment: production` deploys the top-level Worker; protect the `production`
  GitHub Environment with required reviewers so each run waits for approval. `action: uninstall` deletes the
  Worker (KV, D1 and queues are kept; delete them in the dashboard).
- Per Environment: secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts, KV, D1, Queues: edit) and
  `CLOUDFLARE_ACCOUNT_ID`; variable `WORKER_URL` (used by the health check). Nothing else: the webhook,
  OAuth and Hermes secrets belong to `/setup` or Worker secrets.

## Development

```sh
npm ci
npm test                  # unit tests in workerd (miniflare): KV, D1, Queues, Durable Object
npm run test:integration  # starts wrangler dev --local + a scripted OAuth provider
npm run test:poller       # Python client (stdlib)
npm run test:mutation     # every mutant must make the suite fail
HERMES_PYTHON=<hermes venv>/bin/python npm run test:plugin   # gateway adapter, needs a Hermes checkout
npm run lint && npm run typecheck && npm run build
```

Signature tests use the providers' published vectors (GitHub, Slack) and output of Stripe's official SDK;
OAuth tests use responses recorded from the real Linear and Slack endpoints (`test/fixtures/providers.ts`).
GitHub service tests post payloads GitHub really sent, recorded by octokit/webhooks (`test/fixtures/github/`).

## Security notes

- Unsigned, mis-signed or stale requests get `401` and are never stored. Bodies above 1 MiB get `413`.
- `/setup` is a static page; every action goes through the admin API with the `ADMIN_TOKEN` you keep in the
  tab (session storage). The OAuth `state` is random, single use and expires after 10 minutes.
- Refresh tokens rotate on every refresh; concurrent refreshes share one provider call.
- The poller authenticates every request with an HMAC over method, path, query and body, so a captured
  request cannot be replayed after 5 minutes or reused for another path.

## Not included

Discord, a subscription UI, per-client rate limits (use Cloudflare's WAF), custom domains, metrics export.

## License

MIT, see [LICENSE](LICENSE).
