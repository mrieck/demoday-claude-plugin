#!/usr/bin/env node
/**
 * stage.mjs — the demo_* rehearsal tools from the shell.
 *
 * Claude Code (and Codex, via the plugin) talk to mcp/server.mjs as an MCP server.
 * Agents without an MCP client get the same server through this script: the
 * first call starts it as a background daemon on a Unix socket, and every call
 * after that is one tool invocation against that live session — same tools,
 * same action script, same screenshots (written to disk instead of returned
 * inline).
 *
 *   node scripts/stage.mjs tools                       # list tools and their arguments
 *   node scripts/stage.mjs open --url http://localhost:3000 --id feature-1
 *   node scripts/stage.mjs inspect --filter save
 *   node scripts/stage.mjs click --selectors '[data-testid=save]' --label "Save"
 *   node scripts/stage.mjs type --text "Acme Demo" --selectors "#name" --label "name it"
 *   node scripts/stage.mjs save_actions --file demo/<slug>/actions/feature-1.json
 *   node scripts/stage.mjs close
 *   node scripts/stage.mjs stop                        # close the session and end the daemon
 *
 * Tool names may be given with or without the demo_ prefix. Arguments are
 * --flag value pairs coerced by the tool's schema (numbers, booleans, arrays —
 * repeat --selectors for a ladder, or pass a JSON array), or one --json '{...}'.
 * Paths (--file, --cwd, --storageState) are resolved against YOUR cwd, so
 * relative paths behave as they would in any other script.
 *
 * Output: text on stdout; every screenshot is written as a PNG under --shot-dir
 * (default: <tmp>/demoday-stage/) and its path printed as `screenshot: <path>`
 * — open that file with your image tool. Exit code 1 when the tool reports an
 * error.
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SERVER = path.join(ROOT, "mcp", "server.mjs");

const USAGE = "node scripts/stage.mjs <tool|tools|status|stop> [--flag value ...] [--json '{...}'] [--socket path] [--shot-dir dir]";

const PATH_ARGS = new Set(["file", "cwd", "storageState"]);
const CONTROL = new Set(["tools", "status", "stop", "help"]);

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith("--"));
const args = parseArgs(argv.filter((a) => a !== command), { multi: ["selectors"] });

const sockPath = String(args.socket || path.join(os.tmpdir(), `demoday-stage-${os.userInfo().username}.sock`));
const shotDir = path.resolve(String(args["shot-dir"] || path.join(os.tmpdir(), "demoday-stage")));
const logPath = `${sockPath}.log`;
const pidPath = `${sockPath}.pid`;

if (!command || command === "help") {
  console.error(`Usage: ${USAGE}\n\nRun \`node scripts/stage.mjs tools\` to see the tool list.`);
  process.exit(command ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Daemon lifecycle

function tryConnect() {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    sock.once("connect", () => resolve(sock));
    sock.once("error", () => resolve(null));
  });
}

async function ensureDaemon() {
  let sock = await tryConnect();
  if (sock) return sock;
  if (command === "stop" || command === "status") return null;

  await mkdir(path.dirname(logPath), { recursive: true });
  const { openSync } = await import("node:fs");
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [SERVER, "--socket", sockPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  await writeFile(pidPath, String(child.pid));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    sock = await tryConnect();
    if (sock) return sock;
    if (child.exitCode != null) break;
  }
  const log = await readFile(logPath, "utf8").catch(() => "");
  throw new Error(`demo-stage daemon did not start. Log (${logPath}):\n${log.slice(-2000)}`);
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC client over the socket

function rpc(sock) {
  let buf = "";
  let nextId = 1;
  const waiting = new Map();
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiting.get(msg.id);
      if (!w) continue;
      waiting.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : w.resolve(msg.result);
    }
  });
  sock.on("close", () => {
    for (const w of waiting.values()) w.reject(new Error("demo-stage daemon closed the connection"));
    waiting.clear();
  });
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { resolve, reject });
        sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method, params) => sock.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
    end: () => sock.end(),
  };
}

async function handshake(client) {
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "demoday-stage", version: "0.1.0" },
  });
  client.notify("notifications/initialized", {});
}

// ---------------------------------------------------------------------------
// Argument coercion against the tool's own schema

function coerce(value, schema) {
  const type = schema?.type || (Array.isArray(schema?.anyOf) ? schema.anyOf.map((s) => s.type).find(Boolean) : undefined);
  if (type === "array") {
    const arr = Array.isArray(value) ? value : [value];
    const flat = arr.flatMap((v) => {
      if (typeof v === "string" && v.trim().startsWith("[")) {
        try { return JSON.parse(v); } catch { return [v]; }
      }
      return [v];
    });
    return flat.map((v) => coerce(v, schema.items || {}));
  }
  if (type === "number" || type === "integer") {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`expected a number, got ${JSON.stringify(value)}`);
    return n;
  }
  if (type === "boolean") {
    if (value === true || value === false) return value;
    return ["true", "1", "yes"].includes(String(value).toLowerCase());
  }
  return Array.isArray(value) ? value[value.length - 1] : value === true ? "" : String(value);
}

function buildArgs(tool, raw) {
  const props = tool.inputSchema?.properties || {};
  const out = raw.json ? JSON.parse(String(raw.json)) : {};
  for (const [k, v] of Object.entries(raw)) {
    if (["json", "socket", "shot-dir", "raw"].includes(k)) continue;
    if (!(k in props)) throw new Error(`${tool.name} has no argument --${k}. Known: ${Object.keys(props).join(", ") || "(none)"}`);
    out[k] = coerce(v, props[k]);
  }
  for (const k of PATH_ARGS) if (typeof out[k] === "string" && out[k]) out[k] = path.resolve(out[k]);
  const missing = (tool.inputSchema?.required || []).filter((k) => out[k] === undefined);
  if (missing.length) throw new Error(`${tool.name} needs --${missing.join(", --")}`);
  return out;
}

function describeTool(t) {
  const props = t.inputSchema?.properties || {};
  const req = new Set(t.inputSchema?.required || []);
  const flags = Object.entries(props).map(([k, s]) => {
    const type = s.type || "string";
    const desc = s.description ? `  ${s.description}` : "";
    return `    --${k}${req.has(k) ? "" : "?"} <${type}>${desc}`;
  });
  return `${t.name.replace(/^demo_/, "")}  (${t.name})\n  ${t.description}\n${flags.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Result rendering

async function render(result) {
  await mkdir(shotDir, { recursive: true });
  const lines = [];
  for (const c of result.content || []) {
    if (c.type === "text") lines.push(c.text);
    else if (c.type === "image") {
      const file = path.join(shotDir, `shot-${Date.now()}.png`);
      await writeFile(file, Buffer.from(c.data, "base64"));
      lines.push(`screenshot: ${file}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

async function main() {
  const sock = await ensureDaemon();

  if (command === "status") {
    if (!sock) { console.log(`not running (socket ${sockPath})`); return; }
    const client = rpc(sock);
    await handshake(client);
    const script = await client.request("tools/call", { name: "demo_review_script", arguments: {} });
    client.end();
    console.log(`running on ${sockPath}\n${await render(script)}`);
    return;
  }

  if (command === "stop") {
    if (sock) {
      const client = rpc(sock);
      await handshake(client);
      const closed = await client.request("tools/call", { name: "demo_close", arguments: {} }).catch((e) => ({ content: [{ type: "text", text: e.message }] }));
      console.log(await render(closed));
      client.end();
    }
    const pid = Number(await readFile(pidPath, "utf8").catch(() => "")) || null;
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    await unlink(pidPath).catch(() => {});
    if (!sock && !pid) console.log("daemon was not running");
    else console.log("daemon stopped");
    return;
  }

  const client = rpc(sock);
  await handshake(client);
  const { tools } = await client.request("tools/list", {});

  if (command === "tools") {
    client.end();
    console.log(tools.map(describeTool).join("\n\n"));
    console.log(`\nScreenshots go to ${shotDir}. Daemon log: ${logPath}`);
    return;
  }

  const name = command.startsWith("demo_") ? command : `demo_${command}`;
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    client.end();
    throw new Error(`unknown tool "${command}". Try: ${tools.map((t) => t.name.replace(/^demo_/, "")).join(", ")}`);
  }

  const callArgs = buildArgs(tool, args);
  const result = await client.request("tools/call", { name, arguments: callArgs });
  client.end();

  if (args.raw) {
    console.log(JSON.stringify(result));
  } else {
    console.log(await render(result));
  }
  if (result.isError) process.exit(1);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  console.error(`Usage: ${USAGE}`);
  process.exit(1);
});
