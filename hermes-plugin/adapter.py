"""Hermes gateway platform: pulls webhook deliveries from a hermesQ Worker.

No inbound port: the adapter long-polls ``GET /hermes/poll`` (outbound HTTPS) while the gateway runs,
turns each delivery into an agent turn (prompt + skills from the Worker's subscription) and, when the
agent answers, sends the answer to the delivery target (``log`` or another connected platform such as
``slack`` / ``telegram``) and acks the delivery. Failures ack ``failed``; the Worker retries with backoff
and dead-letters after the subscription's max attempts. A turn that never answers is retried when its
lease ends (``HERMES_LEASE_SECONDS`` on the Worker).

Env (or ``platforms.hermesq.extra`` in config.yaml): HERMESQ_URL, HERMESQ_SECRET
(the Worker's HERMES_WEBHOOK_SECRET), optional HERMESQ_CONSUMER (stable host id; default
``hermes-<hostname>``), HERMESQ_POLL_LIMIT (default 10), HERMESQ_SCRIPTS_DIR (where
``filterScript`` names are looked up; default ``<HERMES_HOME>/scripts``, the cron scripts folder),
HERMESQ_FILTERS (comma-separated names ``filterScript`` may run; default ``github-events.sh``) and
HERMESQ_FILTER_TIMEOUT (seconds, default 120).

``filterScript``: the subscription names a script (``.sh``/``.bash`` run by bash, ``.py`` by this Python)
that must be in HERMESQ_FILTERS and sit directly in the scripts dir; the Worker never sends code,
only the name. The script gets the delivery JSON on stdin and answers on stdout: ``[SILENT]`` = it handled
the event itself (no agent turn; ack ``delivered``), other text = the prompt for the turn, empty = keep the
subscription's prompt. A non-zero exit or a timeout acks ``failed``, so the Worker retries with backoff
(the script must be idempotent). The script's environment is an allowlist (PATH, HOME, USER, LANG, LC_ALL,
TZ and HERMES_*): the poller's secret and any other credential stay out, and if the environment cannot be
built the script does not run. Its stdout/stderr are capped at 64 KiB each.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms._shared import extra_or_secret as _extra_or_secret
from gateway.platforms._shared import get_scoped_secret as _get_scoped_secret
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType

from . import transfer_client as tc
from .ws_client import WsClient
from .cli import register_cli

logger = logging.getLogger(__name__)

PLATFORM_NAME = "hermesq"
CHAT_PREFIX = "wt:"
INFLIGHT_TTL_SECONDS = 3600  # forget a delivery whose turn never answered (the Worker lease retries it)
SILENT = "[SILENT]"
DEFAULT_FILTER_TIMEOUT = 120
DEFAULT_FILTERS = ("github-events.sh",)
FILTER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
FILTER_INTERPRETERS = {".sh": "bash", ".bash": "bash", ".py": "python"}
ENV_ALLOWED = ("PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ")
ENV_ALLOWED_PREFIX = "HERMES_"
MAX_OUTPUT = 64 * 1024  # bytes kept from the script's stdout and stderr each
CLEANUP_TIMEOUT = 5  # seconds to reap a killed script whose grandchild still holds the pipes
ERROR_TAIL = 500


class FilterError(Exception):
    """The filter script could not run or failed; the delivery is acked ``failed``."""


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # outside a Hermes install (plain tests)
        return Path(os.path.expanduser("~/.hermes"))


def _default_scripts_dir() -> Path:
    return _hermes_home() / "scripts"


def _script_env(*, sync: bool = False) -> dict:
    try:
        from tools.environments.local import build_subprocess_env

        base = build_subprocess_env()
    except Exception as err:  # fail closed: never fall back to os.environ; the type only, a message could carry a value
        raise FilterError(f"filter environment could not be built ({type(err).__name__}); filter not run") from None
    result = {k: v for k, v in base.items() if k in ENV_ALLOWED or k.startswith(ENV_ALLOWED_PREFIX)}
    if sync:
        # Only the sync filter needs the local App file path and owner map; other filters never see them.
        for key in ('HERMESQ_SYNC_ROOT', 'HERMESQ_SYNC_CREDENTIAL_HELPER', 'HERMESQ_REPO_OWNERS', 'SYNC_APP_ENV'):
            if key in os.environ:
                result[key] = os.environ[key]
    return result


def parse_filters(raw: Optional[str]) -> tuple:
    """HERMESQ_FILTERS (comma-separated) → names; empty or unset = the default."""
    names = tuple(n.strip() for n in str(raw or "").split(",") if n.strip())
    return names or DEFAULT_FILTERS


def resolve_filter(scripts_dir: Path, name: str, allowed: tuple = DEFAULT_FILTERS) -> list:
    """argv for a filter script, or FilterError. Only an allowlisted bare file name directly in ``scripts_dir``."""
    if not isinstance(name, str) or not FILTER_NAME.fullmatch(name):
        raise FilterError(f"filterScript {name!r} refused: only a file name in {scripts_dir}")
    if name not in allowed:
        raise FilterError(f"filterScript {name!r} refused: not in HERMESQ_FILTERS")
    kind = FILTER_INTERPRETERS.get(Path(name).suffix.lower())
    if kind is None:
        raise FilterError(f"filterScript {name!r} refused: only .sh, .bash or .py")
    base = scripts_dir.resolve()
    path = (base / name).resolve()
    if path.parent != base or not path.is_file():
        raise FilterError(f"filterScript {name!r} not found in {base}")
    return ["bash", str(path)] if kind == "bash" else [sys.executable, "-I", str(path)]


def _capped(text: Optional[str], name: str, stream: str) -> str:
    data = (text or "").encode("utf-8", "replace")
    if len(data) <= MAX_OUTPUT:
        return text or ""
    logger.warning("[hermesq] filterScript %s %s truncated: %d bytes dropped", name, stream, len(data) - MAX_OUTPUT)
    return data[:MAX_OUTPUT].decode("utf-8", "ignore")


def run_filter(scripts_dir: Path, name: str, delivery: dict, timeout: float, allowed: tuple = DEFAULT_FILTERS) -> str:
    """Runs the filter with the delivery on stdin; returns its stripped stdout."""
    argv = resolve_filter(scripts_dir, name, allowed)
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace",
                                cwd=str(scripts_dir), env=_script_env(sync=name == 'sync-repo.sh'), start_new_session=True)
    except OSError as err:
        raise FilterError(f"filterScript {name} could not start: {err}") from None
    try:
        stdout, stderr = proc.communicate(json.dumps(delivery), timeout=timeout)
    except subprocess.TimeoutExpired:
        # The whole process group: a grandchild (e.g. `sleep`) would keep the pipes open otherwise.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            proc.communicate(timeout=CLEANUP_TIMEOUT)
        except subprocess.TimeoutExpired:  # a grandchild in another session still holds the pipes
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                if pipe:
                    pipe.close()
        raise FilterError(f"filterScript {name} timed out after {timeout:g}s") from None
    stdout, stderr = _capped(stdout, name, "stdout"), _capped(stderr, name, "stderr")
    if proc.returncode != 0:
        tail = (stderr or stdout or "").strip()[-ERROR_TAIL:]
        raise FilterError(f"filterScript {name} exit {proc.returncode}: {tail}")
    return (stdout or "").strip()


def check_requirements() -> bool:
    return bool(_get_scoped_secret("HERMESQ_URL", "").strip() and _get_scoped_secret("HERMESQ_SECRET", "").strip())


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool(_extra_or_secret(extra, "url", "HERMESQ_URL") and _extra_or_secret(extra, "secret", "HERMESQ_SECRET"))


def is_connected(config) -> bool:
    return validate_config(config)


def env_enablement() -> Optional[dict]:
    """Enables the platform from the profile's env alone (no config.yaml block needed)."""
    url = _get_scoped_secret("HERMESQ_URL", "").strip()
    secret = _get_scoped_secret("HERMESQ_SECRET", "").strip()
    if not url or not secret:
        return None
    extra = {"url": url.rstrip("/"), "secret": secret}
    consumer = _get_scoped_secret("HERMESQ_CONSUMER", "").strip()
    if consumer:
        extra["consumer"] = consumer
    return extra


