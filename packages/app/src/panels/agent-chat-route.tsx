import { createContext, useContext, type ReactNode } from "react";
import type { MessagePayload } from "@/composer/types";

// A panel that shows an agent's chat on behalf of something else, such as a Swarm seat, sends the
// chat's messages to that owner and can put its own UI around the composer.
export interface AgentChatRoute {
  // Takes every send in place of the agent. The owner queues sends made during a running turn.
  submit: (payload: MessagePayload) => Promise<void>;
  placeholder?: string;
  aboveComposer?: ReactNode;
  // Shown instead of the composer, for a chat that sends do not reach.
  composerReplacement?: ReactNode;
}

const AgentChatRouteContext = createContext<AgentChatRoute | null>(null);

export const AgentChatRouteProvider = AgentChatRouteContext.Provider;

export function useAgentChatRoute(): AgentChatRoute | null {
  return useContext(AgentChatRouteContext);
}
