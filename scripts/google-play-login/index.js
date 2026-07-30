const { remote } = require("webdriverio");

const PLAY_STORE_PACKAGE = process.env.PLAY_STORE_PACKAGE || "com.android.vending";
const PLAY_STORE_ACTIVITY = process.env.PLAY_STORE_ACTIVITY || "com.google.android.finsky.activities.MainActivity";

function parseCliArgs(argv) {
  const args = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
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

  if (!args.email && positional[0]) {
    args.email = positional[0];
  }
  if (!args.password && positional[1]) {
    args.password = positional[1];
  }

  return args;
}

function intArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return /^(1|true|yes|y)$/i.test(String(value));
}

const cliArgs = parseCliArgs(process.argv.slice(2));

const config = {
  appiumHost: process.env.APPIUM_HOST || "127.0.0.1",
  appiumPort: intArg(process.env.APPIUM_PORT, 4723),
  systemPort: process.env.APPIUM_SYSTEM_PORT ? intArg(process.env.APPIUM_SYSTEM_PORT, null) : null,
  udid: process.env.ANDROID_DEVICE_UDID || process.env.UDID || "",
  logLevel: cliArgs.logLevel || process.env.WDIO_LOG_LEVEL || process.env.LOG_LEVEL || "error",
  email: cliArgs.email || process.env.GOOGLE_EMAIL || process.env.GMAIL_EMAIL || "",
  password: cliArgs.password || process.env.GOOGLE_PASSWORD || process.env.GMAIL_PASSWORD || "",
  manualWaitSeconds: intArg(cliArgs.manualWaitSeconds || process.env.GOOGLE_LOGIN_MANUAL_WAIT_SECONDS, 180),
  stepDelayMs: Math.max(0, intArg(cliArgs.stepDelayMs || process.env.GOOGLE_LOGIN_STEP_DELAY_MS, 2000)),
  typingDelayMs: Math.max(0, intArg(cliArgs.typingDelayMs || process.env.GOOGLE_LOGIN_TYPING_DELAY_MS, 150)),
  acceptTerms: boolArg(cliArgs.acceptTerms || process.env.GOOGLE_LOGIN_ACCEPT_TERMS, true),
  skipPayment: boolArg(cliArgs.skipPayment || process.env.GOOGLE_LOGIN_SKIP_PAYMENT, true),
  contactsBackup: boolArg(cliArgs.contactsBackup || process.env.GOOGLE_LOGIN_CONTACTS_BACKUP, false),
};

function validateInputs() {
  if (!config.email) {
    throw new Error("Missing email. Use --email or set GOOGLE_EMAIL.");
  }
  if (!config.password) {
    throw new Error("Missing password. Use --password or set GOOGLE_PASSWORD.");
  }
}

async function pause(driver, ms = 1000) {
  await driver.pause(ms + config.stepDelayMs);
}

function escapeUiText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function mobileShell(driver, command, args = []) {
  return driver.execute("mobile: shell", {
    command,
    args: args.map(String),
    includeStderr: true,
    timeout: 20000,
  });
}

async function tuneAppiumSettings(driver) {
  if (typeof driver.updateSettings !== "function") {
    return;
  }

  await driver
    .updateSettings({
      waitForIdleTimeout: 100,
      waitForSelectorTimeout: 500,
    })
    .catch((error) => console.warn("Could not update Appium settings", error.message || error));
}

async function findFirst(driver, selectors, timeout = 700) {
  const endsAt = Date.now() + timeout;

  do {
    for (const selector of selectors) {
      try {
        const elements = await driver.$$(selector);
        if (elements.length > 0) {
          return elements[0];
        }
      } catch (_) {
        // Try the next locator.
      }
    }
    await pause(driver, 200);
  } while (Date.now() < endsAt);

  return null;
}

function parseBounds(bounds) {
  const match = bounds && bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    return null;
  }

  const [, left, top, right, bottom] = match.map(Number);
  return { left, top, right, bottom };
}

