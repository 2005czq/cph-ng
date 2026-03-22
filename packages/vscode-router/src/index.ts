// Copyright (C) 2026 Langning Chen
//
// This file is part of cph-ng.
//
// cph-ng is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// cph-ng is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with cph-ng.  If not, see <https://www.gnu.org/licenses/>.

import type {
  B2rMsg,
  C2rMsg,
  CompanionProblem,
  LogLevel,
  R2bMsg,
  R2cMsg,
  RouterConfig,
} from '@cph-ng/core';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { Server } from 'socket.io';
import { BatchStore } from './batchStore';
import { type LogFileLockRelease, parseRouterConfig, prepareLogFile } from './config';
import { configureLogger, error, info, trace, warn } from './logger';

type RouterProcessMessage =
  | { type: 'ready'; port: number }
  | { type: 'startup-error'; message: string };

const ROUTER_PING_INTERVAL_MS = 5000;
const ROUTER_PING_TIMEOUT_MS = 5000;
const AVAILABLE_BATCH_TTL_MS = 10 * 60 * 1000;

let io: Server<C2rMsg & B2rMsg, R2cMsg & R2bMsg> | undefined;
let server: ReturnType<typeof serve> | undefined;
let config: RouterConfig;
let releaseLogFileLock: LogFileLockRelease | undefined;
let isShuttingDown = false;
let activeBrowserId: string | null = null;
let shutdownTimer: NodeJS.Timeout | null = null;

const app = new Hono();

export const broadcastLog = (level: LogLevel, message: string, details: unknown) => {
  io?.to('vscode-clients').emit('log', { message, level, details });
};

const postParentMessage = (message: RouterProcessMessage) => {
  if (typeof process.send === 'function') process.send(message);
};

const formatErrorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

const getRoomSize = (roomName: string): number =>
  io?.sockets.adapter.rooms.get(roomName)?.size ?? 0;

const hasConnectedClients = (): boolean =>
  getRoomSize('vscode-clients') + getRoomSize('browsers') > 0;

const batchStore = new BatchStore({
  availableBatchTtlMs: AVAILABLE_BATCH_TTL_MS,
  isAutoImportEnabled: () => getRoomSize('vscode-clients') === 1,
  onReadingBatch: (batchId, count, size) => {
    io?.to('vscode-clients').emit('readingBatch', { batchId, count, size });
  },
  onBatchAvailable: (batch, autoImport) => {
    io?.to('vscode-clients').emit('batchAvailable', {
      ...batch,
      autoImport,
    });
    info(`Batch ${batch.batchId} became available`, {
      problemCount: batch.problems.length,
      autoImport,
    });
  },
  onBatchRemoved: (batchId, reason) => {
    io?.to('vscode-clients').emit('batchRemoved', { batchId, reason });
    info(`Batch ${batchId} removed`, { reason });
  },
});

const refreshAllStatus = () => {
  if (!io) return;
  const isAnyBrowserConnected = !!activeBrowserId;

  io.to('vscode-clients').emit('browserStatus', {
    connected: isAnyBrowserConnected,
  });

  const browserRoom = io.sockets.adapter.rooms.get('browsers');
  for (const socketId of browserRoom || [])
    io.sockets.sockets.get(socketId)?.emit('status', { isActive: socketId === activeBrowserId });

  trace('Status refreshed', {
    activeBrowserId,
    isAnyBrowserConnected,
    browserCount: browserRoom?.size || 0,
  });
};

const scheduleShutdown = () => {
  if (isShuttingDown) return;
  if (shutdownTimer) clearTimeout(shutdownTimer);
  if (hasConnectedClients()) return;

  shutdownTimer = setTimeout(() => {
    void stopServer(`No clients connected for ${config.shutdownTimeout}ms`);
  }, config.shutdownTimeout);
};

const closeRuntime = async (
  currentServer: ReturnType<typeof serve> | undefined,
  currentIo: Server<C2rMsg & B2rMsg, R2cMsg & R2bMsg> | undefined,
) => {
  currentIo?.close();
  if (currentServer)
    await new Promise<void>((resolve) => {
      currentServer.close(() => resolve());
    });
};

