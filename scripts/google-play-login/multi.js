const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
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
    const hasSeparateValue = inlineValue === undefined && argv[index + 1] && !argv[index + 1].startsWith("--");
    const value = inlineValue !== undefined ? inlineValue : hasSeparateValue ? argv[index + 1] : "true";
    args[key] = value;

    if (hasSeparateValue) {
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

function intArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function adbPath() {
  return process.env.ADB_PATH || "adb";
}

function appiumEntryPath() {
  return path.join(process.cwd(), "node_modules", "appium", "index.js");
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

function normalizeAccount(rawAccount, index) {
  const account = typeof rawAccount === "string" ? parseAccountText(rawAccount) : rawAccount;
  if (!account || typeof account !== "object") {
    throw new Error(`Invalid account at index ${index}`);
  }

  const udid = String(account.udid || account.device || account.deviceUdid || "").trim();
  const email = String(account.email || account.googleEmail || account.username || "").trim();
  const password = String(account.password || account.googlePassword || "").trim();

  if (!email) {
    throw new Error(`Missing email for account at index ${index}`);
  }
  if (!password) {
    throw new Error(`Missing password for account ${email}`);
  }

  return { udid, email, password };
}

function parseAccountText(value) {
  const text = String(value || "").trim();
  const parts = text.includes("|") ? text.split("|") : text.split(",");

  if (text.includes("|") && parts.length > 3) {
    throw new Error(`Invalid account "${text.replace(/(password|pass)[^;]*/i, "password***")}". Separate accounts with semicolon: udid|email|password;udid|email|password`);
  }

  if (!text.includes("|") && parts.length > 3) {
    throw new Error("Invalid comma account format. Use email,password or udid,email,password, and separate accounts with semicolon.");
  }

  if (parts.length >= 3) {
    return {
      udid: parts[0].trim(),
      email: parts[1].trim(),
      password: parts.slice(2).join(text.includes("|") ? "|" : ",").trim(),
    };
  }

  if (parts.length === 2) {
    return {
      email: parts[0].trim(),
      password: parts[1].trim(),
    };
  }

  return null;
}

function parseAccountsJson(value, sourceLabel) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error("expected an array");
    }
    return parsed.map(normalizeAccount);
  } catch (error) {
    throw new Error(`Could not parse ${sourceLabel}: ${error.message || error}`);
  }
}