async function tapAt(driver, x, y, label) {
  await driver
    .action("pointer", { parameters: { pointerType: "touch" } })
    .move({ x, y })
    .down()
    .pause(80)
    .up()
    .perform();
  console.log(`Tapped ${label} at ${x},${y}`);
}

async function clickElement(driver, element, label) {
  try {
    await element.click();
    console.log(`Clicked ${label}`);
  } catch (error) {
    const bounds = parseBounds(await element.getAttribute("bounds").catch(() => ""));
    if (!bounds) {
      throw error;
    }
    await tapAt(driver, Math.round((bounds.left + bounds.right) / 2), Math.round((bounds.top + bounds.bottom) / 2), label);
  }
}

async function clickIfPresent(driver, selectors, label, timeout = 800) {
  const element = await findFirst(driver, selectors, timeout);
  if (!element) {
    return false;
  }
  await clickElement(driver, element, label);
  await pause(driver, 700);
  return true;
}

function inputFallbackPoint(label, width, height) {
  const yPercent = label === "password" ? 0.455 : 0.51;
  return {
    x: Math.round(width * 0.50),
    y: Math.round(height * yPercent),
  };
}

function inputFallbackPoints(label, width, height) {
  if (label !== "password") {
    return [inputFallbackPoint(label, width, height)];
  }

  return [0.455, 0.445, 0.465, 0.435].map((yPercent) => ({
    x: Math.round(width * 0.50),
    y: Math.round(height * yPercent),
  }));
}

function adbInputText(value) {
  return String(value).replace(/\s/g, "%s");
}

function adbKeyEventForChar(char) {
  const keyEvents = {
    "@": "77",
    ".": "56",
    "-": "69",
    "_": "69",
  };
  return keyEvents[char] || null;
}

async function adbTypeText(driver, value) {
  for (const char of String(value)) {
    const keyEvent = adbKeyEventForChar(char);
    if (keyEvent) {
      await mobileShell(driver, "input", ["keyevent", keyEvent]);
    } else {
      await mobileShell(driver, "input", ["text", adbInputText(char)]);
    }
    await pause(driver, config.typingDelayMs);
  }
}

async function pasteText(driver, value) {
  const content = Buffer.from(String(value), "utf8").toString("base64");
  await driver.setClipboard(content, "plaintext", "google-login-input");
  await pause(driver, 250);
  await mobileShell(driver, "input", ["keyevent", "279"]);
  await pause(driver, 900);
}

async function typeFocusedElement(driver, value, label) {
  const focused = await findFirst(driver, ['android=new UiSelector().focused(true)'], 800);
  if (!focused) {
    return false;
  }

  await pasteText(driver, value);
  console.log(`Pasted ${label} through focused element`);
  return true;
}

async function typeWithKeyboardFallback(driver, value, label) {
  const { width, height } = await driver.getWindowSize();
  const points = inputFallbackPoints(label, width, height);

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    await tapAt(driver, point.x, point.y, `${label} input fallback ${index + 1}`);
    await pause(driver, 700);

    try {
      await pasteText(driver, value);
      console.log(`Pasted ${label} with clipboard fallback`);
      return;
    } catch (error) {
      console.warn(`clipboard paste failed for ${label}; trying next fallback`, error.message || error);
    }

  }

  try {
    await adbTypeText(driver, value);
  } catch (adbError) {
    console.warn(`adb input text failed for ${label}; trying driver.keys`, adbError.message || adbError);
    await driver.keys(value);
  }

  console.log(`Typed ${label} with fallback typing`);
}

async function typeIntoFirst(driver, selectors, value, label, timeout = 8000) {
  const element = await findFirst(driver, selectors, timeout);
  if (!element) {
    await typeWithKeyboardFallback(driver, value, label);
    return;
  }

  await clickElement(driver, element, label);
  await pause(driver, 300);
  await element.clearValue().catch(() => undefined);
  try {
    await pasteText(driver, value);
  } catch (error) {
    console.warn(`clipboard paste failed for ${label}; trying fallback typing`, error.message || error);
    await typeWithKeyboardFallback(driver, value, label);
    return;
  }
  console.log(`Pasted ${label}`);
}

function nextSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)^next$")',
    'android=new UiSelector().descriptionMatches("(?i)^next$")',
    'android=new UiSelector().resourceId("identifierNext")',
    'android=new UiSelector().resourceIdMatches("(?i).*identifierNext.*")',
    '//*[@text="NEXT" or @text="Next"]',
  ];
}

function signInSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)sign in")',
    'android=new UiSelector().descriptionMatches("(?i)sign in")',
    'android=new UiSelector().resourceIdMatches("(?i).*(sign.?in|setup).*")',
  ];
}

function emailInputSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)^(email or phone|email|phone)$")',
    'android=new UiSelector().descriptionMatches("(?i)^(email or phone|email|phone)$")',
    'android=new UiSelector().className("android.widget.EditText").resourceIdMatches("(?i).*identifierId.*")',
    'android=new UiSelector().className("android.widget.EditText").textMatches("(?i)(email|phone)")',
    '//*[@text="Email or phone" or @content-desc="Email or phone"]',
    '//*[contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"email or phone")]',
    'android=new UiSelector().className("android.widget.EditText").instance(0)',
    '//android.widget.EditText',
  ];
}

function passwordInputSelectors() {
  return [
    'android=new UiSelector().className("android.widget.EditText").instance(0)',
    '//android.widget.EditText',
    'android=new UiSelector().textMatches("(?i)^(enter your password|password)$")',
    'android=new UiSelector().descriptionMatches("(?i)^(enter your password|password)$")',
    'android=new UiSelector().className("android.widget.EditText").resourceIdMatches("(?i).*password.*")',
    'android=new UiSelector().className("android.widget.EditText").textMatches("(?i)(password|enter your password)")',
    '//*[@text="Enter your password" or @text="Password" or @content-desc="Enter your password" or @content-desc="Password"]',
    '//*[contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"password")]',
  ];
}

async function revealPasswordIfAvailable(driver) {
  const checkbox = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^show password$")',
      'android=new UiSelector().descriptionMatches("(?i)^show password$")',
    ],
    1000
  );

  if (checkbox && (await checkbox.getAttribute("checked").catch(() => "false")) !== "true") {
    await clickElement(driver, checkbox, "Show password");
    await pause(driver, 300);
  }
}

function successSelectors() {
  return [
    'android=new UiSelector().resourceIdMatches("(?i).*(search_box|search_box_text|search_box_idle_text|search_bar|account_avatar|toolbar).*")',
    'android=new UiSelector().descriptionMatches("(?i)^(search|search apps.*|account|notifications|profile)$")',
    'android=new UiSelector().textMatches("(?i)^(for you|top charts|kids|categories|games|apps|offers|books|play pass|manage apps.*|search apps.*)$")',
  ];
}

async function isSignInScreenVisible(driver, timeout = 700) {
  return Boolean(await findFirst(driver, signInSelectors(), timeout));
}

async function isSignedIn(driver, timeout = 1500) {
  if (await isSignInScreenVisible(driver, 500)) {
    return false;
  }
  return Boolean(await findFirst(driver, successSelectors(), timeout));
}

function accountMenuSelectors() {
  return [
    'android=new UiSelector().descriptionMatches("(?i)^(account|profile|google account)$")',
    'android=new UiSelector().resourceIdMatches("(?i).*(account_avatar|avatar|profile).*")',
  ];
}

function accountSwitcherSelectors() {
  return [
    'android=new UiSelector().descriptionMatches("(?i)(switch account|show accounts|expand account|account options)")',
    'android=new UiSelector().resourceIdMatches("(?i).*(account_switcher|expand|dropdown).*")',
  ];
}

function addAnotherAccountSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)(add another account|add account)")',
    'android=new UiSelector().descriptionMatches("(?i)(add another account|add account)")',
  ];
}

function emailRegex() {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
}

async function visibleEmails(driver) {
  const source = await driver.getPageSource().catch(() => "");
  return [...new Set((source.match(emailRegex()) || []).map((email) => email.toLowerCase()))];
}

