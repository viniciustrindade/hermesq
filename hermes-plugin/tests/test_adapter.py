"""Adapter tests against the real Hermes gateway classes (BasePlatformAdapter, MessageEvent, Platform).

Needs a Hermes checkout: run with Hermes' own interpreter, e.g.
    HERMES_AGENT_DIR=~/.hermes/hermes-agent <hermes venv>/bin/python -I -m unittest discover -s hermes-plugin/tests -p 'test_adapter.py'
(`npm run test:plugin` does this). Import errors fail the run on purpose: there is no skip path.
"""

import asyncio
import importlib.util
import os
import sys
import time
import unittest
from unittest import mock
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, os.path.expanduser(os.environ.get("HERMES_AGENT_DIR", "~/.hermes/hermes-agent")))

spec = importlib.util.spec_from_file_location("wt_plugin", PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
assert spec and spec.loader
wt_plugin = importlib.util.module_from_spec(spec)
sys.modules["wt_plugin"] = wt_plugin
spec.loader.exec_module(wt_plugin)
adapter_mod = sys.modules["wt_plugin.adapter"]

from gateway.config import Platform, PlatformConfig  # noqa: E402
from gateway.platform_registry import PlatformEntry, platform_registry  # noqa: E402
from gateway.platforms.base import SendResult  # noqa: E402

REGISTERED: list = []


class RegistryCtx:
    """Does what PluginContext.register_platform does: build a real PlatformEntry (unknown keyword
    arguments raise TypeError) and put it in the real registry, so Platform("hermesq") resolves."""

    def register_platform(self, name, label, adapter_factory, check_fn, validate_config=None, required_env=None, install_hint="", **kw):
        entry = PlatformEntry(name=name, label=label, adapter_factory=adapter_factory, check_fn=check_fn, validate_config=validate_config,
                              required_env=required_env or [], install_hint=install_hint, source="plugin", plugin_name="hermesq", **kw)
        platform_registry.register(entry)
        REGISTERED.append(entry)

    def register_cli_command(self, **_kw):
        pass


wt_plugin.register(RegistryCtx())


class StubClient:
    base_url = "https://worker.test"
    consumer = "host-test"

    def __init__(self, pages=()):
        self.pages = list(pages)
        self.acks = []

    def poll(self, limit, wait_ms, cursor):
        if self.pages:
            return self.pages.pop(0)
        return {"deliveries": [], "cursor": cursor}

    def ack(self, delivery_id, status, result=None):
        self.acks.append((delivery_id, status, result))
        return {"deliveryId": delivery_id, "status": status}


class FakeTarget:
    def __init__(self, ok=True):
        self.sent = []
        self.ok = ok

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.sent.append((chat_id, content))
        return SendResult(success=self.ok, error=None if self.ok else "boom")


class FakeHome:
    chat_id = "home-chat"


class FakeConfig:
    def get_home_channel(self, platform):
        return FakeHome()


class FakeRunner:
    def __init__(self, adapters):
        self.adapters = adapters
        self.config = FakeConfig()

    def _authorization_adapter(self, platform, profile=None):
        return self.adapters.get(platform)

    def _profile_name_for_source(self, source, **kw):  # build_source asks the runner for profile routing (adapter_profile=...)
        return None


def delivery(i="d-1", **over):
    d = {"deliveryId": i, "subscriptionName": "linear-issue-synced", "prompt": "Linear ENG-1 create: T", "skills": [], "deliver": "log", "payload": {"x": 1}}
    d.update(over)
    return d


def make(client, accepted=True):
    adapter = adapter_mod.HermesQAdapter(PlatformConfig(enabled=True, extra={"url": "https://worker.test", "secret": "s"}), client=client)
    events = []

    async def handle(event):
        events.append(event)
        event._gateway_accepted = accepted

    adapter.handle_message = handle
    return adapter, events


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_delivery_becomes_an_agent_turn_in_its_own_session(self):
        client = StubClient()
        adapter, events = make(client)
        await adapter._on_delivery(delivery())
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev.text, "Linear ENG-1 create: T")
        self.assertEqual(ev.source.platform, Platform("hermesq"))
        self.assertEqual(ev.source.chat_id, "wt:d-1")
        self.assertEqual(ev.raw_message, {"x": 1})
        self.assertEqual(client.acks, [])  # nothing acked until the agent answers

    async def test_the_answer_is_logged_and_acked_delivered_once(self):
        client = StubClient()
        adapter, _ = make(client)
        await adapter._on_delivery(delivery())
        res = await adapter.send("wt:d-1", "done")
        self.assertTrue(res.success)
        self.assertEqual(client.acks, [("d-1", "delivered", {"target": "log", "error": None})])
        await adapter.send("wt:d-1", "late extra message")
        self.assertEqual(len(client.acks), 1)

    async def test_cross_platform_delivery_uses_the_chat_id_or_the_home_channel(self):
        client = StubClient()
        adapter, _ = make(client)
        slack = FakeTarget()
        adapter.gateway_runner = FakeRunner({Platform("slack"): slack})
        await adapter._on_delivery(delivery("d-2", deliver="slack", deliverChatId="C42"))
        await adapter.send("wt:d-2", "hello")
        await adapter._on_delivery(delivery("d-3", deliver="slack"))
        await adapter.send("wt:d-3", "to home")
        self.assertEqual(slack.sent, [("C42", "hello"), ("home-chat", "to home")])
        self.assertEqual([a[1] for a in client.acks], ["delivered", "delivered"])

    async def test_a_failed_or_impossible_delivery_acks_failed(self):
        client = StubClient()
        adapter, _ = make(client)
        adapter.gateway_runner = FakeRunner({Platform("slack"): FakeTarget(ok=False)})
        await adapter._on_delivery(delivery("d-4", deliver="slack", deliverChatId="C1"))
        await adapter.send("wt:d-4", "x")
        await adapter._on_delivery(delivery("d-5", deliver="telegram", deliverChatId="1"))
        await adapter.send("wt:d-5", "x")
        self.assertEqual(client.acks[0], ("d-4", "failed", {"target": "slack", "error": "boom"}))
        self.assertEqual(client.acks[1], ("d-5", "failed", {"target": "telegram", "error": "platform telegram not connected"}))

    async def test_a_turn_the_gateway_refuses_is_acked_failed_right_away(self):
        client = StubClient()
        adapter, _ = make(client, accepted=False)
        await adapter._on_delivery(delivery("d-6"))
        self.assertEqual(client.acks, [("d-6", "failed", {"error": "gateway did not accept the turn"})])

    async def test_connect_polls_dispatches_and_disconnect_stops(self):
        client = StubClient([{"deliveries": [delivery("d-7")], "cursor": "d-7"}])
        adapter, events = make(client)
        self.assertTrue(await adapter.connect())
        for _ in range(100):
            if events:
                break
            await asyncio.sleep(0.02)
        self.assertEqual([e.source.chat_id for e in events], ["wt:d-7"])
        await adapter.send("wt:d-7", "ok")
        await adapter.disconnect()
        self.assertEqual(client.acks, [("d-7", "delivered", {"target": "log", "error": None})])


