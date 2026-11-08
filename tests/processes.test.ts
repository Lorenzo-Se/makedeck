import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type DetectInput,
  type OpenFiles,
  type Proc,
  candidatePids,
  cleanLog,
  detectExternal,
  devPrereqs,
  makeTargets,
  parseFiles,
  parseListeners,
  parsePs,
} from "../raycast/src/processes.ts";

test("parsePs: pid, ppid, pgid and the full command line", () => {
  assert.deepEqual(parsePs("51094 51091 51062 node /x/node_modules/.bin/expo start --port 8081\n"), [
    { pid: 51094, ppid: 51091, pgid: 51062, args: "node /x/node_modules/.bin/expo start --port 8081" },
  ]);
});

test("parsePs: right-aligned columns", () => {
  assert.deepEqual(parsePs("  123     1   123 /usr/bin/make app\n"), [
    { pid: 123, ppid: 1, pgid: 123, args: "/usr/bin/make app" },
  ]);
});

test("parseListeners: ports per PID, IPv4 and IPv6", () => {
  const out = "p11\nf10\nn*:3000\nf11\nn127.0.0.1:5173\np12\nf4\nn[::1]:8080\n";
  assert.deepEqual(
    parseListeners(out),
    new Map([
      [11, [3000, 5173]],
      [12, [8080]],
    ]),
  );
});

test("parseListeners: the same port on IPv4 and IPv6 counts once", () => {
  assert.deepEqual(parseListeners("p11\nn*:3000\nn[::1]:3000\n"), new Map([[11, [3000]]]));
});

test("parseFiles: cwd and stdout per PID", () => {
  assert.deepEqual(
    parseFiles("p5\nfcwd\ntDIR\nn/p\nf1\ntREG\nn/tmp/x.log\n"),
    new Map([[5, { cwd: "/p", stdout: { type: "REG", name: "/tmp/x.log" } }]]),
  );
});

test("makeTargets: make and gmake by any path", () => {
  assert.deepEqual(makeTargets("/Applications/Xcode.app/Contents/Developer/usr/bin/make app"), ["app"]);
  assert.deepEqual(makeTargets("gmake api"), ["api"]);
});

test("makeTargets: skips flags, their arguments, numbers and variables", () => {
  assert.deepEqual(makeTargets("make -j 4 -C dir FOO=1 dev api"), ["dev", "api"]);
  assert.deepEqual(makeTargets("make -f other.mk -I inc worker"), ["worker"]);
});

test("makeTargets: no targets, and commands that are not make", () => {
  assert.deepEqual(makeTargets("make"), []);
  assert.equal(makeTargets("node make.js"), null);
});

test("devPrereqs: prerequisites of dev without the ## comment", () => {
  assert.deepEqual(devPrereqs("x: y\ndev: api worker ## c\n"), ["api", "worker"]);
});

test("devPrereqs: no dev line, and dev-stop is not dev", () => {
  assert.deepEqual(devPrereqs("x: y\n"), []);
  assert.deepEqual(devPrereqs("dev-stop: infra\n"), []);
});

test("cleanLog: strips ANSI colors and keeps the last state of \\r progress lines", () => {
  assert.equal(cleanLog("\x1b[32mready\x1b[0m\nload 10%\rload 100%\n"), "ready\nload 100%\n");
});

test("cleanLog: CRLF line endings keep their text", () => {
  assert.equal(cleanLog("one\r\ntwo\r\n"), "one\ntwo\n");
});

test("cleanLog: strips cursor movement and OSC title sequences", () => {
  assert.equal(cleanLog("\x1b[2K\x1b[1Gbuilt\x1b]0;title\x07 ok\n"), "built ok\n");
});

