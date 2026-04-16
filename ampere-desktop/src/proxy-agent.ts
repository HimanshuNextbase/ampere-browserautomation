/**
 * Desktop Proxy Agent for Ampere
 * Connects to the browser-server via WebSocket and relays HTTP/HTTPS
 * requests through the user's local network (residential IP).
 *
 * Protocol:
 *  - Desktop sends: hello, ping, http-response, connect-response, tunnel-data, tunnel-end
 *  - Server sends: http-request, connect-request, tunnel-data, tunnel-end, welcome, ack, pong
 */

import { WebSocket } from 'ws';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';

export interface ProxyAgentConfig {
  wsUrl: string;
  userToken: string;
  onProxyReady?: (proxyUrl: string, port: number) => void;
  onProxyClosed?: () => void;
  onError?: (error: Error) => void;
  /** Called before each reconnect to get a fresh token. Return null to abort reconnect. */
  onTokenRefresh?: () => Promise<string | null>;
  /** Max reconnect attempts before giving up (default: Infinity) */
  maxRetries?: number;
  /** Initial retry delay in ms (default: 2000, doubles each attempt, max 60s) */
  retryDelayMs?: number;
}

export class DesktopProxyAgent {
  private ws: WebSocket | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private config: ProxyAgentConfig;
  private running = false;
  private tunnelSockets: Map<string, net.Socket> = new Map();
  private requestCount = 0;
  private logInterval: NodeJS.Timeout | null = null;
  private retryCount = 0;
  private retryTimeout: NodeJS.Timeout | null = null;
  private intentionallyStopped = false;