def apply_skills(prompt: str, skills: list) -> str:
    """Same rule as the built-in webhook platform: the first installed skill wraps the prompt."""
    try:
        from agent.skill_commands import build_skill_invocation_message, get_skill_commands

        commands = get_skill_commands()
        for name in skills or []:
            key = f"/{name}"
            if key in commands:
                wrapped = build_skill_invocation_message(key, user_instruction=prompt)
                if wrapped:
                    return wrapped
            else:
                logger.warning("[hermesq] skill '%s' not installed; sending the bare prompt", name)
    except Exception as err:  # skill loading must never drop a delivery
        logger.warning("[hermesq] skill loading failed: %s", err)
    return prompt


class HermesQAdapter(BasePlatformAdapter):
    MAX_MESSAGE_LENGTH = 100_000

    def __init__(self, config: PlatformConfig, client: Optional[tc.TransferClient] = None):
        super().__init__(config=config, platform=Platform(PLATFORM_NAME))
        extra = config.extra or {}
        self._url = _extra_or_secret(extra, "url", "HERMESQ_URL")
        self._secret = _extra_or_secret(extra, "secret", "HERMESQ_SECRET")
        self._consumer = _extra_or_secret(extra, "consumer", "HERMESQ_CONSUMER") or None
        try:
            self._limit = int(_extra_or_secret(extra, "poll_limit", "HERMESQ_POLL_LIMIT", tc.DEFAULT_LIMIT))
        except (TypeError, ValueError):
            self._limit = tc.DEFAULT_LIMIT
        scripts_dir = _extra_or_secret(extra, "scripts_dir", "HERMESQ_SCRIPTS_DIR")
        self._scripts_dir = Path(os.path.expanduser(scripts_dir)) if scripts_dir else _default_scripts_dir()
        self._filters = parse_filters(_extra_or_secret(extra, "filters", "HERMESQ_FILTERS"))
        self._ws_filters = _extra_or_secret(extra, "ws_filters", "HERMESQ_WS_FILTERS")
        try:
            self._filter_timeout = float(_extra_or_secret(extra, "filter_timeout", "HERMESQ_FILTER_TIMEOUT", DEFAULT_FILTER_TIMEOUT))
        except (TypeError, ValueError):
            self._filter_timeout = float(DEFAULT_FILTER_TIMEOUT)
        self._client = client
        self._stop: Optional[asyncio.Event] = None
        self._task: Optional[asyncio.Task] = None
        self._ws_task: Optional[asyncio.Task] = None
        self._inflight: dict[str, tuple[float, dict]] = {}

    # -- lifecycle ------------------------------------------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if self._client is None:
            if not self._url or not self._secret:
                logger.warning("[hermesq] HERMESQ_URL / HERMESQ_SECRET not configured")
                return False
            self._client = tc.TransferClient(self._url, self._secret, self._consumer)
        self._stop = asyncio.Event()
        if self._ws_filters:
            try:
                resolve_filter(self._scripts_dir, 'sync-repo.sh', self._filters)
                if not shutil.which('node') or not (self._scripts_dir / 'sync-repo.ts').is_file():
                    raise FilterError('sync-repo requires node and sync-repo.ts beside the wrapper')
                groups = [[tag.strip() for tag in group.split(',')] for group in self._ws_filters.split(';') if group.strip()]
                socket = WsClient(self._url, self._secret, self._client.consumer, groups, _hermes_home())
            except FilterError as err:
                logger.error('[hermesq] WS sync disabled: %s', err)
            except ValueError as err:
                logger.error('[hermesq] WS sync disabled: %s', err)
            else:
                self._ws_task = asyncio.create_task(socket.run(self._on_ws_event, self._stop))
        self._task = asyncio.create_task(tc.run_loop(self._client, self._on_delivery, self._stop, limit=self._limit, on_fatal=self._on_fatal))
        self._mark_connected()
        self._wire_plugin_handlers(None)
        logger.info("[hermesq] polling %s as %s", self._client.base_url, self._client.consumer)
        return True

    def _on_fatal(self, err: tc.TransferError) -> None:
        self._set_fatal_error("hermesq_refused", f"Worker refused the poller: {err}. Check HERMESQ_SECRET.", retryable=False)

    async def disconnect(self) -> None:
        if self._stop:
            self._stop.set()
        for task in (self._task, self._ws_task):
            if not task:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._task = self._ws_task = None
        self._mark_disconnected()

    async def _on_ws_event(self, event: dict) -> None:
        """Sync is a local filter action, never an agent turn or a poll delivery."""
        delivery = {**event, 'deliveryId': str(event['id']), 'filterScript': 'sync-repo.sh'}
        output = await asyncio.to_thread(run_filter, self._scripts_dir, 'sync-repo.sh', delivery,
                                         self._filter_timeout, self._filters)
        if output != SILENT:
            raise FilterError('sync-repo.sh must return [SILENT]')

    # -- inbound --------------------------------------------------------------------------------

    def _prune(self, now: float) -> None:
        for key in [k for k, (at, _) in self._inflight.items() if now - at > INFLIGHT_TTL_SECONDS]:
            self._inflight.pop(key, None)

    async def _ack_quietly(self, delivery_id: str, status: str, result: dict) -> None:
        try:
            await asyncio.to_thread(self._client.ack, delivery_id, status, result)
        except Exception:
            logger.exception("[hermesq] ack did not reach the Worker for %s; the lease will retry it", delivery_id)

    async def _on_delivery(self, delivery: dict) -> None:
        delivery_id = delivery["deliveryId"]
        name = delivery.get("filterScript")
        if name:
            try:
                out = await asyncio.to_thread(run_filter, self._scripts_dir, name, delivery, self._filter_timeout, self._filters)
            except FilterError as err:
                logger.warning("[hermesq] %s: %s", delivery_id, err)
                await self._ack_quietly(delivery_id, "failed", {"error": str(err)})
                return
            if out == SILENT:
                await self._ack_quietly(delivery_id, "delivered", {"filter": name, "outcome": "silent"})
                return
            if out:
                delivery = {**delivery, "prompt": out}
        chat_id = CHAT_PREFIX + delivery_id
        now = time.monotonic()
        self._prune(now)
        self._inflight[chat_id] = (now, delivery)
        source = self.build_source(
            chat_id=chat_id,
            chat_name=f"hermesq/{delivery.get('subscriptionName', '?')}",
            chat_type="dm",
            user_id="hermesq",
            user_name="hermesq",
            message_id=delivery_id,
        )
        event = MessageEvent(
            text=apply_skills(delivery.get("prompt") or "", delivery.get("skills") or []),
            message_type=MessageType.TEXT,
            source=source,
            message_id=delivery_id,
            raw_message=delivery.get("payload"),
            timestamp=datetime.now(tz=UTC),
        )
        await self.handle_message(event)
        if getattr(event, "_gateway_accepted", None) is False:
            self._inflight.pop(chat_id, None)
            await asyncio.to_thread(self._client.ack, delivery_id, "failed", {"error": "gateway did not accept the turn"})

    # -- outbound -------------------------------------------------------------------------------

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None) -> SendResult:
        entry = self._inflight.pop(chat_id, None)
        if entry is None:
            logger.info("[hermesq] extra message for %s (already acked): %s", chat_id, content[:200])
            return SendResult(success=True)
        delivery = entry[1]
        result = await self._deliver(delivery, content)
        status = "delivered" if result.success else "failed"
        ack_result = {"target": delivery.get("deliver") or "log", "error": result.error}
        try:
            await asyncio.to_thread(self._client.ack, delivery["deliveryId"], status, ack_result)
        except Exception:
            logger.exception("[hermesq] ack did not reach the Worker for %s; the lease will retry it", delivery["deliveryId"])
        return result

    async def _deliver(self, delivery: dict, content: str) -> SendResult:
        target = delivery.get("deliver") or "log"
        if target == "log":
            logger.info("[hermesq] %s -> log: %s", delivery.get("subscriptionName"), content[:500])
            return SendResult(success=True)
        runner = self.gateway_runner
        if runner is None:
            return SendResult(success=False, error="no gateway runner for cross-platform delivery")
        try:
            platform = Platform(target)
        except ValueError:
            return SendResult(success=False, error=f"unknown platform: {target}")
        finder = getattr(runner, "_authorization_adapter", None)
        adapter = finder(platform, None) if callable(finder) else (getattr(runner, "adapters", {}) or {}).get(platform)
        if adapter is None:
            return SendResult(success=False, error=f"platform {target} not connected")
        chat = delivery.get("deliverChatId")
        if not chat:
            home = runner.config.get_home_channel(platform) if getattr(runner, "config", None) else None
            if home is None:
                return SendResult(success=False, error=f"no deliverChatId and no home channel for {target}")
            chat = home.chat_id
        return await adapter.send(str(chat), content)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": chat_id, "type": "dm"}


def register(ctx) -> None:
    ctx.register_platform(
        name=PLATFORM_NAME,
        label="hermesQ",
        adapter_factory=lambda cfg: HermesQAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["HERMESQ_URL", "HERMESQ_SECRET"],
        install_hint="no extra dependency (standard library only)",
        env_enablement_fn=env_enablement,
        dashboard_description="Webhooks from GitHub, Linear, Stripe and Slack through a Cloudflare Worker; this host only polls outbound.",
        # Events are HMAC-verified by the Worker and pulled over an HMAC-signed outbound channel;
        # there is no human sender to allowlist.
        trusted_inbound=True,
        max_message_length=HermesQAdapter.MAX_MESSAGE_LENGTH,
        emoji="🪝",
        platform_hint=(
            "This turn was triggered by a webhook delivered through hermesQ. "
            "Your final answer is delivered to the subscription's target (a log, or a chat). Be concise."
        ),
    )
    register_cli(ctx)
