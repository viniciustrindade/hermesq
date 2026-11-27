"""Outbound, signed WebSocket consumer for the hermesQ Hub (Hermes' websockets dependency)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urlunsplit

from .transfer_client import RETRY_BACKOFF_SECONDS, sign

logger = logging.getLogger(__name__)
CONSUMER = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
TAG = re.compile(r"[a-z][a-z0-9_-]{0,31}:[^\s,]{1,200}")


async def _connect(url, **options):
    from websockets.asyncio.client import connect  # installed with Hermes; injected connector in unit tests
    return await connect(url, **options)


class CursorError(Exception):
    pass


class WsClient:
    def __init__(self, base_url, secret, consumer, filters, home: Path, connector=None):
        if not CONSUMER.fullmatch(consumer):
            raise ValueError('invalid HERMESQ_CONSUMER')
        if (not filters or len(filters) > 20 or len(json.dumps(filters)) > 1800 or
                any(not group or len(group) > 8 or not all(TAG.fullmatch(tag) for tag in group) for group in filters)):
            raise ValueError('HERMESQ_WS_FILTERS needs nonempty tag filters')
        self.secret = secret
        self.consumer = consumer
        self.filters = filters
        self.cursor_path = home / f'hermesq-ws-{consumer}.cursor'
        self.connector = connector
        base = urlsplit(base_url)
        if base.scheme not in ('https', 'http') or not base.netloc or base.path not in ('', '/'):
            raise ValueError('HERMESQ_URL must be the Worker origin')
        self.path = '/ws?' + urlencode([('consumer', consumer)] + [('filter', ','.join(group)) for group in filters])
        self.url = urlunsplit(('wss' if base.scheme == 'https' else 'ws', base.netloc, self.path, '', ''))

    def _cursor(self):
        try:
            if self.cursor_path.is_symlink():
                raise CursorError('cursor is a symlink')
            value = int(self.cursor_path.read_text())
            if value < 0:
                raise CursorError('cursor is negative')
            return value
        except FileNotFoundError:
            return None
        except ValueError:
            raise CursorError('cursor is not an integer') from None

    def _save(self, value):
        self.cursor_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=f'.{self.consumer}-', dir=self.cursor_path.parent)
        temp = Path(name)
        try:
            with os.fdopen(fd, 'w') as stream:
                stream.write(str(value))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self.cursor_path)
        finally:
            temp.unlink(missing_ok=True)

    async def run(self, handle, stop: asyncio.Event, *, sleep=asyncio.sleep):
        connector = self.connector or _connect
        failures = 0
        while not stop.is_set():
            socket = None
            try:
                ts = str(int(time.time()))
                headers = {'X-Hermes-Timestamp': ts,
                           'X-Hermes-Signature': sign(self.secret, ts, 'GET', self.path, '')}
                socket = await connector(self.url, additional_headers=headers, ping_interval=20, ping_timeout=20)
                cursor = self._cursor()
                await socket.send(json.dumps({'op': 'hello', **({'last_id': cursor} if cursor is not None else {})}))
                failures = 0
                async for raw in socket:
                    msg = json.loads(raw)
                    if msg.get('op') != 'event':
                        continue
                    try:
                        await handle(msg)
                    except Exception:
                        logger.exception('[hermesq] WS event %s failed; awaiting replay', msg.get('id'))
                        raise
                    await socket.send(json.dumps({'op': 'ack', 'id': msg['id']}))
                    self._save(msg['id'])
            except asyncio.CancelledError:
                raise
            except CursorError as err:
                logger.error('[hermesq] WS stopped: %s; repair local cursor before restart', err)
                return
            except Exception as err:
                closed = getattr(err, 'rcvd', None)
                if closed is not None and closed.code == 4001:
                    logger.error('[hermesq] WS consumer replaced; stopping this client')
                    return
                if socket is not None:
                    await socket.close()
                    socket = None
                failures += 1
                logger.warning('[hermesq] WS disconnected (%s); reconnecting', type(err).__name__)
                if not stop.is_set():
                    await sleep(RETRY_BACKOFF_SECONDS[min(failures, len(RETRY_BACKOFF_SECONDS)) - 1])
            finally:
                if socket is not None:
                    await socket.close()
