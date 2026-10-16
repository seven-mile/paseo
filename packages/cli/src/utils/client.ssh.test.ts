import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSshFailureDetail } from "../ssh/ssh-tunnel.js";
import { connectToDaemon } from "./client.js";

const mocks = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  createSshTunnel: vi.fn(),
}));

vi.mock("@getpaseo/client/internal/daemon-client", () => ({
  DaemonClient: class {
    lastError = null;

    constructor(config: Record<string, unknown>) {
      mocks.configs.push(config);
    }

    async connect() {}
    async close() {}
  },
}));

vi.mock("../ssh/ssh-tunnel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ssh/ssh-tunnel.js")>()),
  createSshTunnel: mocks.createSshTunnel,
}));
vi.mock("./client-id.js", () => ({ getOrCreateCliClientId: async () => "cli-test-id" }));

describe("CLI SSH transport", () => {
  beforeEach(() => {
    mocks.configs.length = 0;
    mocks.createSshTunnel.mockReset();
    mocks.createSshTunnel.mockResolvedValue({
      endpoint: "127.0.0.1:4567",
      close: vi.fn(),
      failureDetail: () => null,
    });
  });

  it("surfaces SSH stderr before the child exit event settles", () => {
    expect(resolveSshFailureDetail(null, "Host key verification failed.\n")).toBe(
      "Host key verification failed.",
    );
    expect(resolveSshFailureDetail("ssh exited with code 255", "earlier stderr")).toBe(
      "ssh exited with code 255",
    );
  });

  it.each([
    ["ssh://deploy@build-box:2222", 6769],
    ["ssh://deploy@build-box:2222?daemonPort=6767", 6767],
  ])("selects the fork default without overriding explicit ports: %s", async (host, daemonPort) => {
    await connectToDaemon({ target: { kind: "endpoint", host } });
    expect(mocks.createSshTunnel).toHaveBeenCalledWith({
      host: "deploy@build-box",
      sshPort: 2222,
      daemonPort,
    });
  });

  it.each(["?daemonPort=0", "?daemonPort=1&daemonPort=2"])(
    "rejects invalid SSH ports %s",
    async (query) => {
      await expect(
        connectToDaemon({ target: { kind: "endpoint", host: `ssh://deploy@build-box${query}` } }),
      ).rejects.toThrow();
      expect(mocks.createSshTunnel).not.toHaveBeenCalled();
    },
  );

  it("routes an SSH host through a local tunnel", async () => {
    await connectToDaemon({
      target: { kind: "endpoint", host: "ssh://deploy@build-box:2222?daemonPort=7777" },
    });

    expect(mocks.createSshTunnel).toHaveBeenCalledWith({
      host: "deploy@build-box",
      sshPort: 2222,
      daemonPort: 7777,
    });
    expect(mocks.configs[0]).toMatchObject({
      url: "ws://127.0.0.1:4567/ws",
      clientId: "cli-test-id",
      clientType: "cli",
    });
  });
});
