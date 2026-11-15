#!/usr/bin/env tsx
/**
 * agentos CLI.
 *   agentos init                      create the local admin login and first API key
 *   agentos init --username U --password-stdin   non-interactive (scripts, CI)
 *   agentos dev                       start local Supabase, the API (:4000) and the Console (:5173)
 *   agentos admin reset-password      reset the admin password on this machine
 *   agentos keys create <name>        create another API key
 *   agentos status                    show what's configured
 *   agentos run <agent> "<message>"   start a session and follow it live (see run.ts)
 *   agentos cloud init | check         cloud credentials (see cloud.ts, docs/cloud-setup.md)
 *   agentos remote add|list|remove     other AgentOS installs to push to (see push.ts)
 *   agentos push <agent> --to <remote> copy an agent version (+ environment, deployment) there
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_PATH,
  hashPassword,
  loadConfig,
  newApiKey,
  saveConfig,
  type LocalConfig,
} from "../../api/src/lib/config.ts";
import { runCommand } from "./run.ts";
import { cloudCommand } from "./cloud.ts";
import { pushCommand, remoteCommand } from "./push.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Mask typed characters.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.startsWith(question)) process.stdout.write(question);
        else if (s.includes("\n") || s.includes("\r")) process.stdout.write("\n");
        else process.stdout.write("*");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      done(answer.trim());
    });
  });
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function validatePassword(pw: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters.";
  return null;
}

async function init() {
  if (loadConfig() && !process.argv.includes("--force")) {
    console.log(`AgentOS is already initialised (${CONFIG_PATH}).`);
    console.log("Use `agentos admin reset-password` to change the password, or `agentos init --force` to start over.");
    return;
  }
  const username = flag("username") ?? (await ask("Admin username: "));
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new Error("Username must be 3–32 letters, numbers, dots, dashes or underscores.");

  let password: string;
  if (process.argv.includes("--password-stdin")) {
    password = await readStdin();
  } else {
    password = await ask("Admin password (min 10 chars): ", true);
    const confirm = await ask("Confirm password: ", true);
    if (password !== confirm) throw new Error("Passwords don't match.");
  }
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);

  const { salt, hash } = hashPassword(password);
  const { key, record } = newApiKey("default");
  const cfg: LocalConfig = {
    admin: { username, password_hash: hash, salt },
    session_secret: randomBytes(32).toString("hex"),
    api_keys: [record],
  };
  saveConfig(cfg);

  console.log(`\n✔ AgentOS initialised. Config: ${CONFIG_PATH}`);
  console.log(`✔ Admin user: ${username}`);
  console.log("\nYour API key (shown once; use it with the Anthropic SDK or curl as x-api-key):");
  console.log(`  ${key}\n`);
  console.log("Next: `pnpm agentos dev`, then open http://localhost:5173 and sign in.");
}

async function resetPassword() {
  const cfg = loadConfig();
  if (!cfg) throw new Error("AgentOS isn't initialised. Run `agentos init` first.");
  const password = process.argv.includes("--password-stdin") ? await readStdin() : await ask("New admin password: ", true);
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  const { salt, hash } = hashPassword(password);
  cfg.admin.salt = salt;
  cfg.admin.password_hash = hash;
  cfg.session_secret = randomBytes(32).toString("hex"); // signs everyone out
  saveConfig(cfg);
  console.log("✔ Password updated. All Console sessions were signed out.");
}

function createKey(name = "key") {
  const cfg = loadConfig();
  if (!cfg) throw new Error("AgentOS isn't initialised. Run `agentos init` first.");
  const { key, record } = newApiKey(name);
  cfg.api_keys.push(record);
  saveConfig(cfg);
  console.log(`✔ API key "${name}" created (shown once):\n  ${key}`);
}

function status() {
  const cfg = loadConfig();
  console.log(`Config:     ${CONFIG_PATH}${cfg ? "" : " (missing)"}`);
  if (!cfg) return;
  console.log(`Admin:      ${cfg.admin.username}`);
  console.log(`API keys:   ${cfg.api_keys.map((k) => `${k.name} (${k.hint})`).join(", ")}`);
  console.log(`OpenRouter: ${cfg.openrouter ? `${cfg.openrouter.hint} — ${cfg.openrouter.status}` : "not configured"}`);
}

function run(cmd: string, args: string[], name: string) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const prefix = (line: string) => `[${name}] ${line}`;
  child.stdout.on("data", (d: Buffer) => d.toString().split("\n").filter(Boolean).forEach((l) => console.log(prefix(l))));
  child.stderr.on("data", (d: Buffer) => d.toString().split("\n").filter(Boolean).forEach((l) => console.error(prefix(l))));
  return child;
}

async function dev() {
  if (!loadConfig()) throw new Error("Run `pnpm agentos init` first to create the admin login.");
  if (!process.argv.includes("--no-db")) {
    console.log("Starting local Supabase (first run downloads images)…");
    await new Promise<void>((done) => {
      const p = run("supabase", ["start", "-x", "studio,imgproxy,inbucket,edge-runtime,logflare,vector,supavisor"], "db");
      p.on("exit", () => done());
    });
  }
  const api = run("pnpm", ["--filter", "@agentos/api", "dev"], "api");
  const ui = run("pnpm", ["--filter", "@agentos/console", "dev"], "console");
  console.log("\nAgentOS is starting: Console http://localhost:5173 · API http://localhost:4000\n");
  const stop = () => {
    api.kill();
    ui.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const [cmd, sub, arg] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
  init,
  dev,
  status,
  run: runCommand,
  cloud: () => cloudCommand(sub),
  remote: () => remoteCommand(sub, arg, process.argv[5]),
  push: () => pushCommand(),
  admin: () => (sub === "reset-password" ? resetPassword() : console.log("Usage: agentos admin reset-password")),
  keys: () => (sub === "create" ? createKey(arg) : console.log("Usage: agentos keys create <name>")),
};

const fn = cmd ? commands[cmd] : undefined;
if (!fn) {
  console.log('Usage: agentos <init | dev | status | run <agent> "<message>" | cloud init|check | remote add|list|remove | push <agent> --to <remote> | admin reset-password | keys create <name>>');
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(fn()).catch((err: Error) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