function parseDelimitedAccounts(value) {
  return String(value || "")
    .split(/[;\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeAccount);
}

function loadAccounts(cliArgs) {
  const accountsFile = cliArgs.accountsFile || process.env.GOOGLE_ACCOUNTS_FILE || "";
  if (accountsFile) {
    const resolved = path.resolve(accountsFile);
    return parseAccountsJson(fs.readFileSync(resolved, "utf8"), resolved);
  }

  const inlineAccountsJson = cliArgs.accountsJson || process.env.GOOGLE_ACCOUNTS_JSON || "";
  if (inlineAccountsJson) {
    return parseAccountsJson(inlineAccountsJson, "accounts JSON");
  }

  const inlineAccounts = cliArgs.accounts || process.env.GOOGLE_ACCOUNTS || "";
  if (inlineAccounts) {
    return parseDelimitedAccounts(inlineAccounts);
  }

  const emails = splitList(cliArgs.emails || process.env.GOOGLE_EMAILS || process.env.GMAIL_EMAILS);
  const passwords = splitList(cliArgs.passwords || process.env.GOOGLE_PASSWORDS || process.env.GMAIL_PASSWORDS);
  if (emails.length > 0 || passwords.length > 0) {
    if (emails.length !== passwords.length) {
      throw new Error(`GOOGLE_EMAILS and GOOGLE_PASSWORDS must have the same length. Got ${emails.length} email(s), ${passwords.length} password(s).`);
    }
    return emails.map((email, index) => ({ email, password: passwords[index], udid: "" })).map(normalizeAccount);
  }

  return [];
}

function assignDevices(accounts, requestedUdids) {
  const udids = requestedUdids.length > 0 ? requestedUdids : detectConnectedDevices();
  const hasAccountUdids = accounts.some((account) => account.udid);

  if (accounts.length === 0) {
    throw new Error("Missing accounts. Use --accountsFile, --accounts, or --emails and --passwords.");
  }

  if (hasAccountUdids) {
    const allowedUdids = new Set(udids);
    const selected = accounts.filter((account) => !requestedUdids.length || allowedUdids.has(account.udid));
    const missingUdid = selected.find((account) => !account.udid);
    if (missingUdid) {
      throw new Error(`Account ${missingUdid.email} is missing udid while other accounts include udid.`);
    }
    return selected;
  }

  if (udids.length !== accounts.length) {
    throw new Error(`Device/account count mismatch. Got ${udids.length} device(s) and ${accounts.length} account(s).`);
  }

  return accounts.map((account, index) => ({ ...account, udid: udids[index] }));
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
  const child = spawn(
    process.execPath,
    [
      appiumEntryPath(),
      "--port",
      String(port),
      "--allow-insecure=uiautomator2:adb_shell",
      "--log-level",
      process.env.APPIUM_LOG_LEVEL || "warn",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  child.stdout.on("data", (chunk) => prefixAppiumLines(`appium:${port}`, chunk));
  child.stderr.on("data", (chunk) => prefixAppiumLines(`appium:${port} ERR`, chunk));

  await waitForAppium(port);
  return child;
}

function prefixLines(prefix, chunk) {
  String(chunk)
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line) => console.log(`[${prefix}] ${line}`));
}

function prefixAppiumLines(prefix, chunk) {
  const verbose = boolArg(process.env.APPIUM_VERBOSE);
  String(chunk)
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => verbose || /\b(error|warn|failed|fatal|denied|unable|cannot)\b/i.test(line))
    .forEach((line) => console.log(`[${prefix}] ${line}`));
}

