# hermesQ Hermes gateway plugin

The gateway keeps the existing `/hermes/poll` consumer for ordinary subscriptions. Repository sync uses
an outbound `/ws` connection in the same adapter; no timer, separate daemon or agent turn. See the
[root README](../README.md#repository-sync-in-the-hermes-plugin) for the full protocol.

Copy `sync-repo.sh` and `sync-repo.ts` **together** into `<HERMES_HOME>/scripts/` (Node >= 22.18).
The shell wrapper only calls Node; the TypeScript logic is directly testable.

| Environment | Purpose |
| --- | --- |
| `HERMESQ_URL`, `HERMESQ_SECRET` | Worker origin and shared HMAC secret. |
| `HERMESQ_CONSUMER` | Stable consumer name (default `hermes-<hostname>`). |
| `HERMESQ_WS_FILTERS` | Semicolon = OR of filters; comma = AND of tags. Example: `source:github,type:push,repo:*;source:github,repo:example,ref:release/*`. |
| `HERMESQ_FILTERS` | Allowlist; add `sync-repo.sh` alongside `github-events.sh`. |
| `HERMESQ_SYNC_ORG` | Required. GitHub org or user whose repos may sync; the `origin` match is built from it. |
| `HERMESQ_SYNC_ROOT` | Required, no default. Directory containing your clones. |
| `HERMESQ_REPO_OWNERS` | `repo=operator,...` for failure cards; `*=operator` is the default. A repo with no entry and no `*` is an error. |
| `HERMESQ_SYNC_CARD_PREFIX` | Optional prefix for failure card titles and bodies; empty by default. |
| `HERMESQ_SYNC_CREDENTIAL_HELPER` | Absolute path to an optional GitHub App credential helper. |
| `SYNC_APP_ENV` | Secure 0600 file with `GH_APP_ID` and `GH_APP_PEM_B64` for a read-only GitHub App; the helper reads the file, not raw env credentials. |

The script never uses `gh` or the personal keyring. Without the helper, GitHub SSH URLs are rewritten to
HTTPS and the host git fetch has its credential helpers disabled; inaccessible private repos get an
idempotent Kanban failure card (`sync-<repo>-<branch>`). On success there is no card. All events print
`[SILENT]` and exit 0. Only clean existing `main`/`develop` branches fast-forward; other refs only fetch.
The WS cursor is stored at `<HERMES_HOME>/hermesq-ws-<consumer>.cursor` with 0600 permissions; replay
resumes from the last locally acknowledged event. WS keepalive uses protocol ping/pong every 20 seconds.

Provision the GitHub App credential file only on hosts authorized to sync private repositories.
The helper reads the 0600 file; never commit or paste its PEM or put the secret in the gateway
process environment. Sharing a PEM increases exposure because any holder can mint App tokens.
If an installation has write access, request `contents: read` when minting the token, or provision
only a read-only installation until the helper supports reduced permissions.