async function openAccountMenu(driver) {
  if ((await visibleEmails(driver)).length > 0) {
    return true;
  }

  const opened = await clickIfPresent(driver, accountMenuSelectors(), "account menu", 2500);
  if (opened) {
    await pause(driver, 1200);
    return true;
  }

  const { width, height } = await driver.getWindowSize();
  const fallbacks = [
    [0.90, 0.14],
    [0.94, 0.14],
    [0.88, 0.12],
  ];

  for (const [px, py] of fallbacks) {
    await tapAt(driver, Math.round(width * px), Math.round(height * py), "account menu fallback");
    await pause(driver, 1000);
    if ((await visibleEmails(driver)).length > 0) {
      return true;
    }
  }

  return false;
}

async function chooseOrAddTargetAccount(driver) {
  const targetEmail = config.email.toLowerCase();
  await openAccountMenu(driver);

  let emails = await visibleEmails(driver);
  if (emails.includes(targetEmail)) {
    await clickIfPresent(driver, [`android=new UiSelector().text("${escapeUiText(config.email)}")`], "target account", 1200);
    console.log(`Target Google account is available: ${config.email}`);
    return "already-signed-in";
  }

  if (emails.length > 0) {
    console.log(`Current Google account(s): ${emails.join(", ")}; target is ${config.email}`);
  }

  await clickIfPresent(driver, accountSwitcherSelectors(), "account switcher", 1200);
  await pause(driver, 800);

  emails = await visibleEmails(driver);
  if (emails.includes(targetEmail)) {
    await clickIfPresent(driver, [`android=new UiSelector().text("${escapeUiText(config.email)}")`], "target account", 1200);
    return "already-signed-in";
  }

  const clickedAdd = await clickIfPresent(driver, addAnotherAccountSelectors(), "Add another account", 2500);
  if (clickedAdd) {
    await pause(driver, 3000);
    return "add-account";
  }

  throw new Error(
    `Play Store is signed in with ${emails.join(", ") || "another account"}, but target ${config.email} is not available and Add another account was not found.`
  );
}

function manualVerificationSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)(verify|2-step|two-step|security code|captcha|not a robot|check your phone)")',
    'android=new UiSelector().descriptionMatches("(?i)(verify|2-step|two-step|security code|captcha|not a robot|check your phone)")',
  ];
}

async function throwIfGooglePlayErrorScreen(driver) {
  const errorScreen = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^something went wrong$")',
      'android=new UiSelector().descriptionMatches("(?i)^something went wrong$")',
    ],
    700
  );

  if (!errorScreen) {
    return;
  }

  throw new Error("Google Play error screen detected: Something went wrong. Please go back and try again.");
}

async function openPlayStore(driver) {
  await mobileShell(driver, "am", ["start", "-n", `${PLAY_STORE_PACKAGE}/${PLAY_STORE_ACTIVITY}`]);
  console.log("Opening Play Store and waiting for it to load");

  const readyBy = Date.now() + 30000;
  const readySelectors = [
    ...successSelectors(),
    ...signInSelectors(),
    ...emailInputSelectors(),
    'android=new UiSelector().textMatches("(?i)^welcome to google play$")',
  ];
  do {
    if (await findFirst(driver, readySelectors, 700)) {
      console.log("Play Store is ready");
      return;
    }
    await pause(driver, 500);
  } while (Date.now() < readyBy);

  console.warn("Play Store did not expose a ready element within 30 seconds; continuing with the login flow");
}

async function handlePlayWelcomeScreen(driver) {
  const welcome = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^welcome to google play$")',
      'android=new UiSelector().descriptionMatches("(?i)^welcome to google play$")',
    ],
    1500
  );

  if (!welcome) {
    return false;
  }

  const clicked = await clickIfPresent(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^get started$")',
      'android=new UiSelector().descriptionMatches("(?i)^get started$")',
    ],
    "Get started",
    3000
  );

  if (!clicked) {
    throw new Error("Google Play welcome screen was detected but the Get started button was not found.");
  }

  await pause(driver, 2000);
  return true;
}