const createRuntime = async (port: number) => {
  const nextServer = serve({ fetch: app.fetch, port });
  if (!nextServer.listening)
    await new Promise<void>((resolve, reject) => {
      const handleError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const handleListening = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        nextServer.removeListener('error', handleError);
        nextServer.removeListener('listening', handleListening);
      };

      nextServer.once('error', handleError);
      nextServer.once('listening', handleListening);
    });

  const nextIo = new Server(nextServer, {
    path: '/ws',
    cors: { origin: '*' },
    pingInterval: ROUTER_PING_INTERVAL_MS,
    pingTimeout: ROUTER_PING_TIMEOUT_MS,
  });

  return { server: nextServer, io: nextIo };
};

const restartServer = async (reason: string) => {
  if (isShuttingDown || !server || !io) return;

  info('Restarting router listener', { port: config.port, reason });
  const currentServer = server;
  const currentIo = io;
  const nextRuntime = await createRuntime(config.port);
  server = nextRuntime.server;
  io = nextRuntime.io;
  attachSocketHandlers(nextRuntime.io);
  await closeRuntime(currentServer, currentIo);
  scheduleShutdown();
  info('Router listener restarted', { port: config.port, reason });
};

const rotateLogFile = async (nextLogFile: string) => {
  if (nextLogFile === config.logFile) return;

  const previousLogFile = config.logFile;
  const previousRelease = releaseLogFileLock;
  const nextRelease = await prepareLogFile(nextLogFile);

  releaseLogFileLock = nextRelease;
  config.logFile = nextLogFile;
  configureLogger(nextLogFile);

  if (previousRelease) {
    try {
      await previousRelease();
    } catch {}
  }

  info('Router log file updated', { previousLogFile, nextLogFile });
};

const stopServer = async (reason: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

  info('Stopping router', { reason });

  const currentIo = io;
  io = undefined;
  const currentServer = server;
  server = undefined;
  batchStore.dispose();
  await closeRuntime(currentServer, currentIo);

  if (releaseLogFileLock) {
    try {
      await releaseLogFileLock();
    } catch {}
    releaseLogFileLock = undefined;
  }

  process.exit(0);
};

app.use(logger(trace));
app.use('/*', cors());

app.get('/', (ctx) => {
  const browserRoom = io?.sockets.adapter.rooms.get('browsers') || new Set();
  const vscodeRoom = io?.sockets.adapter.rooms.get('vscode-clients') || new Set();
  const pendingBatches = batchStore.getPendingDebugSnapshot();
  const availableBatches = batchStore.getSnapshot();
  const html = `
    <html>
      <head>
        <title>CPH-NG Router Status</title>
        <style>
          pre {
            display: inline-block;
          }
        </style>
      </head>

      <body>
        <h1>CPH-NG Router Status</h1>
        <p>If you are seeing this, it means that the CPH-NG router has successfully started.</p>
        <p>You can install the browser extension to automatically submit the problem. For more details, please refer to our documents.</p>
        <p><b>Happy coding! :)</b></p>
        <hr>
        <h2>Debugging Information</h2>
        <h3>Connect Browsers</h3>
        <p>Count: ${browserRoom.size} browser(s)</p>
        <ul>
          ${[...browserRoom.values()]
            .map(
              (browserId) => `
          <li>
            <pre>${browserId}</pre>${browserId === activeBrowserId ? ' (active)' : ''}
          </li>`,
            )
            .join('')}
        </ul>
        <h3>Connected VSCode Clients</h3>
        <p>Count: ${vscodeRoom.size} client(s)</p>
        <ul>
          ${[...vscodeRoom.values()]
            .map(
              (clientId) => `
          <li>
            <pre>${clientId}</pre>
          </li>`,
            )
            .join('')}
        </ul>
        <h3>Pending Batches</h3>
        <p>Count: ${pendingBatches.length} batch(es)</p>
        <ul>
          ${pendingBatches
            .map(
              (batch) => `
            <li>
              <pre>${batch.batchId}</pre> ${batch.count}/${batch.size} problems
            </li>
          `,
            )
            .join('')}
        </ul>
        <h3>Available Batches</h3>
        <p>Count: ${availableBatches.length} batch(es)</p>
        <ul>
          ${availableBatches
            .map(
              (batch) => `
            <li>
              <pre>${batch.batchId}</pre> ${batch.problems.length} problem(s) ready
            </li>
          `,
            )
            .join('')}
        </ul>
      </body>
    </html>
  `;
  return ctx.html(html);
});

app.post('/', async (ctx) => {
  const body: CompanionProblem = await ctx.req.json();
  const status = batchStore.submit(body);
  if (status === 'duplicate')
    trace('Ignored duplicate companion batch payload', { batchId: body.batch.id });
  else if (status === 'ignored')
    trace('Ignored finalized companion batch payload', { batchId: body.batch.id });
  return ctx.json({ status: 'ok' });
});

