import path from 'node:path';
import { MAX_WORKER_LIMIT, parseWorkerLimit } from '../../machine.js';
import { connectionCommand, memberNodeName } from '../../nodes/enrollment.js';
import { registerNode, registeredNodes } from '../../nodes/registration.js';
import { serveFile } from '../static.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';

export const nodeConnectRoutes = {
  page: {
    method: 'GET', path: ['/connect-node', '/connect-node.html'], auth: 'session',
    handle: (ctx, { res }) => serveFile(res, path.join(ctx.publicDir, 'connect-node.html'), false),
  },
  info: {
    method: 'GET', path: '/api/node-connect', auth: 'session',
    handle(ctx, { res, session }) {
      if (!session.account) return send(res, 403, { error: 'Use an account invite and sign in with your own account to connect a machine.' });
      const name = memberNodeName(session.account.id);
      send(res, 200, { name, registered: registeredNodes(ctx.cfg.dataDir).some((n) => n.name === name), maxWorkerLimit: MAX_WORKER_LIMIT });
    },
  },
  connect: {
    method: 'POST', path: '/api/node-connect', auth: 'session',
    async handle(ctx, { req, res, session }) {
      if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Connect from the office page.' });
      if (!session.account) return send(res, 403, { error: 'Sign in with your own account to connect a machine.' });
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return send(res, 400, { error: 'Expected JSON.' });
      let body: { consent?: unknown; maxWorkers?: unknown; replace?: unknown };
      try {
        body = JSON.parse(await readBody(req, 1024));
      } catch {
        return send(res, 400, { error: 'Bad request.' });
      }
      if (!body || body.consent !== true) return send(res, 400, { error: 'Choose to share your machine first.' });
      const maxWorkers = parseWorkerLimit(body.maxWorkers);
      if (!maxWorkers) return send(res, 400, { error: `Choose a worker limit from 1 to ${MAX_WORKER_LIMIT}.` });
      if (!ctx.accounts.get(session.account.id)) return send(res, 401, { error: 'Your account was revoked.' });
      const name = memberNodeName(session.account.id);
      const existing = registeredNodes(ctx.cfg.dataDir).find((n) => n.name === name);
      if (existing && existing.accountId !== session.account.id) return send(res, 409, { error: 'That node name is already in use. Ask an admin to resolve it.' });
      if (existing && body.replace !== true) return send(res, 409, { error: 'You already have a connection command. Reload this page to replace it.' });
      const token = registerNode(ctx.cfg.dataDir, name, session.account.id);
      const command = connectionCommand(ctx.cfg, req.headers.origin!, name, token, maxWorkers);
      send(res, 200, { name, command });
    },
  },
} satisfies Record<string, Route>;