async function pressNext(driver, label = "Next") {
  const clicked = await clickIfPresent(driver, nextSelectors(), label, 5000);
  if (clicked) {
    return true;
  }

  const { width, height } = await driver.getWindowSize();
  await tapAt(driver, Math.round(width * 0.86), Math.round(height * 0.88), `${label} fallback`);
  await pause(driver, 1000);
  return false;
}

async function scrollDownScreen(driver, label = "screen") {
  const { width, height } = await driver.getWindowSize();
  const x = Math.round(width * 0.5);
  await driver
    .action("pointer", { parameters: { pointerType: "touch" } })
    .move({ x, y: Math.round(height * 0.82) })
    .down()
    .pause(120)
    .move({ x, y: Math.round(height * 0.34), duration: 550 })
    .up()
    .perform();
  console.log(`Scrolled ${label}`);
}

async function handleDeviceUserPrompt(driver) {
  const prompt = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)who will be using this device\\?")',
      'android=new UiSelector().descriptionMatches("(?i)who will be using this device\\?")',
    ],
    700
  );

  if (!prompt) {
    return false;
  }

  await clickIfPresent(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^i will be using this device$")',
      'android=new UiSelector().descriptionMatches("(?i)^i will be using this device$")',
    ],
    "I will be using this device",
    2000
  );
  await pause(driver, 500);
  await scrollDownScreen(driver, "device user prompt").catch(() => undefined);
  await pause(driver, 500);
  await pressNext(driver, "device user Next");
  return true;
}

async function handleContactsSyncPrompt(driver) {
  const prompt = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)never lose your contacts")',
      'android=new UiSelector().descriptionMatches("(?i)never lose your contacts")',
    ],
    700
  );

  if (!prompt) {
    return false;
  }

  await scrollDownScreen(driver, "contacts sync prompt").catch(() => undefined);
  await pause(driver, 500);

  const selectors = config.contactsBackup
    ? [
        'android=new UiSelector().textMatches("(?i)^turn on backup$")',
        'android=new UiSelector().descriptionMatches("(?i)^turn on backup$")',
      ]
    : [
        'android=new UiSelector().textMatches("(?i)^(don.t turn on|do not turn on|not now|skip)$")',
        'android=new UiSelector().descriptionMatches("(?i)^(don.t turn on|do not turn on|not now|skip)$")',
      ];

  const clicked = await clickIfPresent(driver, selectors, config.contactsBackup ? "Turn on Backup" : "Do not turn on contacts backup", 2500);
  if (!clicked) {
    await pressNext(driver, "contacts sync fallback");
  }
  return true;
}

async function handlePlayRestartPrompt(driver) {
  const prompt = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^restart the app to complete the update$")',
      'android=new UiSelector().descriptionMatches("(?i)^restart the app to complete the update$")',
    ],
    700
  );

  if (!prompt) {
    return false;
  }

  const clicked = await clickIfPresent(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^restart$")',
      'android=new UiSelector().descriptionMatches("(?i)^restart$")',
    ],
    "Restart Play Store",
    2500
  );

  if (clicked) {
    console.log("Waiting for Google Play to restart after its update");
    await pause(driver, 5000);
  }

  return clicked;
}

async function handleCommonButtons(driver) {
  if (await handlePlayRestartPrompt(driver)) {
    return true;
  }

  if (await handleContactsSyncPrompt(driver)) {
    return true;
  }

  if (await handleDeviceUserPrompt(driver)) {
    return true;
  }

  const buttonGroups = [
    {
      label: "I agree",
      enabled: config.acceptTerms,
      selectors: [
        'android=new UiSelector().textMatches("(?i)(i agree|agree)")',
        'android=new UiSelector().descriptionMatches("(?i)(i agree|agree)")',
      ],
    },
    {
      label: "Accept",
      enabled: config.acceptTerms,
      selectors: [
        'android=new UiSelector().textMatches("(?i)(accept|more)")',
        'android=new UiSelector().descriptionMatches("(?i)(accept|more)")',
      ],
    },
    {
      label: "Skip payment",
      enabled: config.skipPayment,
      selectors: [
        'android=new UiSelector().textMatches("(?i)(skip|not now|no thanks)")',
        'android=new UiSelector().descriptionMatches("(?i)(skip|not now|no thanks)")',
      ],
    },
  ];

  let clickedAny = false;
  for (const group of buttonGroups) {
    if (!group.enabled) {
      continue;
    }
    const clicked = await clickIfPresent(driver, group.selectors, group.label, 1500);
    clickedAny = clickedAny || clicked;
  }
  return clickedAny;
}

