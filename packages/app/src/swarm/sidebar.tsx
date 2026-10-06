import AsyncStorage from "@react-native-async-storage/async-storage";
import { ListTodo, Plus, Users } from "lucide-react-native";
import { router } from "expo-router";
import { useCallback, useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { usePluginInstallations } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useFetchQuery } from "@/data/query";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openSwarmTasks } from "./navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { getSidebarRowBackdrop } from "@/components/sidebar/sidebar-row-backdrop";
import { ProjectLeadingVisual } from "@/components/sidebar/project-leading-visual";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { builtinSidebarNavShortcutAction } from "@/sidebar-nav/model";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";

// Follows the Classical sidebar's project/workspace rows; Swarm changes only the semantic slots.

const preferenceSchema = z.object({ mode: z.enum(["classical", "swarm"]) });
type Mode = z.infer<typeof preferenceSchema>["mode"];
export const useSwarmSidebar = create<{ mode: Mode; setMode: (mode: Mode) => void }>()(
  persist((set) => ({ mode: "classical", setMode: (mode) => set({ mode }) }), {
    name: "swarm-sidebar",
    storage: createValidatedPersistStorage(AsyncStorage, preferenceSchema),
    partialize: ({ mode }) => ({ mode }),
  }),
);

const rosterSchema = z.object({
  agents: z.array(
    z.object({
      paseoAgentId: z.string(),
      name: z.string(),
      qualifiedName: z.string().optional(),
      roleClass: z.enum(["planner", "supervisor", "worker"]),
      reportsTo: z.string().nullable(),
      workspaceId: z.string().nullable(),
      retired: z.boolean(),
    }),
  ),
});
type Agent = z.infer<typeof rosterSchema>["agents"][number];
const modes: Array<{ value: Mode; label: string; testID: string }> = [
  { value: "classical", label: "Classical", testID: "swarm-sidebar-classical" },
  { value: "swarm", label: "Swarm", testID: "swarm-sidebar-swarm" },
];
const ThemedUsers = withUnistyles(Users);
const ThemedListTodo = withUnistyles(ListTodo);
const ThemedPlus = withUnistyles(Plus);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function SwarmCreatePlannerNavRow({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const installation = usePluginInstallations("paseo-swarm")[0];
  const selection = useActiveWorkspaceSelection();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("new-workspace"));
  const open = useCallback(() => {
    const serverId = selection?.serverId ?? installation?.serverId;
    if (!serverId) return;
    onBeforeNavigate?.();
    router.push({ pathname: "/new", params: { serverId, swarmRoleClass: "supervisor" } });
  }, [installation?.serverId, onBeforeNavigate, selection?.serverId]);
  return (
    <SidebarHeaderRow
      icon={Plus}
      label="Add supervisor"
      variant="compact"
      shortcutKeys={shortcutKeys}
      onPress={open}
    />
  );
}

export function useOpenSwarmPlanner() {
  const selection = useActiveWorkspaceSelection();
  const installations = usePluginInstallations("paseo-swarm");
  const installation =
    installations.find((candidate) => candidate.serverId === selection?.serverId) ??
    installations[0];
  return useCallback(() => {
    const serverId = selection?.serverId ?? installation?.serverId;
    if (!serverId) return;
    router.push({
      pathname: "/new",
      params: { serverId, swarmRoleClass: "planner" },
    });
  }, [installation?.serverId, selection?.serverId]);
}

