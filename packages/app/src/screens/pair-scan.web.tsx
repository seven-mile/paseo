import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";

export default function PairScanScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const handleRouterBack = useCallback(() => router.back(), [router]);
  const closeToSource = useCallback(() => {
    try {
      router.back();
    } catch {
      router.replace("/" as Href);
    }
  }, [router]);

  return (
    <View style={styles.container}>
      <BackHeader title={t("pairing.scan.title")} onBack={handleRouterBack} />
      <View style={styles.body(insets.bottom)}>
        <View style={styles.permissionCard}>
          <Text style={styles.permissionTitle}>{t("pairing.scan.webUnavailableTitle")}</Text>
          <Text style={styles.permissionBody}>{t("pairing.scan.webUnavailableBody")}</Text>
          <Pressable style={styles.permissionButton} onPress={closeToSource}>
            <Text style={styles.permissionButtonText}>{t("pairing.scan.backToSettings")}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: (insetBottom: number) => ({
    flex: 1,
    paddingHorizontal: theme.spacing[6],
    paddingBottom: insetBottom + theme.spacing[6],
  }),
  permissionCard: {
    marginTop: theme.spacing[6],
    padding: theme.spacing[6],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[4],
  },
  permissionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  permissionBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  permissionButton: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.blue[500],
  },
  permissionButtonText: {
    color: theme.colors.palette.white,
    fontWeight: theme.fontWeight.semibold,
  },
}));