class FilterScriptTests(unittest.IsolatedAsyncioTestCase):
    """filterScript names a script in this host's scripts dir. It reads the delivery JSON on stdin and
    decides: ``[SILENT]`` = handled, no agent turn; other text = the prompt; empty = keep the prompt."""

    def setUp(self):
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name) / "scripts"
        self.dir.mkdir()
        os.environ["HERMESQ_SECRET"] = "must-not-leak"

    def tearDown(self):
        for name in ("HERMESQ_SECRET", "GH_APP_PEM_B64", "GH_TOKEN", "UNLISTED_VAR", "HERMES_TEST_MARK", "SYNC_APP_ENV"):
            os.environ.pop(name, None)
        pid_file = self.dir.parent / "grandchild.pid"
        if pid_file.exists():  # the grandchild of the session-escape test outlives its script
            try:
                os.kill(int(pid_file.read_text()), 9)
            except (ProcessLookupError, ValueError):
                pass
        self._tmp.cleanup()

    def script(self, name, body):
        (self.dir / name).write_text(body)
        return name

    # HERMESQ_FILTERS for these tests; github-events.sh (the default) is not in it on purpose.
    ALLOWED = "handle.sh,rewrite.py,pass.sh,boom.sh,hang.sh,tool.rb,nope.sh,x.sh,evil.sh,escape.sh,flood.sh,env.sh"

    def make(self, client, **extra):
        cfg = {"url": "https://worker.test", "secret": "s", "scripts_dir": str(self.dir), "filters": self.ALLOWED, **extra}
        adapter = adapter_mod.HermesQAdapter(PlatformConfig(enabled=True, extra=cfg), client=client)
        events = []

        async def handle(event):
            events.append(event)
            event._gateway_accepted = True

        adapter.handle_message = handle
        return adapter, events

    async def test_silent_means_handled_without_an_agent_turn_and_the_script_got_the_delivery(self):
        name = self.script("handle.sh", 'cat > "$(dirname "$0")/seen.json"\nprintf "%s" "${HERMESQ_SECRET:-absent}" > "$(dirname "$0")/env.txt"\necho "[SILENT]"\n')
        client = StubClient()
        adapter, events = self.make(client)
        await adapter._on_delivery(delivery("f-1", filterScript=name))
        self.assertEqual(events, [])
        self.assertEqual(client.acks, [("f-1", "delivered", {"filter": name, "outcome": "silent"})])
        import json

        self.assertEqual(json.loads((self.dir / "seen.json").read_text())["deliveryId"], "f-1")
        self.assertEqual((self.dir / "env.txt").read_text(), "absent")  # the poller secret never reaches the script

    async def test_text_output_becomes_the_prompt_and_empty_output_keeps_it(self):
        client = StubClient()
        adapter, events = self.make(client)
        await adapter._on_delivery(delivery("f-2", filterScript=self.script("rewrite.py", "import sys, json\nd = json.load(sys.stdin)\nprint('rewritten ' + d['deliveryId'])\n")))
        await adapter._on_delivery(delivery("f-3", filterScript=self.script("pass.sh", "cat > /dev/null\n")))
        self.assertEqual([e.text for e in events], ["rewritten f-2", "Linear ENG-1 create: T"])
        self.assertEqual(client.acks, [])  # acked when the agent answers, as any turn

    async def test_a_failing_script_acks_failed_with_its_exit_code_and_no_turn(self):
        client = StubClient()
        adapter, events = self.make(client)
        await adapter._on_delivery(delivery("f-4", filterScript=self.script("boom.sh", "echo 'kanban create failed' >&2\nexit 5\n")))
        self.assertEqual(events, [])
        (did, status, result), = client.acks
        self.assertEqual((did, status), ("f-4", "failed"))
        self.assertIn("exit 5", result["error"])
        self.assertIn("kanban create failed", result["error"])

    async def test_a_script_outside_the_scripts_dir_or_missing_or_of_unknown_kind_is_refused(self):
        client = StubClient()
        adapter, events = self.make(client)
        (self.dir.parent / "evil.sh").write_text("echo '[SILENT]'\n")
        self.script("tool.rb", "puts 1\n")
        for i, name in enumerate(["../evil.sh", "/bin/sh", "nope.sh", "tool.rb", "sub/x.sh"]):
            await adapter._on_delivery(delivery(f"f-r{i}", filterScript=name))
        self.assertEqual(events, [])
        self.assertEqual([a[1] for a in client.acks], ["failed"] * 5)
        self.assertTrue(all("filterScript" in a[2]["error"] for a in client.acks))

    async def test_a_script_that_hangs_is_killed_at_the_timeout(self):
        client = StubClient()
        adapter, events = self.make(client, filter_timeout="1")
        await adapter._on_delivery(delivery("f-5", filterScript=self.script("hang.sh", "sleep 30\n")))
        self.assertEqual(events, [])
        self.assertEqual(client.acks[0][1], "failed")
        self.assertIn("timed out", client.acks[0][2]["error"])

    # -- M1: only the names in HERMESQ_FILTERS run (default: github-events.sh) -----------

    async def test_a_script_in_the_scripts_dir_that_is_not_in_the_allowlist_is_refused_and_never_runs(self):
        client = StubClient()
        adapter, events = self.make(client)
        marker = self.dir / "ran.txt"
        name = self.script("review-tick.sh", f'echo ran > "{marker}"\necho "[SILENT]"\n')
        await adapter._on_delivery(delivery("m1-1", filterScript=name))
        self.assertFalse(marker.exists())
        self.assertEqual(events, [])
        (did, status, result), = client.acks
        self.assertEqual((did, status), ("m1-1", "failed"))
        self.assertIn("HERMESQ_FILTERS", result["error"])

    async def test_the_default_allowlist_is_github_events_sh_alone(self):
        client = StubClient()
        marker = self.dir / "ran.txt"
        cfg = {"url": "https://worker.test", "secret": "s", "scripts_dir": str(self.dir)}  # no filters configured
        adapter = adapter_mod.HermesQAdapter(PlatformConfig(enabled=True, extra=cfg), client=client)
        self.script("github-events.sh", f'cat > /dev/null\necho ran > "{marker}"\necho "[SILENT]"\n')
        self.script("other.sh", "echo '[SILENT]'\n")
        await adapter._on_delivery(delivery("m1-2", filterScript="github-events.sh"))
        await adapter._on_delivery(delivery("m1-3", filterScript="other.sh"))
        self.assertEqual([(a[0], a[1]) for a in client.acks], [("m1-2", "delivered"), ("m1-3", "failed")])
        self.assertTrue(marker.exists())

    def test_the_allowlist_is_a_comma_separated_list_and_an_allowed_name_still_passes_the_other_checks(self):
        self.assertEqual(adapter_mod.parse_filters(" a.sh, b.py ,,"), ("a.sh", "b.py"))
        self.assertEqual(adapter_mod.parse_filters(None), ("github-events.sh",))
        self.assertEqual(adapter_mod.parse_filters(" , "), ("github-events.sh",))
        (self.dir.parent / "outside.sh").write_text("true\n")
        (self.dir / "link.sh").symlink_to(self.dir.parent / "outside.sh")
        self.script("tool.rb", "puts 1\n")
        for name in ("../outside.sh", "link.sh", "tool.rb", "missing.sh"):
            with self.assertRaises(adapter_mod.FilterError, msg=name):
                adapter_mod.resolve_filter(self.dir, name, (name,))

    # -- M2: the script's environment is an allowlist and fails closed --------------------------

    async def test_the_script_gets_only_allowlisted_variables_never_the_app_key_or_tokens(self):
        os.environ.update({"GH_APP_PEM_B64": "fake-pem", "GH_TOKEN": "fake-token", "UNLISTED_VAR": "x", "HERMES_TEST_MARK": "kept", "SYNC_APP_ENV": "/fake/reader.env"})
        client = StubClient()
        adapter, events = self.make(client)
        out = self.dir / "env.txt"
        name = self.script("env.sh", f'cat > /dev/null\nenv > "{out}"\necho "[SILENT]"\n')
        await adapter._on_delivery(delivery("m2-1", filterScript=name))
        self.assertEqual(client.acks[0][1], "delivered")
        seen = dict(line.split("=", 1) for line in out.read_text().splitlines() if "=" in line)
        for leaked in ("GH_APP_PEM_B64", "GH_TOKEN", "HERMESQ_SECRET", "UNLISTED_VAR", "SYNC_APP_ENV"):
            self.assertNotIn(leaked, seen)
        self.assertNotIn("fake-pem", out.read_text())
        self.assertEqual(seen.get("HERMES_TEST_MARK"), "kept")
        self.assertIn("PATH", seen)
        allowed = {"PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "PWD", "SHLVL", "_", "OLDPWD"}  # PWD/SHLVL/_ are set by bash itself
        self.assertEqual({k for k in seen if k not in allowed and not k.startswith("HERMES_")}, set())

    async def test_if_the_environment_cannot_be_built_the_script_does_not_run_and_the_error_has_no_value(self):
        os.environ["GH_APP_PEM_B64"] = "fake-pem"
        client = StubClient()
        adapter, events = self.make(client)
        marker = self.dir / "ran.txt"
        name = self.script("env.sh", f'echo ran > "{marker}"\necho "[SILENT]"\n')
        with mock.patch("tools.environments.local.build_subprocess_env", side_effect=RuntimeError("leaky fake-pem")):
            with self.assertLogs(adapter_mod.logger, level="DEBUG") as logs:
                await adapter._on_delivery(delivery("m2-2", filterScript=name))
        self.assertFalse(marker.exists())
        self.assertEqual(events, [])
        (did, status, result), = client.acks
        self.assertEqual((did, status), ("m2-2", "failed"))
        self.assertNotIn("fake-pem", result["error"])
        self.assertNotIn("fake-pem", "\n".join(logs.output))

    # -- B5: bounded wait, bounded output, whole-name match -------------------------------------

    async def test_a_grandchild_that_left_the_session_cannot_hold_the_poller_after_the_timeout(self):
        client = StubClient()
        adapter, events = self.make(client, filter_timeout="1")
        pid_file = self.dir.parent / "grandchild.pid"
        name = self.script("escape.sh", f'setsid sleep 30 &\necho $! > "{pid_file}"\nsleep 30\n')  # holds stdout/stderr; killpg does not reach it
        started = time.monotonic()
        with mock.patch.object(adapter_mod, "CLEANUP_TIMEOUT", 1):
            await adapter._on_delivery(delivery("b5-1", filterScript=name))
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(client.acks[0][1], "failed")
        self.assertIn("timed out", client.acks[0][2]["error"])

    async def test_stdout_is_capped_at_64_kib_and_the_excess_is_logged(self):
        client = StubClient()
        adapter, events = self.make(client)
        name = self.script("flood.sh", "cat > /dev/null\nhead -c 200000 /dev/zero | tr '\\0' 'a'\n")
        with self.assertLogs(adapter_mod.logger, level="WARNING") as logs:
            await adapter._on_delivery(delivery("b5-2", filterScript=name))
        self.assertEqual(len(events[0].text), 64 * 1024)
        self.assertTrue(any("stdout" in line and "truncated" in line for line in logs.output))

    def test_a_name_with_a_trailing_newline_is_refused_by_the_name_check(self):
        (self.dir / "x.sh").write_text("true\n")
        with self.assertRaises(adapter_mod.FilterError) as ctx:
            adapter_mod.resolve_filter(self.dir, "x.sh\n", ("x.sh\n",))
        self.assertIn("only a file name", str(ctx.exception))


class SyncSocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_ws_events_run_the_local_filter_and_never_start_an_agent_turn(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'sync-repo.sh').write_text(f'cat > "{root / "seen.json"}"\nenv > "{root / "env.txt"}"\necho "[SILENT]"\n')
            cfg = PlatformConfig(enabled=True, extra={'url': 'https://worker.test', 'secret': 's',
                'scripts_dir': str(root), 'filters': 'github-events.sh,sync-repo.sh',
                'ws_filters': 'source:github,repo:*,ref:*'})
            adapter = adapter_mod.HermesQAdapter(cfg, client=StubClient())
            events = []
            async def handle(event): events.append(event)
            adapter.handle_message = handle
            with mock.patch.dict(os.environ, {'SYNC_APP_ENV': '/fake/reader.env', 'GH_APP_PEM_B64': 'fake-pem'}):
                await adapter._on_ws_event({'op': 'event', 'id': 1, 'tags': ['repo:infra'], 'payload': {}})
            self.assertEqual(events, [])
            self.assertEqual(adapter._client.acks, [])
            import json
            self.assertEqual(json.loads((root / 'seen.json').read_text())['deliveryId'], '1')
            env = (root / 'env.txt').read_text()
            self.assertIn('SYNC_APP_ENV=/fake/reader.env', env)
            self.assertNotIn('GH_APP_PEM_B64', env)

    async def test_connect_disables_invalid_sync_but_keeps_poll_running(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            cfg = PlatformConfig(enabled=True, extra={'url': 'https://worker.test', 'secret': 's',
                'scripts_dir': temp, 'filters': 'github-events.sh,sync-repo.sh', 'ws_filters': 'source:github'})
            adapter = adapter_mod.HermesQAdapter(cfg, client=StubClient())
            with self.assertLogs(adapter_mod.logger, level='ERROR'):
                self.assertTrue(await adapter.connect())
            self.assertIsNotNone(adapter._task)
            self.assertIsNone(adapter._ws_task)
            await adapter.disconnect()

            (Path(temp) / 'sync-repo.sh').write_text('echo "[SILENT]"\n')
            (Path(temp) / 'sync-repo.ts').write_text('// fixture\n')
            cfg.extra['ws_filters'] = 'invalid'
            invalid = adapter_mod.HermesQAdapter(cfg, client=StubClient())
            with self.assertLogs(adapter_mod.logger, level='ERROR'):
                self.assertTrue(await invalid.connect())
            self.assertIsNotNone(invalid._task)
            self.assertIsNone(invalid._ws_task)
            await invalid.disconnect()

    async def test_connect_starts_one_ws_client_with_or_filters_while_poll_stays_running(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / 'sync-repo.sh').write_text('echo "[SILENT]"\n')
            (Path(temp) / 'sync-repo.ts').write_text('// fixture\n')
            cfg = PlatformConfig(enabled=True, extra={'url': 'https://worker.test', 'secret': 's',
                'scripts_dir': temp, 'filters': 'github-events.sh,sync-repo.sh',
                'ws_filters': 'source:github, repo:*;source:github,ref:release/*'})
            adapter = adapter_mod.HermesQAdapter(cfg, client=StubClient())
            with mock.patch.object(adapter_mod, 'WsClient') as cls:
                cls.return_value.run = mock.AsyncMock()
                self.assertTrue(await adapter.connect())
                self.assertEqual(cls.call_args.args[3], [['source:github', 'repo:*'], ['source:github', 'ref:release/*']])
                self.assertIsNotNone(adapter._task)
                await adapter.disconnect()

class EnvEnablementTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.pop(k) for k in ("HERMESQ_URL", "HERMESQ_SECRET", "HERMESQ_CONSUMER") if k in os.environ}

    def tearDown(self):
        for k in ("HERMESQ_URL", "HERMESQ_SECRET", "HERMESQ_CONSUMER"):
            os.environ.pop(k, None)
        os.environ.update(self._saved)

    def test_env_alone_enables_the_platform_only_when_url_and_secret_are_set(self):
        self.assertIsNone(adapter_mod.env_enablement())
        os.environ["HERMESQ_URL"] = "https://w.example/"
        self.assertIsNone(adapter_mod.env_enablement())
        os.environ["HERMESQ_SECRET"] = "s3"
        os.environ["HERMESQ_CONSUMER"] = "host-9"
        self.assertEqual(adapter_mod.env_enablement(), {"url": "https://w.example", "secret": "s3", "consumer": "host-9"})


class RegistrationTests(unittest.TestCase):
    def test_register_declares_a_trusted_inbound_platform(self):
        entry = REGISTERED[0]
        self.assertEqual(entry.name, "hermesq")
        self.assertIs(entry.trusted_inbound, True)
        self.assertEqual(entry.required_env, ["HERMESQ_URL", "HERMESQ_SECRET"])
        self.assertTrue(platform_registry.is_registered("hermesq"))
        self.assertIsInstance(entry.adapter_factory(PlatformConfig(extra={"url": "https://x", "secret": "s"})), adapter_mod.HermesQAdapter)
        self.assertIs(entry.env_enablement_fn, adapter_mod.env_enablement)
        self.assertFalse(adapter_mod.validate_config(PlatformConfig(extra={"url": "https://x"})))
        self.assertTrue(adapter_mod.validate_config(PlatformConfig(extra={"url": "https://x", "secret": "s"})))


if __name__ == "__main__":
    unittest.main()