function PlannerGroup({
  planner,
  agents,
  serverId,
  selectedAgent,
  onOpenTasks,
  onOpenSurface,
}: {
  planner: Agent;
  agents: Agent[];
  serverId: string;
  selectedAgent?: Agent;
  onOpenTasks: (agent: Agent, planner: Agent) => void;
  onOpenSurface: (surfaceId: string, params?: Record<string, string>) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const openAgent = useCallback(
    (agent: Agent) =>
      navigateToAgent({
        serverId,
        agentId: agent.paseoAgentId,
        workspaceId: agent.workspaceId,
      }),
    [serverId],
  );
  const supervisors = agents.filter(
    (agent) =>
      agent.roleClass === "supervisor" &&
      agent.reportsTo === (planner.qualifiedName ?? planner.name),
  );
  const isSelected = useCallback(
    (agent: Agent) => selectedAgent?.paseoAgentId === agent.paseoAgentId,
    [selectedAgent],
  );
  const openPlanner = useCallback(() => openAgent(planner), [openAgent, planner]);
  const openPlannerTasks = useCallback(() => onOpenTasks(planner, planner), [onOpenTasks, planner]);
  const openAgentTasks = useCallback(
    (agent: Agent) => onOpenTasks(agent, planner),
    [onOpenTasks, planner],
  );
  const openCreateSupervisor = useCallback(
    () =>
      onOpenSurface("native-create-supervisor", { parent: planner.qualifiedName ?? planner.name }),
    [onOpenSurface, planner],
  );
  const openCreateWorker = useCallback(
    (agent: Agent) =>
      onOpenSurface("native-create-worker", { parent: agent.qualifiedName ?? agent.name }),
    [onOpenSurface],
  );
  return (
    <View>
      <PlannerRow
        planner={planner}
        selected={isSelected(planner)}
        expanded={expanded}
        onToggle={toggleExpanded}
        onOpen={openPlanner}
        onOpenTasks={openPlannerTasks}
        onAddSupervisor={openCreateSupervisor}
      />
      {expanded ? (
        <View style={styles.members}>
          {supervisors.map((agent) => (
            <AgentRow
              key={agent.paseoAgentId}
              agent={agent}
              selected={isSelected(agent)}
              members={agents.filter(
                (member) => member.reportsTo === (agent.qualifiedName ?? agent.name),
              )}
              onOpen={openAgent}
              onOpenTasks={openAgentTasks}
              onAddWorker={openCreateWorker}
            />
          ))}
          {supervisors.length === 0 ? (
            <View style={styles.workspaceRow}>
              <View style={styles.workspaceRowMain}>
                <View style={styles.supervisorStatusSlot} />
                <Text style={styles.workspaceTitle}>No supervisors yet</Text>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function PlannerRow({
  planner,
  selected,
  expanded,
  onToggle,
  onOpen,
  onOpenTasks,
  onAddSupervisor,
}: {
  planner: Agent;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onOpenTasks: () => void;
  onAddSupervisor: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const handleFocus = useCallback(() => setHovered(true), []);
  const handleBlur = useCallback(() => setHovered(false), []);
  const handlePressIn = useCallback(() => setPressed(true), []);
  const handlePressOut = useCallback(() => setPressed(false), []);
  const handleTogglePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onToggle();
    },
    [onToggle],
  );
  const handleControlPressStart = useCallback((event: { stopPropagation(): void }) => {
    event.stopPropagation();
  }, []);
  const handleAddSupervisor = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onAddSupervisor();
    },
    [onAddSupervisor],
  );
  const handleOpenTasks = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onOpenTasks();
    },
    [onOpenTasks],
  );
  const rowStyle = useCallback(
    ({ pressed: rowPressed }: PressableStateCallbackType) => [
      styles.projectRow,
      selected && styles.projectRowSelected,
      hovered && styles.projectRowHovered,
      (rowPressed || pressed) && styles.projectRowPressed,
    ],
    [hovered, pressed, selected],
  );
  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={planner.name}
        style={rowStyle}
        highlightStyle={styles.projectRowPressed}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onPress={onOpen}
      >
        <View style={styles.projectRowLeft}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${planner.name}`}
            onTouchStart={handleControlPressStart}
            onPointerDown={handleControlPressStart}
            onPress={handleTogglePress}
            style={styles.chevronButton}
          >
            <ProjectLeadingVisual
              displayName={planner.name}
              iconDataUri={null}
              statusBucket={null}
              projectViewKey={`swarm:${planner.paseoAgentId}`}
              backdrop={getSidebarRowBackdrop({ isHovered: hovered, isPressed: pressed, selected })}
              chevron={expanded ? "collapse" : "expand"}
              showChevron
            />
          </Pressable>
          <Text style={styles.projectTitle} numberOfLines={1}>
            {planner.name}
          </Text>
        </View>
        <View style={styles.projectTrailingActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Add supervisor under ${planner.name}`}
            onTouchStart={handleControlPressStart}
            onPointerDown={handleControlPressStart}
            onPress={handleAddSupervisor}
            style={styles.projectIconActionButton}
          >
            <ThemedPlus size={14} uniProps={mutedColorMapping} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${planner.name} Tasks`}
            testID={`swarm-planner-tasks-${planner.paseoAgentId}`}
            onTouchStart={handleControlPressStart}
            onPointerDown={handleControlPressStart}
            onPress={handleOpenTasks}
            style={styles.projectIconActionButton}
          >
            <ThemedListTodo size={14} uniProps={mutedColorMapping} />
          </Pressable>
        </View>
      </PressHighlight>
    </View>
  );
}

function AgentRow({
  agent,
  members,
  selected,
  onOpen,
  onOpenTasks,
  onAddWorker,
}: {
  agent: Agent;
  members: Agent[];
  selected: boolean;
  onOpen: (agent: Agent) => void;
  onOpenTasks: (agent: Agent) => void;
  onAddWorker: (agent: Agent) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const handlePress = useCallback(() => onOpen(agent), [agent, onOpen]);
  const handleTasks = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onOpenTasks(agent);
    },
    [agent, onOpenTasks],
  );
  const handleAddWorker = useCallback(() => onAddWorker(agent), [agent, onAddWorker]);
  return (
    <View
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      style={[
        styles.workspaceRow,
        selected && styles.workspaceRowSelected,
        hovered && styles.workspaceRowHovered,
      ]}
    >
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={agent.name}
        style={styles.workspaceRowMain}
        highlightStyle={styles.workspaceRowPressed}
        onPress={handlePress}
      >
        <View style={styles.supervisorStatusSlot}>
          <View style={styles.supervisorStatusDot} />
        </View>
        <Text style={styles.workspaceTitle} numberOfLines={1}>
          {agent.name}
        </Text>
      </PressHighlight>
      <View style={styles.projectTrailingActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${agent.name} Tasks`}
          testID={`swarm-agent-tasks-${agent.paseoAgentId}`}
          onPress={handleTasks}
          style={styles.projectIconActionButton}
        >
          <ThemedListTodo size={14} uniProps={mutedColorMapping} />
        </Pressable>
        <RosterHoverCard
          agent={agent}
          members={members}
          onOpen={onOpen}
          onOpenTasks={onOpenTasks}
          onAddWorker={handleAddWorker}
        />
      </View>
    </View>
  );
}

