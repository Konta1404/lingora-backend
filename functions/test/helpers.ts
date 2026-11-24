import { AddressInfo } from "net";
import { Server } from "http";
import { createApp, AppDeps } from "../src/http/app";

/** Starts the app on a random port and returns a fetch bound to it. */
export async function serve(deps: AppDeps) {
  const server: Server = await new Promise((resolve) => {
    const s = createApp(deps).listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    fetch: (path: string, init?: RequestInit) => fetch(base + path, { redirect: "manual", ...init }),
    call: (name: string, data: unknown, token?: string) =>
      fetch(`${base}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ data }),
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
