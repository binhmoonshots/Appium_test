const { spawn, spawnSync } = require("child_process");
const http = require("http");
const path = require("path");

function parseCliArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inlineValue !== undefined ? inlineValue : argv[index + 1];
    args[key] = value;

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return args;
}

function splitList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolArg(value) {
  return /^(1|true|yes|y)$/i.test(String(value || ""));
}

function appiumEntryPath() {
  return path.join(process.cwd(), "node_modules", "appium", "index.js");
}

function adbPath() {
  return process.env.ADB_PATH || "adb";
}

function detectConnectedDevices() {
  const result = spawnSync(adbPath(), ["devices"], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`adb devices failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`adb devices failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([udid, state]) => udid && state === "device")
    .map(([udid]) => udid);
}

function waitForAppium(port, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/status",
          timeout: 1000,
        },
        (res) => {
          res.resume();
          resolve();
        }
      );

      req.on("timeout", () => req.destroy());
      req.on("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Appium server did not start on port ${port}`));
          return;
        }
        setTimeout(check, 500);
      });
    };

    check();
  });
}

async function startAppiumServer(port) {
  const child = spawn(process.execPath, [appiumEntryPath(), "--port", String(port), "--allow-insecure=uiautomator2:adb_shell"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", (chunk) => prefixLines(`appium:${port}`, chunk));
  child.stderr.on("data", (chunk) => prefixLines(`appium:${port} ERR`, chunk));

  await waitForAppium(port);
  return child;
}

function prefixLines(prefix, chunk) {
  String(chunk)
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line) => console.log(`[${prefix}] ${line}`));
}

function forwardArgs(cliArgs) {
  const passthroughKeys = [
    "action",
    "feedLoadSeconds",
    "targetLikes",
    "targetComments",
    "comment",
    "commentData",
    "confirmComment",
    "loopLimit",
    "noMatchBeforeTabChange",
    "minActionDelayMs",
    "maxActionDelayMs",
    "minLoopDelayMs",
    "maxLoopDelayMs",
    "scrollPauseMs",
    "logLevel",
  ];

  const args = [];
  for (const key of passthroughKeys) {
    if (cliArgs[key] !== undefined) {
      args.push(`--${key}`, String(cliArgs[key]));
    }
  }
  return args;
}

function runDevice({ udid, index, baseSystemPort, appiumPort, cliArgs }) {
  return new Promise((resolve) => {
    const systemPort = baseSystemPort + index;
    const child = spawn(process.execPath, ["./scripts/facebook-interact", ...forwardArgs(cliArgs)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ANDROID_DEVICE_UDID: udid,
        APPIUM_PORT: String(appiumPort),
        APPIUM_SYSTEM_PORT: String(systemPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let resultJson = null;

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      const match = text.match(/RESULT_JSON\s+({.*})/);
      if (match) {
        try {
          resultJson = JSON.parse(match[1]);
        } catch (_) {
          resultJson = null;
        }
      }
      prefixLines(udid, text);
    });

    child.stderr.on("data", (chunk) => prefixLines(`${udid} ERR`, chunk));

    child.on("close", (code) => {
      resolve({
        udid,
        appiumPort,
        systemPort,
        exitCode: code,
        result: resultJson,
        ok: code === 0 && resultJson && resultJson.ok,
      });
    });
  });
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const udids =
    splitList(cliArgs.udids || process.env.ANDROID_DEVICE_UDIDS || process.env.UDIDS).length > 0
      ? splitList(cliArgs.udids || process.env.ANDROID_DEVICE_UDIDS || process.env.UDIDS)
      : detectConnectedDevices();
  const baseSystemPort = Number(cliArgs.baseSystemPort || process.env.APPIUM_BASE_SYSTEM_PORT || 8200);
  const appiumPortBase = Number(cliArgs.appiumPortBase || process.env.APPIUM_PORT_BASE || process.env.APPIUM_PORT || 4723);
  const startAppium = boolArg(cliArgs.startAppium || process.env.APPIUM_START_SERVERS);

  if (udids.length === 0) {
    throw new Error("No connected adb devices found. Set --udids or connect Android emulators.");
  }

  const appiumServers = [];
  try {
    if (startAppium) {
      console.log(`Starting ${udids.length} Appium server(s) from port ${appiumPortBase}`);
      for (let index = 0; index < udids.length; index += 1) {
        appiumServers.push(await startAppiumServer(appiumPortBase + index));
      }
    }

    console.log(`Running Facebook interaction on ${udids.length} device(s): ${udids.join(", ")}`);
    const results = await Promise.all(
      udids.map((udid, index) =>
        runDevice({
          udid,
          index,
          baseSystemPort,
          appiumPort: startAppium ? appiumPortBase + index : appiumPortBase,
          cliArgs,
        })
      )
    );

    console.log("MULTI_RESULT_JSON", JSON.stringify({ ok: results.every((item) => item.ok), results }));

    if (!results.every((item) => item.ok)) {
      process.exitCode = 1;
    }
  } finally {
    for (const server of appiumServers) {
      server.kill();
    }
  }
}

main().catch((error) => {
  console.error(error);
  console.log("MULTI_RESULT_JSON", JSON.stringify({ ok: false, error: error.message || String(error) }));
  process.exitCode = 1;
});
