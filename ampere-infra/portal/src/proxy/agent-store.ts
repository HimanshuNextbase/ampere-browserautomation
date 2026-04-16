import WebSocket from 'ws';

interface ProxyAgent {
  ws: WebSocket;
  agentId: string;
  userId: string;
  proxyPort: number;
  connectedAt: Date;
  lastPing: Date;
}

/** In-memory store for active proxy agent connections, keyed by userId */
const agents = new Map<string, ProxyAgent>();

let counter = 0;

function generateAgentId(): string {
  return `agent-${Date.now()}-${++counter}`;
}

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function getAgent(userId: string): ProxyAgent | undefined {
  return agents.get(userId);
}

export function setAgent(userId: string, agent: ProxyAgent): void {
  agents.set(userId, agent);
}

export function removeAgent(userId: string): void {
  agents.delete(userId);
}

export function hasActiveAgent(userId: string): boolean {
  const agent = agents.get(userId);
  return !!agent && agent.ws.readyState === WebSocket.OPEN;
}

export function getAgentStatus(userId: string) {
  const agent = agents.get(userId);
  if (!agent) return null;
  return {
    agentId: agent.agentId,
    proxyPort: agent.proxyPort,
    connectedAt: agent.connectedAt,
    lastPing: agent.lastPing,
  };
}
