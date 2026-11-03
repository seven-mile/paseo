import { useCallback, useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react-native";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { HeaderIconBadge } from "@/components/headers/header-icon-badge";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { useInstalledPlugin } from "@/plugins/registry";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { buildHostRootRoute } from "@/utils/host-routes";
import { useSwarmSeat } from "./roster";
import { seatRecipient } from "./seat-mail";
import { SeatConversation, ThemedSeatIcon } from "./seat-panel";

const ThemedX = withUnistyles(X);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EMPTY_SHORTCUT_KEYS: ShortcutKey[] = [];

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

// A seat with no workspace yet, such as a supervisor before its first message. Its first message
// places it, and the screen then moves to the seat's tab in that workspace.
export function SwarmSeatScreen() {
  return (
    <HostRouteBootstrapBoundary>
      <SwarmSeatScreenContent />
    </HostRouteBootstrapBoundary>
  );
}

function SwarmSeatScreenContent() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    seatId?: string | string[];
  }>();
  const serverId = routeParam(params.serverId);
  const seatId = routeParam(params.seatId);
  const plugin = useInstalledPlugin(serverId, "paseo-swarm");
  const { seat } = useSwarmSeat(plugin, seatId);
  const workspaceId = seat?.workspaceId ?? null;
  const movedRef = useRef(false);
  useEffect(() => {
    if (!workspaceId || movedRef.current) return;
    movedRef.current = true;
    navigateToWorkspace({ serverId, workspaceId, target: { kind: "swarm_seat", seatId } });
  }, [seatId, serverId, workspaceId]);
  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(buildHostRootRoute(serverId));
  }, [serverId]);
  const title = seat ? seatRecipient(seat) : t("swarm.seat.tabLabel");
  const headerLeft = useMemo(
    () => (
      <>
        <HeaderIconBadge>
          <ThemedSeatIcon size={ICON_SIZE.md} uniProps={mutedColorMapping} />
        </HeaderIconBadge>
        <ScreenTitle testID="swarm-seat-title">{title}</ScreenTitle>
      </>
    ),
    [title],
  );
  const closeLabel = t("common.actions.close");
  const headerRight = useMemo(
    () => (
      <HeaderToggleButton
        accessibilityLabel={closeLabel}
        onPress={close}
        testID="swarm-seat-close"
        tooltipKeys={EMPTY_SHORTCUT_KEYS}
        tooltipLabel={closeLabel}
        tooltipSide="bottom"
      >
        <ThemedX size={18} uniProps={mutedColorMapping} />
      </HeaderToggleButton>
    ),
    [close, closeLabel],
  );
  return (
    <View style={styles.screen}>
      <ScreenHeader left={headerLeft} right={headerRight} />
      <SeatConversation serverId={serverId} seatId={seatId} workspaceId={null} isPaneFocused />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
