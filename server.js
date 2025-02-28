import Koa from 'koa';
import tldjs from 'tldjs';
import Debug from 'debug';
import http from 'http';
const jwt = require('jsonwebtoken');
import { hri } from 'human-readable-ids';
import Router from 'koa-router';

import ClientManager from './lib/ClientManager';

const debug = Debug('localtunnel:server');

const secret = process.env.JWT_SECRET || 'v2cloud-vnc';

const authenticated = async (ctx, next) => {

    const token = ctx.request.headers['vnc-token'];
    debug("TOKEN: ", token);

    if (!token) ctx.throw(403, 'No token.');

    try {
        debug('authenticated jwt', jwt.verify(token, secret));
    } catch (err) {
        ctx.throw(err.status || 403, err.text);
    }
    
    await next();

};

export default function(opt) {
    opt = opt || {};

    const validHosts = (opt.domain) ? [opt.domain] : undefined;
    const myTldjs = tldjs.fromUserSettings({ validHosts });
    const landingPage = opt.landing || 'https://v2cloud.com';

    function GetClientIdFromHostname(hostname) {
        return myTldjs.getSubdomain(hostname);
    }

    const manager = new ClientManager(opt);

    const schema = opt.secure ? 'https' : 'http';

    const app = new Koa();
    const router = new Router();

    app.use(authenticated);

    router.get('/api/status', async (ctx, next) => {

        ctx.body = {
            tunnelsCount: manager.stats.tunnels,
            tunnels: manager.getClients(),
            mem: process.memoryUsage(),
        };
    });

    router.get('/api/tunnels/:id/status', async (ctx, next) => {
        const clientId = ctx.params.id;
        const client = manager.getClient(clientId);
        if (!client) {
            ctx.throw(404);
            return;
        }

        const stats = client.stats();
        ctx.body = {
            connected_sockets: stats.connectedSockets,
            available_sockets: stats.availableSockets,
            client_address: stats.clientAddress,
            waiting_connections: stats.waitingConnections,
            no_more_socket_events: stats.noMoreSocketEvents,
            is_closed: stats.isClosed,
        };
    });

    router.post('/api/tunnels/:id/delete', async (ctx, next) => {
        const clientId = ctx.params.id;
        const client = manager.getClient(clientId);
        if (!client) {
            ctx.throw(404);
            return;
        }

        manager.removeClient(clientId);
        ctx.body = {
            delete_status: "success",
        };
    });

    app.use(router.routes());
    app.use(router.allowedMethods());

    // root endpoint
    app.use(async (ctx, next) => {
        const path = ctx.request.path;

        // skip anything not on the root path
        if (path !== '/') {
            await next();
            return;
        }

        const isNewClientRequest = ctx.query['new'] !== undefined;
        if (isNewClientRequest) {
            const reqId = hri.random();
            debug('making new client with id %s', reqId);
            const info = await manager.newClient(reqId);

            const url = schema + '://' + info.id + '.' + ctx.request.host;
            info.url = url;
            ctx.body = info;
            return;
        }

        // no new client request, send to landing page
        ctx.redirect(landingPage);
    });

    // anything after the / path is a request for a specific client name
    // This is a backwards compat feature
    app.use(async (ctx, next) => {
        const parts = ctx.request.path.split('/');

        // any request with several layers of paths is not allowed
        // rejects /foo/bar
        // allow /foo
        if (parts.length !== 2) {
            await next();
            return;
        }

        const reqId = parts[1];

        // limit requested hostnames to 63 characters
        if (! /^(?:[a-z0-9][a-z0-9\-]{4,63}[a-z0-9]|[a-z0-9]{4,63})$/.test(reqId)) {
            const msg = 'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.';
            ctx.status = 403;
            ctx.body = {
                message: msg,
            };
            return;
        }

        debug('making new client with id %s', reqId);
        const info = await manager.newClient(reqId);

        const url = schema + '://' + info.id + '.' + ctx.request.host;
        info.url = url;
        ctx.body = info;
        return;
    });

    const server = http.createServer();

    const appCallback = app.callback();

    server.on('request', (req, res) => {
        debug("ON REQUEST URL:", req.url);
        // without a hostname, we won't know who the request is for
        const hostname = req.headers.host;
        if (!hostname) {
            res.statusCode = 400;
            res.end('Host header is required');
            return;
        }

        // get clientId from route /connect/$clientId
        const clientId = req.url.substr(0, "/connect".length) === "/connect"
            ? req.url.substr("/connect/".length)
            : GetClientIdFromHostname(hostname);

        if (!clientId) {
            appCallback(req, res);
            return;
        }

        const client = manager.getClient(clientId);
        if (!client) {
            res.statusCode = 404;
            res.end(`Can't find active tunnel ${clientId}...`);
            return;
        }

        client.handleRequest(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
        debug("ON UPGRADE URL:", req.url);
        const hostname = req.headers.host;
        if (!hostname) {
            socket.destroy();
            return;
        }

        const clientId = req.url.substr(0, "/connect".length) === "/connect"
            ? req.url.substr("/connect/".length)
            : GetClientIdFromHostname(hostname);

        if (!clientId) {
            socket.destroy();
            return;
        }

        const client = manager.getClient(clientId);
        if (!client) {
            socket.destroy();
            return;
        }

        client.handleUpgrade(req, socket);
    });

    return server;
};