function RosterHoverCard({
  agent,
  members,
  onOpen,
  onOpenTasks,
  onAddWorker,
}: {
  agent: Agent;
  members: Agent[];
  onOpen: (agent: Agent) => void;
  onOpenTasks: (agent: Agent) => void;
  onAddWorker: () => void;
}) {
  const isCompact = useIsCompactFormFactor();
  if (isCompact || !isWeb)
    return (
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger
          accessibilityLabel={`Open ${agent.name} team`}
          style={styles.teamTrigger}
        >
          <ThemedUsers size={14} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent sheetTitle="Agent team">
          {[agent, ...members].map((member) => (
            <RosterMenuEntry
              key={member.paseoAgentId}
              agent={member}
              onOpen={onOpen}
              onOpenTasks={onOpenTasks}
            />
          ))}
          <DropdownMenuItem onSelect={onAddWorker}>Add worker</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  return (
    <HoverCard>
      <HoverCardTrigger focusable accessibilityLabel={`Open ${agent.name} team`}>
        <View style={styles.teamTrigger}>
          <ThemedUsers size={14} uniProps={mutedColorMapping} />
        </View>
      </HoverCardTrigger>
      <HoverCardContent placement="right" role="menu" style={styles.rosterCard}>
        <Text style={styles.rosterTitle}>Agent team</Text>
        <RosterEntry agent={agent} current onOpen={onOpen} onOpenTasks={onOpenTasks} />
        {members.map((member) => (
          <RosterEntry
            key={member.paseoAgentId}
            agent={member}
            onOpen={onOpen}
            onOpenTasks={onOpenTasks}
          />
        ))}
        {members.length === 0 ? <Text style={styles.hint}>No workers yet</Text> : null}
        <Pressable
          accessibilityRole="menuitem"
          accessibilityLabel={`Add worker under ${agent.name}`}
          onPress={onAddWorker}
          style={styles.rosterAction}
        >
          <ThemedPlus size={14} uniProps={mutedColorMapping} />
          <Text style={styles.rosterActionText}>Add worker</Text>
        </Pressable>
      </HoverCardContent>
    </HoverCard>
  );
}

function RosterEntry({
  agent,
  current = false,
  onOpen,
  onOpenTasks,
}: {
  agent: Agent;
  current?: boolean;
  onOpen: (agent: Agent) => void;
  onOpenTasks: (agent: Agent) => void;
}) {
  const handlePress = useCallback(() => onOpen(agent), [agent, onOpen]);
  const handleTasks = useCallback(() => onOpenTasks(agent), [agent, onOpenTasks]);
  return (
    <View style={styles.rosterEntry}>
      <Pressable style={styles.rosterEntryMain} onPress={handlePress} accessibilityRole="menuitem">
        <ThemedUsers size={14} uniProps={mutedColorMapping} />
        <View style={styles.rosterEntryText}>
          <Text style={styles.rosterName}>{agent.name}</Text>
          <Text style={styles.rosterMeta}>{current ? "supervisor" : agent.roleClass}</Text>
        </View>
      </Pressable>
      <Button
        variant="ghost"
        size="xs"
        onPress={handleTasks}
        accessibilityLabel={`Open ${agent.name} Tasks`}
        testID={`swarm-roster-tasks-${agent.paseoAgentId}`}
      >
        Tasks
      </Button>
    </View>
  );
}

function RosterMenuEntry({
  agent,
  onOpen,
  onOpenTasks,
}: {
  agent: Agent;
  onOpen: (agent: Agent) => void;
  onOpenTasks: (agent: Agent) => void;
}) {
  const open = useCallback(() => onOpen(agent), [agent, onOpen]);
  const tasks = useCallback(() => onOpenTasks(agent), [agent, onOpenTasks]);
  return (
    <>
      <DropdownMenuItem onSelect={open}>{agent.name}</DropdownMenuItem>
      <DropdownMenuItem onSelect={tasks}>Tasks for {agent.name}</DropdownMenuItem>
    </>
  );
}

function HostRoster({ plugin }: { plugin: InstalledPlugin }) {
  const selection = useActiveWorkspaceSelection();
  const isCompact = useIsCompactFormFactor();
  const query = useFetchQuery(
    {
      queryKey: ["swarm", "roster", plugin.serverId],
      queryFn: async () => rosterSchema.parse(await plugin.invoke("swarm.board.read", {})),
      refetchInterval: 3000,
      dataShape: "value",
      staleTimeMs: 2500,
    },
    plugin.queryClient,
  );
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const openSurface = useCallback(
    (surfaceId: string, params: Record<string, string> = {}) => {
      if (surfaceId === "native-create-supervisor" || surfaceId === "native-create-worker") {
        router.push({
          pathname: "/new",
          params: {
            serverId: plugin.serverId,
            swarmRoleClass: surfaceId === "native-create-supervisor" ? "supervisor" : "worker",
            ...(params.parent ? { swarmParent: params.parent } : {}),
          },
        });
        return;
      }
    },
    [plugin.serverId],
  );
  const openTasks = useCallback(
    (agent: Agent, planner: Agent) => {
      const workspaceId = agent.workspaceId ?? planner.workspaceId;
      if (!workspaceId) return;
      openSwarmTasks({
        serverId: plugin.serverId,
        workspaceId,
        plannerName: planner.qualifiedName ?? planner.name,
        agentName: agent.roleClass === "planner" ? undefined : (agent.qualifiedName ?? agent.name),
        host: agent.roleClass === "planner" ? "main" : "explorer",
        isCompact,
      });
    },
    [isCompact, plugin.serverId],
  );
  if (query.isPending) return <Text style={styles.hint}>Loading agents…</Text>;
  if (query.isError)
    return (
      <View>
        <Text style={styles.hint}>{query.error.message}</Text>
        <RetryButton onRetry={retry}>Retry</RetryButton>
      </View>
    );
  const agents = query.data.agents.filter((agent) => !agent.retired);
  const selectedAgent =
    selection?.serverId === plugin.serverId
      ? agents.find((agent) => agent.workspaceId === selection.workspaceId)
      : undefined;
  const planners = agents.filter((agent) => agent.roleClass === "planner");
  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Planners</Text>
      </View>
      {planners.map((planner) => (
        <PlannerGroup
          key={planner.paseoAgentId}
          planner={planner}
          agents={agents}
          serverId={plugin.serverId}
          selectedAgent={selectedAgent}
          onOpenTasks={openTasks}
          onOpenSurface={openSurface}
        />
      ))}
      {planners.length === 0 ? <Text style={styles.hint}>No planners yet</Text> : null}
    </View>
  );
}