// Modeled on processes seen on a real machine; home is /Users/u.
const HOME = "/Users/u";
const LONG = "/opt/tool/bin/server --config /Users/u/my.app/config/settings.yaml --verbose --port 9100";
const PROCS: Proc[] = [
  // Orphaned `make app` (its shell is gone) whose expo child listens; stdout in a file.
  { pid: 51091, ppid: 1, pgid: 51062, args: "/Applications/Xcode.app/Contents/Developer/usr/bin/make app" },
  { pid: 51094, ppid: 51091, pgid: 51062, args: "node /x/node_modules/.bin/expo start --port 8081" },
  // A makedeck pane and its child.
  { pid: 55048, ppid: 55000, pgid: 55048, args: "make app" },
  { pid: 55050, ppid: 55048, pgid: 55048, args: "node expo start --port 8082" },
  // A daemon: reparented to launchd and leads its own group.
  { pid: 4000, ppid: 1, pgid: 4000, args: "adb -L tcp:5037 fork-server server --reply-fd 4" },
  // An interactive shell in an editor terminal.
  { pid: 5999, ppid: 5000, pgid: 5999, args: "-zsh" },
  // `make android` with a listening emulator and a listening grandchild.
  { pid: 6000, ppid: 5999, pgid: 6000, args: "make android" },
  { pid: 6001, ppid: 6000, pgid: 6000, args: "/Users/u/Library/Android/sdk/emulator/qemu/qemu-system-aarch64 -avd P" },
  { pid: 6002, ppid: 6001, pgid: 6000, args: "/Users/u/Library/Android/sdk/emulator/netsimd" },
  // `make test`: not a dev prerequisite, no listener.
  { pid: 7000, ppid: 5999, pgid: 7000, args: "make test" },
  // `make worker`: a dev prerequisite without a listener, with a sub-make.
  { pid: 7100, ppid: 5999, pgid: 7100, args: "make worker" },
  { pid: 7101, ppid: 7100, pgid: 7100, args: "/usr/bin/make app" },
  // Plain listeners.
  { pid: 8000, ppid: 5999, pgid: 8000, args: "node server.js" },
  { pid: 8100, ppid: 5999, pgid: 8100, args: "python3 -m http.server" },
  { pid: 8200, ppid: 5999, pgid: 8200, args: "ruby x.rb" },
  { pid: 8300, ppid: 5999, pgid: 8300, args: "/usr/local/bin/node /Users/u/mono/node_modules/.bin/vite --port 9000" },
  { pid: 8400, ppid: 5999, pgid: 8400, args: LONG },
  // Exits between ps and lsof: no open files.
  { pid: 8500, ppid: 5999, pgid: 8500, args: "node gone.js" },
];
const LISTENERS = new Map<number, number[]>([
  [51094, [8081]],
  [55050, [8082]],
  [4000, [5037]],
  [6001, [5554, 5555]],
  [6002, [8554]],
  [8000, [3000]],
  [8100, [8000]],
  [8200, [4567]],
  [8300, [9000]],
  [8400, [9100]],
  [8500, [9200]],
]);
const reg = (name: string): OpenFiles["stdout"] => ({ type: "REG", name });
const FILES = new Map<number, OpenFiles>([
  [51091, { cwd: "/Users/u/three", stdout: reg("/tmp/metro.log") }],
  [51094, { cwd: "/Users/u/three", stdout: reg("/tmp/metro.log") }],
  [4000, { cwd: "/Users/u/three", stdout: { type: "CHR", name: "/dev/null" } }],
  [6000, { cwd: "/Users/u/droid", stdout: { type: "CHR", name: "/dev/ttys003" } }],
  [6001, { cwd: "/Users/u/droid", stdout: { type: "CHR", name: "/dev/ttys003" } }],
  [6002, { cwd: "/", stdout: { type: "CHR", name: "/dev/ttys003" } }],
  [7000, { cwd: "/Users/u/droid", stdout: { type: "CHR", name: "/dev/ttys004" } }],
  [7100, { cwd: "/Users/u/three", stdout: { type: "CHR", name: "/dev/ttys004" } }],
  [7101, { cwd: "/Users/u/three", stdout: { type: "CHR", name: "/dev/ttys004" } }],
  [8000, { cwd: "/Users/u/web/src", stdout: { type: "CHR", name: "/dev/ttys005" } }],
  [8100, { cwd: "/Users/u/notes", stdout: { type: "CHR", name: "/dev/ttys006" } }],
  [8200, { cwd: "/tmp/x", stdout: { type: "CHR", name: "/dev/ttys006" } }],
  [8300, { cwd: "/Users/u/mono/app/src", stdout: { type: "PIPE", name: "->0x1" } }],
  [8400, { cwd: "/Users/u/my.app" }],
]);
const MAKEFILES: Record<string, string> = {
  "/Users/u/three": "dev: app worker\napp:\nworker:\n",
  "/Users/u/droid": "dev: api\napi:\nandroid:\ntest:\n",
};
const REPOS = new Set(["/Users/u", "/Users/u/three", "/Users/u/droid", "/Users/u/web", "/Users/u/mono", "/Users/u/my.app"]);
const INPUT: DetectInput = {
  procs: PROCS,
  listeners: LISTENERS,
  files: FILES,
  panePids: new Set([55048]),
  sessionPaths: ["/Users/u/mono/app"],
  home: HOME,
  readMakefile: (dir) => MAKEFILES[dir] ?? null,
  isRepoRoot: (dir) => REPOS.has(dir),
};