const attachSocketHandlers = (targetIo: Server<C2rMsg & B2rMsg, R2cMsg & R2bMsg>) => {
  targetIo.on('connection', (socket) => {
    scheduleShutdown();
    const type = socket.handshake.query.type;

    if (type === 'vscode') {
      socket.join('vscode-clients');
      info('VSCode connected', { id: socket.id });

      socket.emit('browserStatus', { connected: !!activeBrowserId });
      socket.emit('batchSnapshot', { batches: batchStore.getSnapshot() });
      socket.on('submit', (msg: Parameters<C2rMsg['submit']>[0]) => {
        if (activeBrowserId) {
          io?.to(activeBrowserId).emit('submitRequest', msg);
          info('Submission forwarded to browser extension', { msg });
        } else error('No browser connected');
      });
      socket.on('cancelBatch', ({ batchId }: Parameters<C2rMsg['cancelBatch']>[0]) => {
        if (!batchStore.cancel(batchId))
          warn(`Batch ${batchId} not found for cancellation`, { batchId });
      });
      socket.on(
        'claimBatch',
        (
          { batchId }: Parameters<C2rMsg['claimBatch']>[0],
          ack: Parameters<C2rMsg['claimBatch']>[1],
        ) => {
          const result = batchStore.claim(batchId);
          if (!result.ok) warn(`Batch ${batchId} not found for claim`, { batchId });
          ack(result);
        },
      );
      socket.on(
        'updateConfig',
        async ({ config: nextConfig }: Parameters<C2rMsg['updateConfig']>[0]) => {
          try {
            if (nextConfig.logFile && nextConfig.logFile !== config.logFile)
              await rotateLogFile(nextConfig.logFile);

            if (
              typeof nextConfig.shutdownTimeout === 'number' &&
              nextConfig.shutdownTimeout !== config.shutdownTimeout
            )
              config.shutdownTimeout = nextConfig.shutdownTimeout;

            if (typeof nextConfig.port === 'number' && nextConfig.port !== config.port) {
              const previousPort = config.port;
              config.port = nextConfig.port;
              try {
                await restartServer('Router listen port changed');
              } catch (err) {
                config.port = previousPort;
                throw err;
              }
            }
            scheduleShutdown();
            info('Config updated dynamically', nextConfig);
          } catch (err) {
            error('Failed to update router config', {
              message: formatErrorMessage(err),
              nextConfig,
            });
          }
        },
      );
    } else if (type === 'browser') {
      socket.join('browsers');
      info('Browser connected', { id: socket.id });
      if (!activeBrowserId) activeBrowserId = socket.id;
      refreshAllStatus();
      socket.on('setActive', () => {
        activeBrowserId = socket.id;
        refreshAllStatus();
      });
    }

    socket.on('disconnect', () => {
      if (socket.id === activeBrowserId) {
        const nextSocket = io?.sockets.adapter.rooms.get('browsers')?.values().next().value;
        activeBrowserId = nextSocket || null;
      }
      refreshAllStatus();
      scheduleShutdown();
    });
  });
};

const startServer = async () => {
  const nextRuntime = await createRuntime(config.port);
  server = nextRuntime.server;
  io = nextRuntime.io;
  attachSocketHandlers(nextRuntime.io);
};

const bootstrap = async () => {
  try {
    config = parseRouterConfig(process.argv);
    releaseLogFileLock = await prepareLogFile(config.logFile);
    configureLogger(config.logFile);

    await startServer();
    info(`Router started on port ${config.port}`, {
      config,
      pingInterval: ROUTER_PING_INTERVAL_MS,
      pingTimeout: ROUTER_PING_TIMEOUT_MS,
    });
    scheduleShutdown();

    process.once('SIGTERM', () => {
      void stopServer('Received SIGTERM');
    });
    process.once('SIGINT', () => {
      void stopServer('Received SIGINT');
    });

    postParentMessage({ type: 'ready', port: config.port });
  } catch (err) {
    const message = formatErrorMessage(err);
    try {
      process.stderr.write(`${message}\n`);
    } catch {}
    postParentMessage({ type: 'startup-error', message });

    if (releaseLogFileLock) {
      try {
        await releaseLogFileLock();
      } catch {}
      releaseLogFileLock = undefined;
    }

    process.exit(1);
  }
};

void bootstrap();
