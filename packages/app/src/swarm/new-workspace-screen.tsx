import { useEffect, useMemo, useState } from "react";
import { useNavigation } from "expo-router";
import { createNameId } from "mnemonic-id";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { useTranslation } from "react-i18next";
import { NewWorkspaceScreen, type SwarmWorkspaceOptions } from "@/screens/new-workspace-screen";
import { usePluginInstallations } from "@/plugins/registry";
import { swarmTaskBoardSchema } from "./task-model";
import { type SwarmRoleClass } from "./rpc";
import { z } from "zod";
import { openSwarmCreationFormDraft } from "./parent-selection";
import { pwaSourceSchema, pwaRoleSchema, readSwarmAgentCreationConfig } from "./pwa-form-model";

const rolesSchema = z.array(pwaRoleSchema);

export interface SwarmNewWorkspaceScreenProps {
  serverId: string;
  sourceDirectory?: string;
  projectId?: string;
  displayName?: string;
  draftId?: string;
  roleClass: SwarmRoleClass;
  parentName?: string;
}

export function SwarmNewWorkspaceScreen({
  serverId,
  sourceDirectory,
  projectId,
  displayName,
  draftId,
  roleClass,
  parentName,
}: SwarmNewWorkspaceScreenProps) {
  const { t } = useTranslation();
  const installations = usePluginInstallations("paseo-swarm");
  const navigation = useNavigation();
  const [draft] = useState(() => {
    const create = () => ({
      form: openSwarmCreationFormDraft(roleClass),
      worktreeSlug: createNameId(),
    });
    return draftId
      ? useWorkspaceDraftSubmissionStore.getState().retainSwarmDraft({ draftId, create })
      : create();
  });
  // Unmount also means a responsive remount. Only an explicit route removal abandons this draft.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        if (draftId) useWorkspaceDraftSubmissionStore.getState().clearSwarmDraft({ draftId });
      }),
    [draftId, navigation],
  );
  const options = useMemo<SwarmWorkspaceOptions>(() => {
    return {
      roleClass,
      initialParent: parentName,
      initialName: roleClass,
      draft: draft.form,
      worktreeSlug: draft.worktreeSlug,
      forServer(targetServerId) {
        const installation = installations.find((plugin) => plugin.serverId === targetServerId);
        if (!installation) return undefined;
        return {
          async loadTarget(target) {
            const [sourceResponse, boardResponse] = await Promise.all([
              installation.invoke("swarm.pwa_source.read", { projectId: target.projectId }),
              installation.invoke("swarm.board.read", {}),
            ]);
            const source = pwaSourceSchema.parse(sourceResponse);
            const board = swarmTaskBoardSchema.parse(boardResponse);
            let parentRoleClass: "planner" | "supervisor" | null = null;
            if (roleClass === "supervisor") parentRoleClass = "planner";
            if (roleClass === "worker") parentRoleClass = "supervisor";
            const parents = board.agents
              .filter((agent) => agent.roleClass === parentRoleClass && !agent.retired)
              .map((agent) => ({
                name: agent.qualifiedName ?? agent.name,
                title: agent.qualifiedName ?? agent.name,
                displayName: agent.name,
                paseoAgentId: agent.paseoAgentId,
                serverId: target.serverId,
                workspaceId: agent.workspaceId,
                pwaBinding: agent.pwaBinding,
              }));
            return { source, parents };
          },
          async loadRoles({ target, directory, parentName: selectedParent }) {
            return rolesSchema.parse(
              await installation.invoke("swarm.pwa_roles.read", {
                roleClass,
                projectId: target.projectId,
                path: selectedParent ? undefined : directory,
                parentName: selectedParent ?? undefined,
              }),
            );
          },
          readAgentConfig({ target, ...input }) {
            return readSwarmAgentCreationConfig(installation.invoke, {
              ...input,
              projectId: target.projectId,
              roleClass,
            });
          },
        };
      },
    };
  }, [installations, parentName, roleClass, draft]);
  return (
    <NewWorkspaceScreen
      serverId={serverId}
      sourceDirectory={sourceDirectory}
      projectId={projectId}
      displayName={displayName}
      draftId={draftId}
      title={t("newWorkspace.roleTitle", { role: t(`swarm.roles.${roleClass}`) })}
      swarm={options}
    />
  );
}
