/**
 * A Unix-socket transport for the demo-stage server, so agents WITHOUT an MCP
 * client can still drive the stateful rehearsal session from the shell.
 *
 *   node mcp/server.mjs --socket /tmp/demoday-stage.sock     (daemon)
 *   node scripts/stage.mjs open --url http://localhost:3000  (client, one call)
 *
 * Wire format is the same newline-delimited JSON-RPC that the stdio transport
 * speaks. Many short-lived client connections share ONE server instance, which is
 * the whole point: the browser, the staged window and the action script live in
 * the daemon between calls. Responses are routed back to whichever connection
 * sent the request (by JSON-RPC id); the server never sends its own requests, so
 * there is no id clash to worry about.
 */
import net from "node:net";
import { unlink } from "node:fs/promises";

export class UnixSocketServerTransport {
  constructor(sockPath) {
    this.sockPath = sockPath;
    this.server = null;
    this.pending = new Map(); // request id -> socket
    this.lastActivity = Date.now();
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  async start() {
    await unlink(this.sockPath).catch(() => {});
    this.server = net.createServer((sock) => this._accept(sock));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.sockPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  _accept(sock) {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          this.onerror?.(e);
          continue;
        }
        this.lastActivity = Date.now();
        if (msg.id !== undefined && msg.method) this.pending.set(String(msg.id), sock);
        this.onmessage?.(msg);
      }
    });
    sock.on("error", (e) => this.onerror?.(e));
    sock.on("close", () => {
      for (const [id, s] of this.pending) if (s === sock) this.pending.delete(id);
    });
  }

  async send(message) {
    if (message.id === undefined) return; // notifications have nobody to go to
    const sock = this.pending.get(String(message.id));
    if (!sock) return;
    this.pending.delete(String(message.id));
    if (!sock.destroyed) sock.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    await new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await unlink(this.sockPath).catch(() => {});
    this.onclose?.();
  }
}