  constructor(config: ProxyAgentConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.intentionallyStopped = false;
    this.retryCount = 0;
    return this.connect();
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const isRetry = this.retryCount > 0;
      console.log(`[ProxyAgent] ${isRetry ? `Reconnecting (attempt ${this.retryCount})...` : 'Connecting to server...'}`);

      this.ws = new WebSocket(this.config.wsUrl, {
        headers: { 'Authorization': `Bearer ${this.config.userToken}` },
      });

      this.ws.on('open', () => {
        console.log('[ProxyAgent] WebSocket connected, sending hello...');
        this.running = true;
        this.retryCount = 0; // Reset on successful connection
        this.startPingInterval();

        // Introduce ourselves to the browser-server
        this.ws?.send(JSON.stringify({
          type: 'hello',
          userAgent: 'AmpereDesktop/1.0',
        }));

        // Log summary every 5 seconds instead of per-request
        this.logInterval = setInterval(() => {
          if (this.requestCount > 0) {
            console.log(`[ProxyAgent] ${this.requestCount} requests proxied, ${this.tunnelSockets.size} active tunnels`);
            this.requestCount = 0;
          }
        }, 5000);

        this.config.onProxyReady?.('ws-proxy', 0);
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (e) {
          // Ignore parse errors
        }
      });

      this.ws.on('error', (err) => {
        console.error('[ProxyAgent] WebSocket error:', err);
        this.config.onError?.(err);
        if (!this.running && this.retryCount === 0) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[ProxyAgent] WebSocket closed: code=${code} reason=${reason?.toString()}`);
        this.running = false;
        this.cleanup(false); // Don't clear retry timeout

        // Auth rejection — don't silently reconnect with the same dead token
        const isAuthError = code === 4001 || code === 4003 || code === 1008;
        if (isAuthError && !this.config.onTokenRefresh) {
          console.error('[ProxyAgent] Auth rejected and no token refresh configured, stopping');
          this.intentionallyStopped = true;
          this.config.onError?.(new Error(`Auth rejected (code ${code})`));
          this.config.onProxyClosed?.();
          return;
        }

        if (!this.intentionallyStopped) {
          this.scheduleReconnect();
        } else {
          this.config.onProxyClosed?.();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    const maxRetries = this.config.maxRetries ?? Infinity;
    if (this.retryCount >= maxRetries) {
      console.log(`[ProxyAgent] Max retries (${maxRetries}) reached, giving up`);
      this.config.onProxyClosed?.();
      return;
    }

    const baseDelay = this.config.retryDelayMs ?? 2000;
    const delay = Math.min(baseDelay * Math.pow(2, this.retryCount), 60000); // Max 60s
    this.retryCount++;

    console.log(`[ProxyAgent] Reconnecting in ${Math.round(delay / 1000)}s...`);
    this.retryTimeout = setTimeout(async () => {
      this.retryTimeout = null;

      // Refresh token before reconnecting
      if (this.config.onTokenRefresh) {
        try {
          const freshToken = await this.config.onTokenRefresh();
          if (freshToken) {
            this.config.userToken = freshToken;
            console.log('[ProxyAgent] Token refreshed before reconnect');
          } else {
            console.error('[ProxyAgent] Token refresh returned null, aborting reconnect');
            this.config.onProxyClosed?.();
            return;
          }
        } catch (err: any) {
          console.error('[ProxyAgent] Token refresh failed:', err.message);
          // Continue reconnect with existing token — server may still accept it
        }
      }

      this.connect().catch((err) => {
        console.error('[ProxyAgent] Reconnect failed:', err.message);
        if (!this.intentionallyStopped) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private handleMessage(msg: any): void {
    try {
      switch (msg.type) {
        case 'welcome':
        case 'ack':
          console.log('[ProxyAgent] Server:', msg.message);
          break;

        case 'pong':
          break;

        case 'http-request':
          this.requestCount++;
          this.handleHttpRequest(msg);
          break;

        case 'connect-request':
          this.requestCount++;
          this.handleConnectRequest(msg);
          break;

        case 'tunnel-data':
          this.handleTunnelData(msg);
          break;

        case 'tunnel-end':
          this.handleTunnelEnd(msg);
          break;

        default:
          console.log('[ProxyAgent] Unknown message type:', msg.type);
      }
    } catch (err: any) {
      console.error('[ProxyAgent] Error handling message:', err.message);
    }
  }

  /**
   * Execute an HTTP request on behalf of the server's browser
   * and send the response back.
   *
   * The server sends: { type: "http-request", reqId, method, url, headers, body }
   * where `url` may be a path ("/foo") or full URL ("http://example.com/foo").
   * The `Host` header tells us the target hostname.
   */
  private handleHttpRequest(msg: any): void {
    const { reqId, method, headers, body } = msg;
    let { url } = msg;

    // If url is just a path, reconstruct full URL from Host header
    if (url && !url.startsWith('http')) {
      const host = headers?.host || headers?.Host || 'localhost';
      url = `http://${host}${url}`;
    }

    // Verbose logging only in dev
    // console.log(`[ProxyAgent] HTTP ${method} ${url}`);

    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method || 'GET',
        headers: headers || {},
      };

      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          this.send({
            type: 'http-response',
            reqId,
            statusCode: res.statusCode,
            headers: res.headers,
            body: responseBody.toString('base64'),
          });
        });
      });

      req.on('error', (err) => {
        console.error(`[ProxyAgent] HTTP error for ${url}:`, err.message);
        this.send({
          type: 'http-response',
          reqId,
          error: err.message,
        });
      });

      if (body) {
        req.write(Buffer.from(body, 'base64'));
      }
      req.end();
    } catch (err: any) {
      this.send({
        type: 'http-response',
        reqId,
        error: err.message,
      });
    }
  }

  /**
   * Handle HTTPS CONNECT tunnel request — establish a TCP connection
   * to the target and relay data bidirectionally.
   *
   * Server sends: { type: "connect-request", reqId, host: "hostname:port", head }
   * where `host` is in "hostname:port" format (e.g., "google.com:443").
   */
  private handleConnectRequest(msg: any): void {
    const { reqId, head } = msg;
    // Parse "hostname:port" format
    const hostStr = msg.host || 'localhost:443';
    const lastColon = hostStr.lastIndexOf(':');
    const targetHost = lastColon > 0 ? hostStr.substring(0, lastColon) : hostStr;
    const targetPort = lastColon > 0 ? parseInt(hostStr.substring(lastColon + 1), 10) : 443;
    // console.log(`[ProxyAgent] CONNECT ${targetHost}:${targetPort}`);

    try {
      const socket = net.connect({ host: targetHost, port: targetPort, timeout: 30000 }, () => {
        // console.log(`[ProxyAgent] Tunnel established: ${targetHost}:${targetPort}`);
        this.tunnelSockets.set(reqId, socket);

        // Send any buffered head data
        if (head) {
          socket.write(Buffer.from(head, 'base64'));
        }

        this.send({
          type: 'connect-response',
          reqId,
          success: true,
        });
      });

      socket.on('timeout', () => {
        console.error(`[ProxyAgent] Tunnel timeout: ${targetHost}:${targetPort}`);
        socket.destroy();
        this.send({ type: 'connect-response', reqId, error: 'Connection timeout' });
        this.tunnelSockets.delete(reqId);
      });

      socket.on('data', (data: Buffer) => {
        try {
          this.send({
            type: 'tunnel-data',
            reqId,
            data: data.toString('base64'),
          });
        } catch (err: any) {
          console.error(`[ProxyAgent] Failed to send tunnel data:`, err.message);
        }
      });

      socket.on('end', () => {
        this.send({ type: 'tunnel-end', reqId });
        this.tunnelSockets.delete(reqId);
      });

      socket.on('error', (err) => {
        console.error(`[ProxyAgent] Tunnel error ${targetHost}:${targetPort}:`, err.message);
        this.send({
          type: 'connect-response',
          reqId,
          error: err.message,
        });
        this.tunnelSockets.delete(reqId);
      });
    } catch (err: any) {
      console.error(`[ProxyAgent] Failed to create tunnel:`, err.message);
      this.send({ type: 'connect-response', reqId, error: err.message });
    }
  }

  private handleTunnelData(msg: any): void {
    const socket = this.tunnelSockets.get(msg.reqId);
    if (socket && !socket.destroyed) {
      socket.write(Buffer.from(msg.data, 'base64'));
    }
  }

  private handleTunnelEnd(msg: any): void {
    const socket = this.tunnelSockets.get(msg.reqId);
    if (socket) {
      socket.end();
      this.tunnelSockets.delete(msg.reqId);
    }
  }

  private send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      this.send({ type: 'ping' });
    }, 30000);
  }

  private cleanup(clearRetry = true): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.logInterval) {
      clearInterval(this.logInterval);
      this.logInterval = null;
    }
    if (clearRetry && this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }

    // Close all tunnel sockets
    for (const [, socket] of this.tunnelSockets) {
      socket.destroy();
    }
    this.tunnelSockets.clear();
  }

  /**
   * Update the auth token used for future WebSocket connections.
   * If the proxy is currently running, it will use the new token on next reconnect.
   */
  updateToken(token: string): void {
    this.config.userToken = token;
    console.log('[ProxyAgent] Auth token updated for next reconnection');
  }

  stop(): void {
    console.log('[ProxyAgent] Stopping...');
    this.intentionallyStopped = true;
    this.running = false;
    this.cleanup(true);

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isRunning(): boolean {
    return this.running && this.ws?.readyState === WebSocket.OPEN;
  }

  isReconnecting(): boolean {
    return !this.intentionallyStopped && !this.running && this.retryTimeout !== null;
  }

  getProxyUrl(): string | null {
    if (!this.isRunning()) return null;
    return 'ws-proxy-active';
  }
}

export default DesktopProxyAgent;
