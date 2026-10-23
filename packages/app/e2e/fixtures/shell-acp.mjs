// A scripted ACP agent for E2E: each prompt is a shell command, run in the session cwd with
// the environment Paseo launched this process with, so session-open hooks (PATH shims) apply.
import { spawn } from "node:child_process";
import readline from "node:readline";

const sessions = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function run(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env: process.env });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function prompt({ sessionId, prompt: blocks }) {
  const command = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const { code, output } = await run(command, sessions.get(sessionId));
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `exit ${code}\n\n${output.trim()}` },
      },
    },
  });
  return { stopReason: "end_turn" };
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize")
    result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  if (request.method === "session/new") {
    const sessionId = `shell-${sessions.size + 1}`;
    sessions.set(sessionId, request.params.cwd);
    result = { sessionId };
  }
  if (request.method === "session/prompt") result = await prompt(request.params);
  send({ id: request.id, result });
});
