// Starts real projects with bin/makedeck on a dedicated tmux socket.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

process.env.MAKEDECK_SOCKET = `raycast-test-${process.pid}`;
const { listServices, restartService, stopProject, stopService, terminateProcesses } = await import(
  "../raycast/src/tmux.ts"
);

const MAKEDECK = new URL("../bin/makedeck", import.meta.url).pathname;
const dirs: string[] = [];

const ignoreFailure = (fn: () => unknown) => {
  try {
    fn();
  } catch {
    // nothing left to clean up
  }
};

after(() => {
  ignoreFailure(() => execFileSync("pkill", ["-f", `KTEST${process.pid}_`]));
  ignoreFailure(() => execFileSync("tmux", ["-L", process.env.MAKEDECK_SOCKET!, "kill-server"], { stdio: "ignore" }));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Processes carry a unique marker so pgrep finds only them.
const marker = (name: string) => `KTEST${process.pid}_${name}`;
const running = (name: string) => {
  try {
    return execFileSync("pgrep", ["-f", marker(name)])
      .toString()
      .trim()
      .split("\n").length;
  } catch {
    return 0;
  }
};

function startProject(makefile: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync("/tmp/raycast-test-");
  dirs.push(dir);
  writeFileSync(join(dir, "Makefile"), makefile);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  execFileSync("bash", [MAKEDECK], { cwd: dir, env: process.env, stdio: "ignore" });
  return dir;
}

test("stopProject: ends processes including background and nohup ones, and runs dev-stop", async () => {
  const dir = startProject(
    `dev: web worker\n` +
      `web:\n\t@exec -a ${marker("web")} sleep 300\n` +
      `worker:\n\t@nohup bash -c 'exec -a ${marker("nohup")} sleep 300' >/dev/null 2>&1 & exec -a ${marker("worker")} sleep 300\n` +
      `dev-stop:\n\t@touch stopped\n`,
  );
  await sleep(1000);
  assert.equal(running("web") + running("worker") + running("nohup"), 3);

  const project = basename(dir).replaceAll(".", "_");
  await stopProject(project, dir);
  await sleep(1000);

  assert.equal(running("web") + running("worker") + running("nohup"), 0);
  assert.ok(existsSync(join(dir, "stopped")), "make dev-stop did not run");
  assert.equal((await listServices()).filter((s) => s.project === project).length, 0);
});

test("restartService: ends the old process before starting the new one", async () => {
  const dir = startProject(`dev: api\napi:\n\t@exec -a ${marker("api")} sleep 300\n`);
  await sleep(1000);
  const project = basename(dir).replaceAll(".", "_");
  const [api] = (await listServices()).filter((s) => s.project === project);

  await restartService(api.windowId);
  await sleep(1000);

  assert.equal(running("api"), 1);
});

test(
  "stopService: waits for and kills a child that ignores SIGTERM and SIGHUP after the pane exits",
  async () => {
    const dir = startProject(
      `dev: api\napi:\n\t@bash -c 'trap "" TERM HUP; exec -a ${marker("stubborn")} sleep 300' & exec -a ${marker("main")} sleep 300\n`,
    );
    await sleep(1000);
    const project = basename(dir).replaceAll(".", "_");
    const [api] = (await listServices()).filter((s) => s.project === project);
    assert.equal(running("stubborn") + running("main"), 2);

    await stopService(api.windowId);

    assert.equal(running("stubborn") + running("main"), 0);
  },
);

test("stopProject: runs dev-stop defined in an included file", async () => {
  const dir = startProject(`include stop.mk\ndev: web\nweb:\n\t@exec -a ${marker("web3")} sleep 300\n`, {
    "stop.mk": "dev-stop:\n\t@touch stopped\n",
  });
  await sleep(1000);
  const project = basename(dir).replaceAll(".", "_");

  assert.equal(await stopProject(project, dir), true);
  assert.ok(existsSync(join(dir, "stopped")), "make dev-stop did not run");
});

test("stopProject: a project without dev-stop reports that it did not run", async () => {
  const dir = startProject(`dev: web\nweb:\n\t@exec -a ${marker("web4")} sleep 300\n`);
  await sleep(1000);
  const project = basename(dir).replaceAll(".", "_");

  assert.equal(await stopProject(project, dir), false);
});

test("stopProject: a failing sub-make in dev-stop is reported, not treated as a missing target", async () => {
  const dir = startProject(
    `dev: web\nweb:\n\t@exec -a ${marker("web5")} sleep 300\ndev-stop:\n\t@$(MAKE) -C sub dev-stop\n`,
  );
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "Makefile"), "other:\n");
  await sleep(1000);
  const project = basename(dir).replaceAll(".", "_");

  await assert.rejects(stopProject(project, dir), /No rule to make target/);
});

// Exited panes have no PID; this used to become kill(-0) on our own process group,
// which killed Raycast (here: the test runner).
test("stopProject: a project with an exited pane stops only that project", async () => {
  const dir = startProject(`dev: setup web\nsetup:\n\t@true\nweb:\n\t@exec -a ${marker("web2")} sleep 300\n`);
  await sleep(1000);
  const project = basename(dir).replaceAll(".", "_");
  assert.ok((await listServices()).some((s) => s.project === project && s.status === "exited"));

  await stopProject(project, dir);
  await sleep(500);

  assert.equal(running("web2"), 0);
});

test("restartService: restarts an exited service", async () => {
  const dir = startProject(`dev: setup\nsetup:\n\t@echo run\n`);
  await sleep(1000);
  const project = basename(dir).replaceAll(".", "_");
  const [setup] = (await listServices()).filter((s) => s.project === project);
  assert.equal(setup.status, "exited");

  await restartService(setup.windowId);
});

const groupExists = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

test("terminateProcesses: ends a detached process group", async () => {
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  child.unref();
  const pgid = child.pid!;
  assert.ok(groupExists(pgid));

  try {
    await terminateProcesses({ groups: [pgid], pids: [] });
    assert.equal(groupExists(pgid), false);
  } finally {
    if (groupExists(pgid)) process.kill(-pgid, "SIGKILL");
  }
});

test("terminateProcesses: a group that no longer exists resolves", async () => {
  const child = spawn("true", [], { detached: true, stdio: "ignore" });
  const pgid = child.pid!;
  await new Promise((resolve) => child.on("exit", resolve));
  await sleep(100);

  await terminateProcesses({ groups: [pgid], pids: [] });
});

test("terminateProcesses: refuses to signal its own process group", async () => {
  const ownGroup = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)]).toString().trim());
  await assert.rejects(terminateProcesses({ groups: [ownGroup], pids: [] }), /refusing to signal own process group/);
});

// macOS reports EPERM, not ESRCH, for a group whose processes have all exited but are not
// yet reaped (zombies), e.g. right after SIGKILL. That group has ended.
test("terminateProcesses: a group of zombies counts as ended", async () => {
  const parent = spawn(
    "/usr/bin/perl",
    ["-e", 'my $c = fork(); if ($c == 0) { setpgrp(0, 0); exit 0 } $| = 1; print "$c\\n"; sleep 30'],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    const pgid = Number(
      await new Promise<string>((resolve) => parent.stdout!.once("data", (data) => resolve(String(data).trim()))),
    );
    await sleep(300); // the child has left its group as a zombie: the parent does not reap it

    await terminateProcesses({ groups: [pgid], pids: [] });
  } finally {
    parent.kill("SIGKILL");
  }
});
