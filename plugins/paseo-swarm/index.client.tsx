import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { BoardSurface } from "./client/board";

interface ScreenRegistration {
  id: string;
  title: string;
  Component: ComponentType<PluginSurfaceProps>;
}

function addScreen(client: PluginClientContext, registration: ScreenRegistration): void {
  const modernClient = client as PluginClientContext & {
    addScreen?: (screen: ScreenRegistration) => unknown;
  };
  if (modernClient.addScreen) {
    modernClient.addScreen(registration);
    return;
  }
  client.addSurface(registration.id, registration.Component);
}

export default function contribute(client: PluginClientContext) {
  addScreen(client, { id: "board", title: "Swarm board", Component: BoardSurface });
  return () => {};
}