function forwardEnv(cliArgs) {
  return Object.fromEntries(
    Object.entries({
      GOOGLE_LOGIN_CONTACTS_BACKUP: cliArgs.contactsBackup || process.env.GOOGLE_LOGIN_CONTACTS_BACKUP,
      GOOGLE_LOGIN_ACCEPT_TERMS: cliArgs.acceptTerms || process.env.GOOGLE_LOGIN_ACCEPT_TERMS,
      GOOGLE_LOGIN_SKIP_PAYMENT: cliArgs.skipPayment || process.env.GOOGLE_LOGIN_SKIP_PAYMENT,
      GOOGLE_LOGIN_MANUAL_WAIT_SECONDS: cliArgs.manualWaitSeconds || process.env.GOOGLE_LOGIN_MANUAL_WAIT_SECONDS,
      GOOGLE_LOGIN_STEP_DELAY_MS: cliArgs.stepDelayMs || process.env.GOOGLE_LOGIN_STEP_DELAY_MS,
      WDIO_LOG_LEVEL: cliArgs.logLevel || process.env.WDIO_LOG_LEVEL || process.env.LOG_LEVEL,
    }).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function redactResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const clone = { ...result };
  if (clone.password) {
    clone.password = "***";
  }
  return clone;
}

function runDevice({ account, index, baseSystemPort, appiumPort, cliArgs }) {
  return new Promise((resolve) => {
    const systemPort = baseSystemPort + index;
    const child = spawn(process.execPath, ["./scripts/google-play-login"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...forwardEnv(cliArgs),
        ANDROID_DEVICE_UDID: account.udid,
        APPIUM_PORT: String(appiumPort),
        APPIUM_SYSTEM_PORT: String(systemPort),
        GOOGLE_EMAIL: account.email,
        GOOGLE_PASSWORD: account.password,
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
      prefixLines(account.udid, text.replace(account.password, "***"));
    });

    child.stderr.on("data", (chunk) => prefixLines(`${account.udid} ERR`, String(chunk).replace(account.password, "***")));

    child.on("close", (code) => {
      resolve({
        udid: account.udid,
        email: account.email,
        appiumPort,
        systemPort,
        exitCode: code,
        result: redactResult(resultJson),
        ok: code === 0 && resultJson && resultJson.ok,
      });
    });
  });
}

async function runDeviceWithRetries(options, retries, retryDelayMs) {
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    if (attempt > 1) {
      console.log(`[${options.account.udid}] retry ${attempt - 1}/${retries} after ${retryDelayMs}ms`);
      await sleep(retryDelayMs);
    }

    const result = await runDevice(options);
    if (result.ok || attempt > retries) {
      return { ...result, attempts: attempt };
    }
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const requestedUdids = splitList(cliArgs.udids || process.env.ANDROID_DEVICE_UDIDS || process.env.UDIDS);
  const accounts = assignDevices(loadAccounts(cliArgs), requestedUdids);
  const baseSystemPort = Number(cliArgs.baseSystemPort || process.env.APPIUM_BASE_SYSTEM_PORT || 8200);
  const appiumPortBase = Number(cliArgs.appiumPortBase || process.env.APPIUM_PORT_BASE || process.env.APPIUM_PORT || 4723);
  const startAppium = boolArg(cliArgs.startAppium || process.env.APPIUM_START_SERVERS);
  const appiumVerbose = boolArg(cliArgs.appiumVerbose || process.env.APPIUM_VERBOSE);
  const appiumLogLevel = cliArgs.appiumLogLevel || process.env.APPIUM_LOG_LEVEL || "warn";
  const defaultConcurrency = accounts.length > 1 ? 2 : 1;
  const defaultStaggerSeconds = accounts.length > 1 ? 8 : 0;
  const concurrency = Math.max(1, intArg(cliArgs.concurrency || process.env.MULTI_CONCURRENCY, defaultConcurrency));
  const staggerMs = Math.max(0, intArg(cliArgs.staggerMs || process.env.MULTI_STAGGER_MS, intArg(cliArgs.staggerSeconds || process.env.MULTI_STAGGER_SECONDS, defaultStaggerSeconds) * 1000));
  const retries = Math.max(0, intArg(cliArgs.retries || process.env.MULTI_RETRIES, 0));
  const retryDelayMs = Math.max(0, intArg(cliArgs.retryDelayMs || process.env.MULTI_RETRY_DELAY_MS, 15000));
  const dryRun = boolArg(cliArgs.dryRun || process.env.MULTI_DRY_RUN);

  if (accounts.length === 0) {
    throw new Error("No accounts selected for Google Play login.");
  }

  if (dryRun) {
    console.log(
      "MULTI_RESULT_JSON",
      JSON.stringify({
        ok: true,
        dryRun: true,
        accounts: accounts.map((account) => ({ udid: account.udid, email: account.email, password: "***" })),
      })
    );
    return;
  }

  const appiumServers = [];
  try {
    if (startAppium) {
      console.log(`Starting ${accounts.length} Appium server(s) from port ${appiumPortBase}`);
      process.env.APPIUM_VERBOSE = appiumVerbose ? "true" : "";
      process.env.APPIUM_LOG_LEVEL = appiumLogLevel;
      for (let index = 0; index < accounts.length; index += 1) {
        appiumServers.push(await startAppiumServer(appiumPortBase + index));
      }
    }

    console.log(`Running Google Play login on ${accounts.length} device(s): ${accounts.map((account) => `${account.udid}:${account.email}`).join(", ")}`);
    console.log(`Multi options: concurrency=${Math.min(concurrency, accounts.length)}, staggerMs=${staggerMs}, retries=${retries}`);

    const results = await runWithConcurrency(accounts, concurrency, async (account, index) => {
      if (staggerMs > 0) {
        const delay = staggerMs * index;
        console.log(`[${account.udid}] waiting ${delay}ms before start`);
        await sleep(delay);
      }

      return runDeviceWithRetries(
        {
          account,
          index,
          baseSystemPort,
          appiumPort: startAppium ? appiumPortBase + index : appiumPortBase,
          cliArgs,
        },
        retries,
        retryDelayMs
      );
    });

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
