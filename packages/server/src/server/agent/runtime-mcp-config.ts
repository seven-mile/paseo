import type { AgentSessionConfig, McpServerConfig } from "./agent-sdk-types.js";
import { SWARM_WAIT_MAX_SECONDS } from "./tools/swarm-wait.js";

export const PASEO_MCP_SERVER_NAME = "paseo";
const PASEO_MCP_PATHNAME = "/mcp/agents";
// The longest Paseo tool call, swarm_wait at its cap, plus room for its last poll and cancel.
export const PASEO_MCP_TOOL_TIMEOUT_SEC = SWARM_WAIT_MAX_SECONDS + 120;

export function stripInternalPaseoMcpServer(config: AgentSessionConfig): AgentSessionConfig {
  const mcpServers = config.mcpServers;
  if (!mcpServers) {
    return config;
  }

  const paseoServer = mcpServers[PASEO_MCP_SERVER_NAME];
  const legacySwarmServer = mcpServers["paseo-swarm"];
  if (
    (!paseoServer || !isInternalPaseoMcpServer(paseoServer)) &&
    (!legacySwarmServer || !isLegacySwarmMcpServer(legacySwarmServer))
  ) {
    return config;
  }

  const nextMcpServers = { ...mcpServers };
  if (paseoServer && isInternalPaseoMcpServer(paseoServer)) {
    delete nextMcpServers[PASEO_MCP_SERVER_NAME];
  }
  if (legacySwarmServer && isLegacySwarmMcpServer(legacySwarmServer)) {
    delete nextMcpServers["paseo-swarm"];
  }

  const next = { ...config };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

export function withRuntimePaseoMcpServer(params: {
  config: AgentSessionConfig;
  agentId: string;
  mcpBaseUrl: string | null;
  /**
   * Capability token authenticating the injected connection to the daemon's
   * Agent MCP endpoint. The daemon password is gated off this route, so without
   * this header the agent's MCP requests are rejected when a password is set.
   */
  mcpAuthToken: string | null;
}): AgentSessionConfig {
  const storedConfig = stripInternalPaseoMcpServer(params.config);
  if (!params.mcpBaseUrl || storedConfig.mcpServers?.[PASEO_MCP_SERVER_NAME]) {
    return storedConfig;
  }

  return {
    ...storedConfig,
    mcpServers: {
      [PASEO_MCP_SERVER_NAME]: {
        type: "http",
        url: `${params.mcpBaseUrl}?callerAgentId=${params.agentId}`,
        alwaysLoad: true,
        toolTimeoutSec: PASEO_MCP_TOOL_TIMEOUT_SEC,
        ...(params.mcpAuthToken
          ? { headers: { Authorization: `Bearer ${params.mcpAuthToken}` } }
          : {}),
      },
      ...storedConfig.mcpServers,
    },
  };
}

function isInternalPaseoMcpServer(config: McpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "sse") {
    return false;
  }

  try {
    return new URL(config.url).pathname === PASEO_MCP_PATHNAME;
  } catch {
    return false;
  }
}

function isLegacySwarmMcpServer(config: McpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "sse") {
    return false;
  }

  try {
    const url = new URL(config.url);
    return url.pathname === "/mcp" && url.searchParams.has("token");
  } catch {
    return false;
  }
}
