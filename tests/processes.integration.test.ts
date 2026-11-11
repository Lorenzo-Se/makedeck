// Starts a real dev service outside makedeck and scans, stops and adopts it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "processes-test-"));

// Before the import: tmux.ts reads all three when it loads. "Move to makedeck" must start
// this repository's makedeck on a test socket, not one installed in ~/.local/bin, and its
// login shell must not run the user's shell profile.
process.env.MAKEDECK_SOCKET = `processes-test-${process.pid}`;
process.env.PATH = `${new URL("../bin", import.meta.url).pathname}:${process.env.PATH}`;
process.env.HOME = root;
const { listExternalServices, moveToMakedeck, readLogFile, stopExternal } = await import(
  "../raycast/src/processes.ts"
);
const { findBinary } = await import("../raycast/src/tmux.ts");
type Service = import("../raycast/src/tmux.ts").Service;
const MAKEDECK = new URL("../bin/makedeck", import.meta.url).pathname;

const MARK = `PTEST${process.pid}_api`;
const proj = join(root, "proj");
mkdirSync(join(proj, ".git"), { recursive: true });
writeFileSync(
  join(proj, "Makefile"),
  `dev: api\napi:\n\t@exec -a ${MARK} node -e "require('net').createServer().listen(0)"\n`,
);

const ignoreFailure = (fn: () => unknown) => {
  try {
    fn();
  } catch {
    // nothing left to clean up
  }
};

const groups: number[] = [];

after(() => {
  for (const pgid of groups) ignoreFailure(() => process.kill(-pgid, "SIGKILL"));
  ignoreFailure(() => execFileSync("pkill", ["-f", MARK]));
  ignoreFailure(() => execFileSync("tmux", ["-L", process.env.MAKEDECK_SOCKET!, "kill-server"], { stdio: "ignore" }));
  rmSync(root, { recursive: true, force: true });
});

const running = () => {
  try {
    return execFileSync("pgrep", ["-f", MARK]).toString().trim().split("\n").length;
  } catch {
    return 0;
  }
};

// Starts `make api` the way an agent would: in the background, output to a file.
function startOutside(): number {
  const child = spawn("bash", ["-c", "make api > out.log 2>&1"], { cwd: proj, detached: true, stdio: "ignore" });
  child.unref();
  groups.push(child.pid!);
  return child.pid!;
}

async function findApi(services: Service[] = []) {
  for (let i = 0; i < 50; i++) {
    const api = (await listExternalServices(services, root)).find((s) => s.name === "api");
    if (api && api.ports.length > 0) return api;
    await sleep(100);
  }
  return undefined;
}

test("listExternalServices: finds a make target started outside makedeck, with port and log file", async () => {
  startOutside();
  const api = await findApi();

  assert.ok(api, "api was not detected");
  assert.equal(api.project, "proj");
  assert.equal(api.ports.length, 1);
  assert.ok(api.ports[0] > 0);
  assert.ok(api.logPath?.endsWith("/proj/out.log"), `unexpected log path ${api.logPath}`);
  assert.equal(api.makedeckReady, true);
});

test("listExternalServices: processes below a makedeck pane are not external", async () => {
  const api = await findApi();
  assert.ok(api);
  const pane: Service = {
    project: "proj",
    projectPath: proj,
    index: 0,
    windowId: "@0",
    name: "api",
    status: "running",
    exitCode: null,
    pid: api.pgid, // the spawned bash leads the group
  };

  const found = (await listExternalServices([pane], root)).find((s) => s.name === "api");

  assert.equal(found, undefined);
});

test("stopExternal: ends the service, and a second call resolves", async () => {
  const api = await findApi();
  assert.ok(api);

  await stopExternal(api);
  assert.equal(running(), 0);

  await stopExternal(api);
});

// An agent's shell without job control: the server shares the group with the agent.
test("stopExternal: in a shared process group, ends only the service", async () => {
  const agent = spawn("bash", ["-c", "(cd proj && make api > out.log 2>&1) & sleep 300"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });
  agent.unref();
  groups.push(agent.pid!);
  try {
    const api = await findApi();
    assert.ok(api);
    assert.equal(api.pgid, agent.pid);

    await stopExternal(api);

    assert.equal(running(), 0);
    process.kill(agent.pid!, 0); // throws if the "agent" was stopped too
  } finally {
    ignoreFailure(() => process.kill(-agent.pid!, "SIGKILL"));
  }
});

test("readLogFile: reads only the end of a large file and keeps at most maxLines", async () => {
  const path = join(root, "big.log");
  writeFileSync(path, "x".repeat(99) + "\n".repeat(1) + `${"line\n".repeat(220_000)}\x1b[32mLAST\x1b[0m\n`);

  const log = await readLogFile(path, 50);

  assert.ok(log.endsWith("LAST"), `log ends with ${JSON.stringify(log.slice(-20))}`);
  assert.ok(log.split("\n").length <= 50);
});

test("moveToMakedeck: stops the external service and starts the project in makedeck", async () => {
  assert.equal(findBinary("makedeck"), MAKEDECK, "the test must start makedeck from this repository");
  startOutside();
  const api = await findApi();
  assert.ok(api);

  await moveToMakedeck(api.projectPath, [api]);
  await sleep(1000);

  const external = (await listExternalServices([], root)).find((s) => s.name === "api" && s.pid === api.pid);
  assert.equal(external, undefined);
  execFileSync("tmux", ["-L", process.env.MAKEDECK_SOCKET!, "has-session", "-t", "=proj"]);
  assert.equal(running(), 1);
});