async function waitForManualVerification(driver) {
  const manualPrompt = await findFirst(driver, manualVerificationSelectors(), 1500);
  if (!manualPrompt) {
    return false;
  }

  console.log(`Manual verification detected. Complete it on the device within ${config.manualWaitSeconds}s.`);
  const endsAt = Date.now() + config.manualWaitSeconds * 1000;
  while (Date.now() < endsAt) {
    if (await isSignedIn(driver, 1000)) {
      return true;
    }
    await handleCommonButtons(driver);
    await pause(driver, 2000);
  }

  throw new Error("Timed out waiting for manual Google verification.");
}

async function runLoginFlow(driver) {
  await openPlayStore(driver);
  await handlePlayWelcomeScreen(driver);

  if (await isSignedIn(driver, 2500)) {
    const accountStatus = await chooseOrAddTargetAccount(driver);
    if (accountStatus === "already-signed-in") {
      console.log("Play Store already has the target Google account");
      return "already-signed-in";
    }
    console.log("Adding target Google account through Play Store");
  }

  await clickIfPresent(driver, signInSelectors(), "Sign in", 8000);
  await pause(driver, 3000);
  await throwIfGooglePlayErrorScreen(driver);

  await typeIntoFirst(driver, emailInputSelectors(), config.email, "email");
  await pressNext(driver, "email Next");
  await pause(driver, 4000);

  await throwIfGooglePlayErrorScreen(driver);
  await waitForManualVerification(driver);
  await typeIntoFirst(driver, passwordInputSelectors(), config.password, "password", 12000);
  await revealPasswordIfAvailable(driver);
  await pressNext(driver, "password Next");
  await pause(driver, 5000);

  await throwIfGooglePlayErrorScreen(driver);
  await waitForManualVerification(driver);

  for (let attempt = 1; attempt <= 16; attempt += 1) {
    await throwIfGooglePlayErrorScreen(driver);

    if (await isSignedIn(driver, 1500)) {
      console.log("Play Store home detected");
      return "signed-in";
    }

    const clicked = await handleCommonButtons(driver);
    if (!clicked) {
      await pressNext(driver, `post-login Next ${attempt}`);
    }
    await pause(driver, 2000);
  }

  throw new Error("Could not confirm Play Store login. Check the device screen for extra prompts.");
}

async function main() {
  validateInputs();

  const driver = await remote({
    hostname: config.appiumHost,
    port: config.appiumPort,
    path: "/",
    logLevel: config.logLevel,
    capabilities: {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "Android",
      ...(config.udid ? { "appium:udid": config.udid } : {}),
      ...(config.systemPort ? { "appium:systemPort": config.systemPort } : {}),
      "appium:autoLaunch": false,
      "appium:noReset": true,
      "appium:fullReset": false,
      "appium:newCommandTimeout": 180,
    },
  });

  try {
    await tuneAppiumSettings(driver);
    console.log(`Connected to ${config.udid || "default Android device"}`);
    console.log(`Google email: ${config.email}`);
    const status = await runLoginFlow(driver);
    return {
      ok: true,
      status,
      deviceUdid: config.udid || null,
      packageName: PLAY_STORE_PACKAGE,
      email: config.email,
    };
  } finally {
    await driver.deleteSession().catch((error) => {
      console.warn("Could not delete Appium session cleanly", error.message || error);
    });
  }
}

main()
  .then((result) => {
    console.log("RESULT_JSON", JSON.stringify(result));
  })
  .catch((error) => {
    console.error(error);
    console.log(
      "RESULT_JSON",
      JSON.stringify({
        ok: false,
        error: error.message || String(error),
        deviceUdid: config.udid || null,
        packageName: PLAY_STORE_PACKAGE,
        email: config.email,
      })
    );
    process.exitCode = 1;
  });