const detected = detectExternal(INPUT);
const byPid = (pid: number) => detected.find((s) => s.pid === pid);

test("detectExternal: exactly the expected services", () => {
  assert.deepEqual(
    detected.map((s) => s.pid).sort((a, b) => a - b),
    [6000, 7100, 8000, 8300, 8400, 51091],
  );
});

test("detectExternal: orphaned make with a listening child is one service with its log file", () => {
  assert.deepEqual(byPid(51091), {
    id: "ext:51091",
    pid: 51091,
    pgid: 51062,
    project: "three",
    projectPath: "/Users/u/three",
    name: "app",
    command: "/Applications/Xcode.app/Contents/Developer/usr/bin/make app",
    ports: [8081],
    logPath: "/tmp/metro.log",
    stdout: "/tmp/metro.log",
    makedeckReady: true,
  });
});

test("detectExternal: processes below a makedeck pane are not external", () => {
  assert.equal(byPid(55048), undefined);
  assert.equal(byPid(55050), undefined);
});

test("detectExternal: a daemon (ppid 1, own group) is ignored even when it listens in a repo", () => {
  assert.equal(byPid(4000), undefined);
});

test("detectExternal: make that is no dev prerequisite counts through its listeners, with all their ports", () => {
  const android = byPid(6000);
  assert.equal(android?.name, "android");
  assert.deepEqual(android?.ports, [5554, 5555, 8554]);
  assert.equal(android?.project, "droid");
  assert.equal(byPid(6001), undefined);
  assert.equal(byPid(6002), undefined);
});

test("detectExternal: make without listener counts only as a dev prerequisite", () => {
  assert.equal(byPid(7000), undefined);
  assert.deepEqual(byPid(7100)?.ports, []);
  assert.equal(byPid(7100)?.name, "worker");
});

test("detectExternal: a sub-make below a kept make is not listed separately", () => {
  assert.equal(byPid(7101), undefined);
});

test("detectExternal: plain listener belongs to its Git repository; a terminal is no log", () => {
  const web = byPid(8000);
  assert.equal(web?.project, "web");
  assert.equal(web?.projectPath, "/Users/u/web");
  assert.equal(web?.logPath, null);
  assert.equal(web?.stdout, "/dev/ttys005");
  assert.equal(web?.name, "node server.js");
  assert.equal(web?.makedeckReady, false);
});

test("detectExternal: a repository at home or no repository at all gives no project", () => {
  assert.equal(byPid(8100), undefined);
  assert.equal(byPid(8200), undefined);
});

test("detectExternal: a makedeck session path wins over the enclosing repository", () => {
  const vite = byPid(8300);
  assert.equal(vite?.projectPath, "/Users/u/mono/app");
  assert.equal(vite?.project, "app");
  assert.equal(vite?.name, "node vite --port 9000");
});

test("detectExternal: project names replace '.' and ':' like session names; long names are cut", () => {
  const svc = byPid(8400);
  assert.equal(svc?.project, "my_app");
  assert.equal(svc?.stdout, null);
  // "server --config settings.yaml --verbose --port 9100" has 51 characters.
  assert.equal(svc?.name, "server --config settings.yaml --verbose…");
  assert.equal(svc?.name.length, 40);
  assert.equal(svc?.command, LONG);
});

test("detectExternal: a candidate that exited before lsof is dropped without throwing", () => {
  assert.equal(byPid(8500), undefined);
});

test("candidatePids: makes and non-daemon listeners outside makedeck panes", () => {
  assert.deepEqual(
    candidatePids(PROCS, LISTENERS, new Set([55048])).sort((a, b) => a - b),
    [6000, 6001, 6002, 7000, 7100, 7101, 8000, 8100, 8200, 8300, 8400, 8500, 51091, 51094],
  );
});