function RetryButton({ onRetry, children }: { onRetry: () => void; children: ReactNode }) {
  const retry = useCallback(onRetry, [onRetry]);
  return (
    <Button variant="ghost" size="sm" onPress={retry}>
      {children}
    </Button>
  );
}

export function SwarmSidebar({ children }: { children: ReactNode }) {
  const { mode, setMode } = useSwarmSidebar();
  const installations = usePluginInstallations("paseo-swarm");
  return (
    <View style={styles.container}>
      <View style={styles.picker}>
        <SegmentedControl
          options={modes}
          value={mode}
          onValueChange={setMode}
          size="xs"
          testID="swarm-sidebar-mode"
        />
      </View>
      {mode === "classical" ? (
        children
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="swarm-sidebar-list"
        >
          {installations.map((plugin) => (
            <HostRoster key={plugin.serverId} plugin={plugin} />
          ))}
          {installations.length === 0 ? (
            <Text style={styles.hint}>Connect to a host with Swarm enabled.</Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  list: { flex: 1 },
  // Keep the Swarm list in the same outer rail as Classical. The rows below intentionally
  // reuse the same 8px content inset instead of compensating with per-row padding.
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
  },
  picker: { padding: theme.spacing[2] },
  sectionHeader: {
    minHeight: 36,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    justifyContent: "center",
  },
  sectionTitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  members: {},
  projectRow: {
    position: "relative",
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  projectRowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  projectRowSelected: { backgroundColor: theme.colors.surfaceSidebarSelected },
  projectRowPressed: { backgroundColor: theme.colors.surface2 },
  projectRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  chevronButton: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    padding: 0,
  },
  projectTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
  projectTrailingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },
  projectIconActionButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  workspaceRow: {
    minHeight: 36,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  workspaceRowSelected: { backgroundColor: theme.colors.surfaceSidebarSelected },
  workspaceRowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  workspaceRowPressed: { backgroundColor: theme.colors.surface2 },
  workspaceRowMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  supervisorStatusSlot: {
    width: theme.iconSize.md,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  supervisorStatusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  workspaceTitle: {
    color: theme.colors.foreground,
    opacity: 0.76,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    flex: 1,
    minWidth: 0,
  },
  teamTrigger: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  rosterAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rosterActionText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  rosterCard: { width: 220, padding: theme.spacing[2] },
  rosterTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    padding: theme.spacing[2],
  },
  rosterEntry: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rosterEntryText: { flex: 1, minWidth: 0 },
  rosterEntryMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rosterName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  rosterMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
}));
