const { remote } = require("webdriverio");
const fs = require("fs");
const path = require("path");

const FACEBOOK_PACKAGE = process.env.FB_PACKAGE || "com.facebook.katana";
const FACEBOOK_ACTIVITY = process.env.FB_ACTIVITY || "com.facebook.katana.LoginActivity";

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

  if (!args.action && positional[0]) {
    args.action = positional[0];
  }
  if (!args.comment && positional[1]) {
    args.comment = positional.slice(1).join(" ");
  }

  return args;
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return /^(1|true|yes|y)$/i.test(String(value));
}

function intArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitList(value) {
  return String(value || "")
    .split(/[,\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickRandom(items) {
  return items[randomInt(0, items.length - 1)];
}

function resolveDataPath(value) {
  if (!value) {
    return "";
  }

  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function loadCommentData(filePath, fallbackComment) {
  const comments = splitList(fallbackComment);
  const resolvedPath = resolveDataPath(filePath);

  if (!resolvedPath) {
    return comments;
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Comment data file does not exist: ${resolvedPath}`);
  }

  const fileComments = splitList(fs.readFileSync(resolvedPath, "utf8"));
  return fileComments.length > 0 ? fileComments : comments;
}

const cliArgs = parseCliArgs(process.argv.slice(2));

const config = {
  appiumHost: process.env.APPIUM_HOST || "127.0.0.1",
  appiumPort: intArg(process.env.APPIUM_PORT, 4723),
  systemPort: process.env.APPIUM_SYSTEM_PORT ? intArg(process.env.APPIUM_SYSTEM_PORT, null) : null,
  udid: process.env.ANDROID_DEVICE_UDID || process.env.UDID || "",
  logLevel: cliArgs.logLevel || process.env.WDIO_LOG_LEVEL || process.env.LOG_LEVEL || "error",
  action: (cliArgs.action || process.env.FB_ACTION || "scroll").toLowerCase(),
  interactionSeconds: intArg(cliArgs.interactionSeconds || process.env.FB_INTERACTION_SECONDS, 30),
  maxActions: intArg(cliArgs.maxActions || process.env.FB_MAX_ACTIONS, 3),
  comment: cliArgs.comment || process.env.FB_COMMENT || "",
  commentDataPath: cliArgs.commentData || cliArgs.commentDataPath || process.env.FB_COMMENT_DATA || "",
  feedLoadSeconds: intArg(cliArgs.feedLoadSeconds || process.env.FB_FEED_LOAD_SECONDS, 8),
  targetLikes: intArg(cliArgs.targetLikes || process.env.FB_TARGET_LIKES, 3),
  targetComments: intArg(cliArgs.targetComments || process.env.FB_TARGET_COMMENTS, 1),
  loopLimit: intArg(cliArgs.loopLimit || process.env.FB_LOOP_LIMIT, 30),
  noMatchBeforeTabChange: intArg(cliArgs.noMatchBeforeTabChange || process.env.FB_NO_MATCH_BEFORE_TAB_CHANGE, 4),
  minActionDelayMs: intArg(cliArgs.minActionDelayMs || process.env.FB_MIN_ACTION_DELAY_MS, 1000),
  maxActionDelayMs: intArg(cliArgs.maxActionDelayMs || process.env.FB_MAX_ACTION_DELAY_MS, 3000),
  minLoopDelayMs: intArg(cliArgs.minLoopDelayMs || process.env.FB_MIN_LOOP_DELAY_MS, 10000),
  maxLoopDelayMs: intArg(cliArgs.maxLoopDelayMs || process.env.FB_MAX_LOOP_DELAY_MS, 30000),
  confirmComment: boolArg(cliArgs.confirmComment || process.env.FB_CONFIRM_COMMENT, false),
  scrollPauseMs: intArg(cliArgs.scrollPauseMs || process.env.FB_SCROLL_PAUSE_MS, 1800),
};

config.commentData = loadCommentData(config.commentDataPath, config.comment);

function validateInputs() {
  const allowedActions = new Set(["scroll", "like", "comment", "like-comment", "engage-loop"]);
  if (!allowedActions.has(config.action)) {
    throw new Error(`Unsupported action: ${config.action}. Use scroll, like, comment, like-comment, or engage-loop.`);
  }

  if (
    (config.action === "comment" || config.action === "like-comment" || config.action === "engage-loop") &&
    config.targetComments > 0 &&
    config.commentData.length === 0
  ) {
    throw new Error("Missing comment data. Use --comment, set FB_COMMENT, or pass --commentData data/comments.txt.");
  }

  if (config.interactionSeconds < 1) {
    throw new Error("interactionSeconds must be greater than 0.");
  }

  if (config.maxActions < 1) {
    throw new Error("maxActions must be greater than 0.");
  }

  if (config.minActionDelayMs > config.maxActionDelayMs || config.minLoopDelayMs > config.maxLoopDelayMs) {
    throw new Error("Minimum delay cannot be greater than maximum delay.");
  }
}

async function pause(driver, ms = 1000) {
  await driver.pause(ms);
}

async function randomPause(driver, minMs, maxMs, label) {
  const delay = randomInt(minMs, maxMs);
  console.log(`${label}: waiting ${delay}ms`);
  await pause(driver, delay);
  return delay;
}

async function findFirst(driver, selectors) {
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
  return null;
}

async function findAll(driver, selectors) {
  const all = [];
  for (const selector of selectors) {
    try {
      all.push(...(await driver.$$(selector)));
    } catch (_) {
      // Try the next locator.
    }
  }
  return all;
}

function parseBounds(bounds) {
  const match = bounds && bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    return null;
  }

  const [, left, top, right, bottom] = match.map(Number);
  return { left, top, right, bottom };
}

async function getScreenSize(driver) {
  if (typeof driver.getWindowSize === "function") {
    return driver.getWindowSize();
  }

  const output = await mobileShell(driver, "wm", ["size"]);
  const match = String(output).match(/(\d+)x(\d+)/);
  if (!match) {
    throw new Error(`Could not read screen size from: ${output}`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
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

async function tapElementCenter(driver, element, label) {
  const bounds = parseBounds(await element.getAttribute("bounds").catch(() => ""));
  if (!bounds) {
    await element.click();
    console.log(`Clicked ${label}`);
    return;
  }

  await tapAt(driver, Math.round((bounds.left + bounds.right) / 2), Math.round((bounds.top + bounds.bottom) / 2), label);
}

async function clickElement(driver, element, label) {
  try {
    await element.click();
    console.log(`Clicked ${label}`);
  } catch (error) {
    console.log(`Element click failed for ${label}; tapping center`, error.message || error);
    await tapElementCenter(driver, element, label);
  }
}

async function clickIfPresent(driver, selectors, label) {
  const element = await findFirst(driver, selectors);
  if (!element) {
    return false;
  }
  await clickElement(driver, element, label);
  return true;
}

async function mobileShell(driver, command, args = []) {
  return driver.execute("mobile: shell", {
    command,
    args: args.map(String),
    includeStderr: true,
    timeout: 20000,
  });
}

async function handleCommonPopups(driver) {
  const popupSelectors = [
    'android=new UiSelector().textMatches("(?i)(allow|while using the app)")',
    'android=new UiSelector().resourceId("com.android.permissioncontroller:id/permission_allow_button")',
    'android=new UiSelector().resourceId("com.android.permissioncontroller:id/permission_allow_foreground_only_button")',
    'android=new UiSelector().textMatches("(?i)(not now|skip|cancel|dismiss|maybe later)")',
    'android=new UiSelector().descriptionMatches("(?i)(not now|skip|cancel|dismiss|maybe later)")',
  ];

  for (let index = 0; index < 3; index += 1) {
    const clicked = await clickIfPresent(driver, popupSelectors, "popup");
    if (!clicked) {
      return;
    }
    await pause(driver, 500);
  }
}

async function tuneAppiumSettings(driver) {
  if (typeof driver.updateSettings !== "function") {
    return;
  }

  await driver
    .updateSettings({
      waitForIdleTimeout: 100,
      waitForSelectorTimeout: 400,
    })
    .catch((error) => console.warn("Could not update Appium settings", error.message || error));
}

async function openFacebook(driver) {
  await mobileShell(driver, "monkey", ["-p", FACEBOOK_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"]).catch(
    () => undefined
  );
  await pause(driver, 3500);
  await handleCommonPopups(driver);
}

async function closeFacebook(driver) {
  await mobileShell(driver, "am", ["force-stop", FACEBOOK_PACKAGE]).catch(() => undefined);
  console.log("Facebook closed");
}

async function scrollFeed(driver) {
  const { width, height } = await getScreenSize(driver);
  const startX = Math.round(width * 0.5);
  const startY = Math.round(height * 0.78);
  const endY = Math.round(height * 0.30);

  await driver
    .action("pointer", { parameters: { pointerType: "touch" } })
    .move({ x: startX, y: startY })
    .down()
    .pause(120)
    .move({ x: startX, y: endY, duration: 550 })
    .up()
    .perform();
  console.log("Scrolled feed");
}

async function changeTabFallback(driver) {
  const clicked = await clickIfPresent(
    driver,
    [
      'android=new UiSelector().descriptionMatches("(?i)(home|feed|news feed)")',
      'android=new UiSelector().textMatches("(?i)(home|feed|news feed)")',
      'android=new UiSelector().resourceIdMatches("(?i).*(feed|home).*")',
    ],
    "feed/home tab"
  );

  if (clicked) {
    await pause(driver, 1200);
    return true;
  }

  const { width, height } = await getScreenSize(driver);
  const navY = Math.round(height * 0.08);
  const tabXs = [0.12, 0.28, 0.44, 0.60, 0.76].map((ratio) => Math.round(width * ratio));
  const targetX = pickRandom(tabXs);
  await tapAt(driver, targetX, navY, "tab fallback");
  await pause(driver, 1200);
  return true;
}

function likeSelectors() {
  return [
    'android=new UiSelector().descriptionMatches("(?i)^like$")',
    'android=new UiSelector().textMatches("(?i)^like$")',
    '//*[@content-desc and translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="like"]',
    '//*[@text and translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="like"]',
  ];
}

function commentButtonSelectors() {
  return [
    'android=new UiSelector().descriptionMatches("(?i)comment")',
    'android=new UiSelector().textMatches("(?i)comment")',
    '//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"comment")]',
    '//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"comment")]',
  ];
}

function commentInputSelectors() {
  return [
    'android=new UiSelector().className("android.widget.EditText").textMatches("(?i)(write a comment|comment)")',
    'android=new UiSelector().className("android.widget.EditText")',
    'android=new UiSelector().descriptionMatches("(?i)(write a comment|comment)")',
  ];
}

function postCommentSelectors() {
  return [
    'android=new UiSelector().descriptionMatches("(?i)^(post|send)$")',
    'android=new UiSelector().textMatches("(?i)^(post|send)$")',
    'android=new UiSelector().resourceIdMatches("(?i).*(send|post|submit).*")',
  ];
}

async function visibleClickableElements(driver, selectors) {
  const { height } = await getScreenSize(driver);
  const elements = await findAll(driver, selectors);
  const visible = [];

  for (const element of elements) {
    const bounds = parseBounds(await element.getAttribute("bounds").catch(() => ""));
    if (!bounds) {
      continue;
    }
    if (bounds.top > height * 0.16 && bounds.bottom < height * 0.92) {
      visible.push({ element, bounds });
    }
  }

  return visible;
}

async function hasVisiblePostActions(driver) {
  const likes = await visibleClickableElements(driver, likeSelectors());
  const comments = await visibleClickableElements(driver, commentButtonSelectors());
  return likes.length > 0 && comments.length > 0;
}

async function scanSuitablePost(driver) {
  await handleCommonPopups(driver);
  return hasVisiblePostActions(driver);
}

async function clickFirstVisible(driver, selectors, label) {
  const visible = await visibleClickableElements(driver, selectors);
  if (visible.length === 0) {
    return false;
  }

  visible.sort((a, b) => a.bounds.top - b.bounds.top);
  await clickElement(driver, visible[0].element, label);
  return true;
}

async function performLike(driver) {
  await handleCommonPopups(driver);
  return clickFirstVisible(driver, likeSelectors(), "Like");
}

async function performComment(driver, commentText = config.comment) {
  await handleCommonPopups(driver);
  const opened = await clickFirstVisible(driver, commentButtonSelectors(), "Comment");
  if (!opened) {
    return false;
  }

  await pause(driver, 1200);
  const input = await findFirst(driver, commentInputSelectors());
  if (!input) {
    console.warn("Could not find comment input after opening comment.");
    await driver.back().catch(() => undefined);
    await pause(driver, 800);
    return false;
  }

  await input.click();
  await input.setValue(commentText);
  console.log("Filled comment text");

  if (!config.confirmComment) {
    console.log("Stopped before posting comment. Set FB_CONFIRM_COMMENT=true or --confirmComment true to submit.");
    await driver.back().catch(() => undefined);
    await pause(driver, 800);
    return false;
  }

  await pause(driver, 500);
  const posted = await clickIfPresent(driver, postCommentSelectors(), "Post comment");
  if (!posted) {
    const { width, height } = await getScreenSize(driver);
    await tapAt(driver, Math.round(width * 0.92), Math.round(height * 0.93), "post comment fallback");
  }
  await pause(driver, 1200);
  await driver.back().catch(() => undefined);
  await pause(driver, 800);
  return true;
}

async function runInteraction(driver) {
  const endsAt = Date.now() + config.interactionSeconds * 1000;
  let likes = 0;
  let comments = 0;
  let scrolls = 0;

  while (Date.now() < endsAt && likes + comments < config.maxActions) {
    if ((config.action === "like" || config.action === "like-comment") && likes + comments < config.maxActions) {
      if (await performLike(driver)) {
        likes += 1;
        await pause(driver, 800);
      }
    }

    if ((config.action === "comment" || config.action === "like-comment") && likes + comments < config.maxActions) {
      if (await performComment(driver)) {
        comments += 1;
        await pause(driver, 800);
      }
    }

    await scrollFeed(driver);
    scrolls += 1;
    await pause(driver, config.scrollPauseMs);
  }

  while (config.action === "scroll" && Date.now() < endsAt) {
    await scrollFeed(driver);
    scrolls += 1;
    await pause(driver, config.scrollPauseMs);
  }

  return { likes, comments, scrolls };
}

async function runEngageLoop(driver) {
  let likes = 0;
  let comments = 0;
  let swipes = 0;
  let tabChanges = 0;
  let noMatchStreak = 0;

  console.log(`Waiting ${config.feedLoadSeconds}s for Feed to load`);
  await pause(driver, config.feedLoadSeconds * 1000);

  for (let loop = 1; loop <= config.loopLimit; loop += 1) {
    const doneLikes = likes >= config.targetLikes;
    const doneComments = comments >= config.targetComments;
    if (doneLikes && doneComments) {
      break;
    }

    console.log(`Engage loop ${loop}/${config.loopLimit}`);
    await scrollFeed(driver);
    swipes += 1;
    await pause(driver, config.scrollPauseMs);

    const foundPost = await scanSuitablePost(driver);
    if (!foundPost) {
      noMatchStreak += 1;
      console.log(`No suitable post found (${noMatchStreak}/${config.noMatchBeforeTabChange})`);

      if (noMatchStreak >= config.noMatchBeforeTabChange) {
        await changeTabFallback(driver);
        tabChanges += 1;
        noMatchStreak = 0;
      }
      continue;
    }

    noMatchStreak = 0;
    console.log("Suitable post found");

    if (likes < config.targetLikes) {
      if (await performLike(driver)) {
        likes += 1;
      }
      await randomPause(driver, config.minActionDelayMs, config.maxActionDelayMs, "After like");
    }

    if (comments < config.targetComments) {
      const commentText = pickRandom(config.commentData);
      if (await performComment(driver, commentText)) {
        comments += 1;
      }
    }

    await randomPause(driver, config.minLoopDelayMs, config.maxLoopDelayMs, "Loop spacing");
  }

  return { likes, comments, scrolls: swipes, tabChanges };
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
      "appium:appPackage": FACEBOOK_PACKAGE,
      "appium:appActivity": FACEBOOK_ACTIVITY,
      "appium:appWaitPackage": FACEBOOK_PACKAGE,
      "appium:appWaitActivity": "*",
      ...(config.systemPort ? { "appium:systemPort": config.systemPort } : {}),
      "appium:noReset": true,
      "appium:fullReset": false,
      "appium:autoGrantPermissions": true,
      "appium:newCommandTimeout": 120,
    },
  });

  try {
    await tuneAppiumSettings(driver);
    console.log(`Connected to ${config.udid || "default Android device"}`);
    console.log(`Facebook action: ${config.action}`);
    await openFacebook(driver);
    const result = config.action === "engage-loop" ? await runEngageLoop(driver) : await runInteraction(driver);
    if (config.action === "engage-loop") {
      await closeFacebook(driver);
    }
    return {
      ok: true,
      deviceUdid: config.udid || null,
      packageName: FACEBOOK_PACKAGE,
      action: config.action,
      ...result,
    };
  } finally {
    await driver.deleteSession();
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
        packageName: FACEBOOK_PACKAGE,
        action: config.action,
      })
    );
    process.exitCode = 1;
  });
