#!/usr/bin/env node
// picanva command line. A thin client over the HTTP API in openapi/openapi.yaml.
// Env: PICANVA_URL (default http://127.0.0.1:3100), PICANVA_API_KEY.
import { pathToFileURL } from "node:url";

const USAGE = `Usage:
  picanva health
  picanva items
  picanva push <designId|url> [--title T] [--export URL]... [--format png|mp4] [--auto-export]
               [--pipeline PiPGM1|PiPGM2|PiPGM3] [--no-cue]
  picanva control <next|prev|gotoPage|ftb|mute|play|pause|stop|restart> [--design D] [--page N]
               [--pipeline PiPGM1|PiPGM2|PiPGM3|all] [--on|--off]`;

const FLAGS_WITH_VALUE = new Set(["--title", "--format", "--pipeline", "--design", "--page"]);

/** Splits argv into positionals, single-value flags and repeatable --export values. */
export function parseArgs(argv) {
  const positional = [];
  const flags = { exports: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--export") {
      flags.exports.push(argv[++i]);
    } else if (arg === "--auto-export") {
      flags.autoExport = true;
    } else if (arg === "--no-cue") {
      flags.cue = false;
    } else if (arg === "--on") {
      flags.on = true;
    } else if (arg === "--off") {
      flags.off = true;
    } else if (FLAGS_WITH_VALUE.has(arg)) {
      flags[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** Builds the request for one command. Pure, so it can be tested without a server. */
export function buildRequest(command, args, flags) {
  if (command === "health") return { method: "GET", path: "/health" };
  if (command === "items") return { method: "GET", path: "/api/v1/canva/items" };
  if (command === "push") {
    const [design] = args;
    if (!design) throw new Error(`push needs a design id or URL\n${USAGE}`);
    return {
      method: "POST",
      path: "/api/v1/canva/push",
      body: {
        designId: design,
        ...(flags.title ? { title: flags.title } : {}),
        ...(flags.exports.length ? { exportUrls: flags.exports } : {}),
        ...(flags.format ? { exportFormat: flags.format } : {}),
        ...(flags.autoExport ? { autoExport: true } : {}),
        ...(flags.pipeline ? { targetPipelineId: flags.pipeline } : {}),
        ...(flags.cue === false ? { cueImmediately: false } : {})
      }
    };
  }
  if (command === "control") {
    const [action] = args;
    if (!action) throw new Error(`control needs an action\n${USAGE}`);
    const value = flags.on ? true : flags.off ? false : undefined;
    return {
      method: "POST",
      path: "/api/v1/canva/control",
      body: {
        action,
        ...(flags.design ? { designId: flags.design } : {}),
        ...(flags.page ? { pageNumber: Number(flags.page) } : {}),
        ...(flags.pipeline ? { targetPipelineId: flags.pipeline } : {}),
        ...(value !== undefined && action === "ftb" ? { fadeToBlack: value } : {}),
        ...(value !== undefined && action === "mute" ? { audioEnabled: value } : {})
      }
    };
  }
  throw new Error(`Unknown command "${command}"\n${USAGE}`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  const { positional, flags } = parseArgs(rest);
  const request = buildRequest(command, positional, flags);
  const base = (process.env.PICANVA_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
  const apiKey = process.env.PICANVA_API_KEY?.trim();
  const response = await fetch(`${base}${request.path}`, {
    method: request.method,
    headers: {
      accept: "application/json",
      ...(request.body ? { "content-type": "application/json" } : {}),
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    ...(request.body ? { body: JSON.stringify(request.body) } : {})
  });
  const text = await response.text();
  console.log(text);
  return response.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 2; }
  );
}
