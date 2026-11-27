"""WS consumer behavior at its public run loop, using a fake connection."""
import asyncio
import importlib.util
import json
import os
import stat
import sys
import tempfile
import types
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
ws_pkg = types.ModuleType('wt_ws')
ws_pkg.__path__ = [str(PLUGIN)]
sys.modules['wt_ws'] = ws_pkg
spec = importlib.util.spec_from_file_location('wt_ws.ws_client', PLUGIN / 'ws_client.py')
assert spec and spec.loader
ws = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ws
spec.loader.exec_module(ws)


class FakeSocket:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.sent = []

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def close(self):
        pass

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return json.dumps(next(self.messages))
        except StopIteration:
            raise RuntimeError('disconnected') from None


class WsTests(unittest.IsolatedAsyncioTestCase):
    async def test_replaced_consumer_code_4001_does_not_reconnect(self):
        class ReplacedError(RuntimeError):
            rcvd = types.SimpleNamespace(code=4001)
        class Replaced(FakeSocket):
            async def __anext__(self):
                raise ReplacedError('replaced')
        with tempfile.TemporaryDirectory() as home:
            attempts = []
            async def connect(url, **kwargs):
                attempts.append(url)
                return Replaced([])
            client = ws.WsClient('https://worker.test', 'secret', 'host-1', [['repo:infra']], Path(home), connector=connect)
            with self.assertLogs(ws.logger, level='ERROR'):
                await client.run(lambda event: None, asyncio.Event())
            self.assertEqual(len(attempts), 1)

    async def test_invalid_cursor_stops_instead_of_reconnecting_forever(self):
        with tempfile.TemporaryDirectory() as home:
            attempts = []
            async def connect(url, **kwargs):
                attempts.append(url)
                return FakeSocket([])
            client = ws.WsClient('https://worker.test', 'secret', 'host-1', [['repo:infra']], Path(home), connector=connect)
            client.cursor_path.write_text('invalid')
            with self.assertLogs(ws.logger, level='ERROR'):
                await client.run(lambda event: None, asyncio.Event())
            self.assertEqual(len(attempts), 1)

    async def test_reconnect_replays_only_unacked_event_and_persists_cursor_privately(self):
        with tempfile.TemporaryDirectory() as home:
            sockets = []
            paths = []
            async def connect(url, **kwargs):
                paths.append((url, kwargs))
                sock = FakeSocket([{'op': 'event', 'id': 1, 'tags': ['repo:infra']}] if not sockets else
                                  [{'op': 'event', 'id': 2, 'tags': ['repo:infra']}])
                sockets.append(sock)
                return sock
            seen = []
            async def handle(event):
                seen.append(event['id'])
                if event['id'] == 2:
                    raise RuntimeError('not processed')
            async def sleep(_):
                if len(sockets) == 2:
                    stop.set()
            stop = asyncio.Event()
            client = ws.WsClient('https://worker.test', 'secret', 'host-1', [['repo:infra']], Path(home), connector=connect)
            await client.run(handle, stop, sleep=sleep)
            self.assertEqual(seen, [1, 2])
            self.assertEqual(sockets[0].sent, [{'op': 'hello'}, {'op': 'ack', 'id': 1}])
            self.assertEqual(sockets[1].sent, [{'op': 'hello', 'last_id': 1}])
            self.assertEqual(client.cursor_path.read_text(), '1')
            self.assertEqual(stat.S_IMODE(client.cursor_path.stat().st_mode), 0o600)
            self.assertIn('filter=repo%3Ainfra', paths[0][0])
            self.assertIn('additional_headers', paths[0][1])
