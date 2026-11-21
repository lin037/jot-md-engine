import { existsSync } from "node:fs";
import { once } from "node:events";

// CDP takes KeyboardEvent.key as supplied. Encode the shifted US key value
// separately from the physical code so shortcuts work on every runner.
export function keyboardEventKey(key, modifiers) {
  if (!(modifiers & 8)) return key;
  if (/^[a-z]$/u.test(key)) return key.toUpperCase();
  if (/^[0-9]$/u.test(key)) return ")!@#$%^&*("[Number(key)];
  return key;
}

export function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error("Chrome/Chromium not found; pass --chrome or set CHROME_BIN");
  }
  return found;
}

export async function waitForHttp(url, timeout) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // 进程仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

export async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (request === undefined) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error === undefined) request.resolve(message.result);
    else request.reject(new Error(message.error.message));
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("browser connection closed")); }
    pending.clear();
  });
  const command = (method, params = {}) => {
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`browser command timed out: ${method}`)); }, 30_000);
      pending.set(id, { resolve, reject, timer });
    });
  };
  return {
    socket,
    command,
    async evaluate(expression) {
      const response = await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }).catch((error) => { throw new Error(`${error.message}: ${expression.slice(0, 120)}`); });
      if (response.exceptionDetails !== undefined) {
        throw new Error(response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ?? "browser evaluation failed");
      }
      return response.result.value;
    },
  };
}

export async function waitForEvaluation(client, expression, timeout) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await client.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for browser expression: ${expression}`);
}

export async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}
