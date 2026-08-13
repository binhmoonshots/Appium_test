const { remote } = require("webdriverio");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const YOUTUBE_PACKAGE = "com.google.android.youtube";
const YOUTUBE_ACTIVITY = "com.google.android.youtube.app.honeycomb.Shell$HomeActivity";
const DEVICE_UPLOAD_DIR = "/sdcard/Movies/AppiumUpload";

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

  if (!args.videoPath && positional[0]) {
    args.videoPath = positional[0];
  }
  if (!args.title && positional[1]) {
    args.title = positional.slice(1).join(" ");
  }

  return args;
}

const cliArgs = parseCliArgs(process.argv.slice(2));

const config = {
  appiumHost: process.env.APPIUM_HOST || "127.0.0.1",
  appiumPort: Number(process.env.APPIUM_PORT || 4723),
  systemPort: process.env.APPIUM_SYSTEM_PORT ? Number(process.env.APPIUM_SYSTEM_PORT) : null,
  adbPath: process.env.ADB_PATH || "adb",
  logLevel: cliArgs.logLevel || process.env.WDIO_LOG_LEVEL || process.env.LOG_LEVEL || "error",
  udid: process.env.ANDROID_DEVICE_UDID || process.env.UDID || "ce031713612cd4040c",
  videoPath: cliArgs.videoPath || process.env.YT_VIDEO_PATH || process.env.VIDEO_PATH || "",
  title: cliArgs.title || process.env.YT_TITLE || process.env.TITLE || "",
  description: process.env.YT_DESCRIPTION || "Uploaded from Appium automation.",
  soundQuery: cliArgs.sound || cliArgs.soundQuery || process.env.YT_SOUND || process.env.YT_SOUND_QUERY || "",
  soundName: cliArgs.soundName || process.env.YT_SOUND_NAME || process.env.SOUND_NAME || "",
  songTitle: cliArgs.songTitle || process.env.YT_SONG_TITLE || process.env.YT_SOUND_TITLE || process.env.SONG_TITLE || "",
  soundVolumePercent: Number(cliArgs.soundVolumePercent || process.env.YT_SOUND_VOLUME_PERCENT || 8),
  soundStartSeconds: Number(cliArgs.soundStartSeconds || process.env.YT_SOUND_START_SECONDS || 0),
  soundStartPercent: Number(cliArgs.soundStartPercent || process.env.YT_SOUND_START_PERCENT || 0),
  clipDurationSeconds: Number(cliArgs.clipDurationSeconds || process.env.YT_CLIP_DURATION_SECONDS || 0),
  sourceDurationSeconds: Number(cliArgs.sourceDurationSeconds || process.env.YT_SOURCE_DURATION_SECONDS || 0),
  trimTimelineYPercent: Number(cliArgs.trimTimelineYPercent || process.env.YT_TRIM_TIMELINE_Y_PERCENT || 0.815),
  madeForKids: /^true$/i.test(process.env.YT_MADE_FOR_KIDS || ""),
  verifyCleanup: /^true$/i.test(process.env.YT_VERIFY_CLEANUP || ""),
  mediaIndex: process.env.YT_VIDEO_INDEX || "0",
};

function validateInputs() {
  if (!config.title) {
    throw new Error("Missing input title. Use --title \"Your title\" or set YT_TITLE.");
  }

  if (!config.videoPath) {
    return;
  }

  const resolvedVideoPath = path.resolve(config.videoPath);
  if (!fs.existsSync(resolvedVideoPath)) {
    throw new Error(`Video file does not exist: ${resolvedVideoPath}`);
  }

  const stat = fs.statSync(resolvedVideoPath);
  if (!stat.isFile()) {
    throw new Error(`videoPath is not a file: ${resolvedVideoPath}`);
  }

  config.videoPath = resolvedVideoPath;
}

function escapeUiText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function hasSoundInput() {
  return Boolean(config.soundQuery || config.soundName || config.songTitle);
}

function soundSearchQuery() {
  if (config.soundQuery) {
    return config.soundQuery;
  }

  return [config.songTitle, config.soundName].filter(Boolean).join(" ").trim();
}

function decodeXmlValue(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function soundQueryTokens() {
  return normalizeSearchText(soundSearchQuery())
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function parseUiNodes(source) {
  const nodes = [];
  const nodePattern = /<node\b[^>]*>/g;
  let nodeMatch;

  while ((nodeMatch = nodePattern.exec(source || ""))) {
    const tag = nodeMatch[0];
    const attrs = {};
    const attrPattern = /([\w:-]+)="([^"]*)"/g;
    let attrMatch;

    while ((attrMatch = attrPattern.exec(tag))) {
      attrs[attrMatch[1]] = decodeXmlValue(attrMatch[2]);
    }

    const bounds = parseBounds(attrs.bounds || "");
    const text = attrs.text || attrs["content-desc"] || "";
    if (bounds && text) {
      nodes.push({
        text,
        normalized: normalizeSearchText(text),
        bounds,
        centerY: Math.round((bounds.top + bounds.bottom) / 2),
      });
    }
  }

  return nodes;
}

function rowKeyForNode(node, rowHeight) {
  return Math.round(node.centerY / rowHeight);
}

function soundResultRowsFromNodes(nodes, width, height) {
  const ignored = new Set([
    "sounds",
    "create music",
    "all",
    "official music",
    "original sounds",
    "cancel",
    "search",
    "search music",
    "search songs",
    "search sounds",
  ]);
  const queryText = normalizeSearchText(soundSearchQuery());
  const minY = Math.round(height * 0.16);
  const maxY = Math.round(height * 0.94);
  const rowHeight = Math.max(82, Math.round(height * 0.075));
  const rows = new Map();

  for (const node of nodes) {
    if (node.centerY < minY || node.centerY > maxY) {
      continue;
    }
    if (node.bounds.right < Math.round(width * 0.10)) {
      continue;
    }
    if (!node.normalized || ignored.has(node.normalized) || node.normalized === queryText) {
      continue;
    }
    if (node.normalized.includes("create music") || node.normalized.includes("search")) {
      continue;
    }

    const key = rowKeyForNode(node, rowHeight);
    const row = rows.get(key) || {
      key,
      nodes: [],
      textParts: [],
      top: node.bounds.top,
      bottom: node.bounds.bottom,
      left: node.bounds.left,
      right: node.bounds.right,
    };

    row.nodes.push(node);
    row.textParts.push(node.text);
    row.top = Math.min(row.top, node.bounds.top);
    row.bottom = Math.max(row.bottom, node.bounds.bottom);
    row.left = Math.min(row.left, node.bounds.left);
    row.right = Math.max(row.right, node.bounds.right);
    rows.set(key, row);
  }

  return [...rows.values()]
    .sort((a, b) => a.top - b.top)
    .reduce((merged, row) => {
      const previous = merged[merged.length - 1];
      if (previous && row.top - previous.bottom < Math.round(rowHeight * 0.55)) {
        previous.nodes.push(...row.nodes);
        previous.textParts.push(...row.textParts);
        previous.top = Math.min(previous.top, row.top);
        previous.bottom = Math.max(previous.bottom, row.bottom);
        previous.left = Math.min(previous.left, row.left);
        previous.right = Math.max(previous.right, row.right);
        return merged;
      }

      merged.push(row);
      return merged;
    }, [])
    .map((row) => ({
      ...row,
      text: row.textParts.join(" "),
      normalized: normalizeSearchText(row.textParts.join(" ")),
      centerY: Math.round((row.top + row.bottom) / 2),
    }))
    .filter((row) => row.normalized && !row.normalized.includes("shorts camera"));
}

function soundResultRowsFromSource(source, width, height) {
  return soundResultRowsFromNodes(parseUiNodes(source), width, height);
}

async function visibleUiTextNodes(driver) {
  const selectors = [
    'android=new UiSelector().className("android.widget.TextView")',
    'android=new UiSelector().className("android.widget.Button")',
    'android=new UiSelector().className("android.widget.ImageView")',
  ];
  const nodes = [];

  for (const selector of selectors) {
    const elements = await driver.$$(selector).catch(() => []);
    for (const element of elements) {
      const displayed = await element.isDisplayed().catch(() => true);
      if (!displayed) {
        continue;
      }

      const bounds = parseBounds(await element.getAttribute("bounds").catch(() => ""));
      if (!bounds) {
        continue;
      }

      const text = (
        (await element.getText().catch(() => "")) ||
        (await element.getAttribute("text").catch(() => "")) ||
        (await element.getAttribute("content-desc").catch(() => ""))
      );

      if (!text) {
        continue;
      }

      nodes.push({
        text,
        normalized: normalizeSearchText(text),
        bounds,
        centerY: Math.round((bounds.top + bounds.bottom) / 2),
      });
    }
  }

  return nodes;
}

async function soundResultRows(driver, width, height) {
  const source = await driver.getPageSource().catch(() => "");
  const sourceRows = soundResultRowsFromSource(source, width, height);
  const soundRows = sourceRows.filter((row) => /\bplay a preview\b/i.test(row.text));
  if (soundRows.length > 0) {
    return soundRows;
  }

  const directRows = soundResultRowsFromNodes(await visibleUiTextNodes(driver), width, height);
  if (directRows.length > 0) {
    return directRows;
  }

  return sourceRows;
}

function scoreSoundResultRow(row, tokens, rowIndex) {
  const text = row.normalized;
  const compactText = text.replace(/\s+/g, "");
  const phrase = normalizeSearchText(soundSearchQuery());
  const compactPhrase = phrase.replace(/\s+/g, "");
  const matchedTokens = tokens.filter((token) => text.includes(token) || compactText.includes(token));
  let score = matchedTokens.length * 10;

  if (phrase && (text.includes(phrase) || compactText.includes(compactPhrase))) {
    score += 50;
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (text.includes(`${tokens[index]} ${tokens[index + 1]}`)) {
      score += 6;
    }
  }

  score -= rowIndex;
  return { score, matchedTokens };
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function parseDurationSeconds(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return null;
  }

  const hms = text.match(/^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  }

  const ms = text.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (ms) {
    return Number(ms[1]) * 60 + Number(ms[2]);
  }

  const compact = text.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/);
  if (compact && (compact[1] || compact[2] || compact[3])) {
    return Number(compact[1] || 0) * 3600 + Number(compact[2] || 0) * 60 + Number(compact[3] || 0);
  }

  return null;
}

function parseVerboseDurationSeconds(value) {
  const text = String(value || "").toLowerCase();
  const hours = Number((text.match(/(\d+(?:\.\d+)?)\s*hours?/) || [])[1] || 0);
  const minutes = Number((text.match(/(\d+(?:\.\d+)?)\s*minutes?/) || [])[1] || 0);
  const seconds = Number((text.match(/(\d+(?:\.\d+)?)\s*seconds?/) || [])[1] || 0);

  if (!hours && !minutes && !seconds) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

async function pause(driver, ms = 1000) {
  await driver.pause(ms);
}

async function findFirst(driver, selectors, _timeout = 800) {
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

async function clickFirst(driver, selectors, label, timeout = 1500) {
  const element = await findFirst(driver, selectors, timeout);
  if (!element) {
    throw new Error(`Could not find ${label}`);
  }
  await clickElement(driver, element, label);
  return element;
}

async function clickIfPresent(driver, selectors, label, timeout = 1000) {
  const element = await findFirst(driver, selectors, timeout);
  if (!element) {
    return false;
  }
  await clickElement(driver, element, label);
  return true;
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

async function tapElementCenter(driver, element, label) {
  const bounds = await element.getAttribute("bounds");
  const match = bounds && bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);

  if (!match) {
    try {
      await element.click();
      console.log(`Clicked ${label}`);
      return;
    } catch (error) {
      console.log(`Element click failed for ${label}; falling back to tap`, error.message || error);
    }
  }

  const [, left, top, right, bottom] = match.map(Number);
  await driver
    .action("pointer", { parameters: { pointerType: "touch" } })
    .move({ x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) })
    .down()
    .pause(80)
    .up()
    .perform();
  console.log(`Tapped ${label}`);
}

async function tapElementCenterWithAdb(driver, element, label) {
  const bounds = await element.getAttribute("bounds");
  const parsed = parseBounds(bounds);
  if (!parsed) {
    await tapElementCenter(driver, element, label);
    return false;
  }

  const x = Math.round((parsed.left + parsed.right) / 2);
  const y = Math.round((parsed.top + parsed.bottom) / 2);
  await tapAt(driver, x, y, label);
  await pause(driver, 150);
  await mobileShell(driver, "input", ["tap", String(x), String(y)]);
  console.log(`ADB tapped ${label} at ${x},${y}`);
  return true;
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

async function dragAt(driver, fromX, fromY, toX, toY, label) {
  await driver
    .action("pointer", { parameters: { pointerType: "touch" } })
    .move({ x: fromX, y: fromY })
    .down()
    .pause(120)
    .move({ x: toX, y: toY, duration: 450 })
    .up()
    .perform();
  console.log(`Dragged ${label} from ${fromX},${fromY} to ${toX},${toY}`);
}

async function swipeAtWithAdb(driver, fromX, fromY, toX, toY, durationMs, label) {
  await mobileShell(driver, "input", [
    "swipe",
    String(Math.round(fromX)),
    String(Math.round(fromY)),
    String(Math.round(toX)),
    String(Math.round(toY)),
    String(durationMs),
  ]);
  console.log(`ADB swiped ${label} from ${fromX},${fromY} to ${toX},${toY}`);
}

function parseBounds(bounds) {
  const match = bounds && bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    return null;
  }

  const [, left, top, right, bottom] = match.map(Number);
  return { left, top, right, bottom };
}

async function tapNextButtonRegion(driver, label) {
  const { width, height } = await getScreenSize(driver);
  const positions = [
    [0.90, 0.88],
    [0.92, 0.90],
    [0.94, 0.90],
    [0.96, 0.90],
    [0.92, 0.92],
    [0.94, 0.92],
    [0.90, 0.94],
    [0.94, 0.94],
  ];

  for (const [px, py] of positions) {
    await tapAt(driver, Math.round(width * px), Math.round(height * py), `${label} region ${px},${py}`);
    await pause(driver, 300);
  }
}

async function tapNextButtonShell(driver, label) {
  const { width, height } = await getScreenSize(driver);
  const positions = [
    [0.90, 0.88],
    [0.92, 0.90],
    [0.94, 0.90],
    [0.96, 0.90],
    [0.90, 0.92],
    [0.94, 0.92],
    [0.90, 0.94],
    [0.94, 0.94],
  ];

  for (const [px, py] of positions) {
    const x = Math.round(width * px);
    const y = Math.round(height * py);
    console.log(`Shell tap ${label} at ${x},${y}`);
    await mobileShell(driver, "input", ["tap", x.toString(), y.toString()]);
    await pause(driver, 300);
  }
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

function titleInputSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)(create a title|add a title|title|caption|add a caption)")',
    'android=new UiSelector().descriptionMatches("(?i)(create a title|add a title|title|caption|add a caption)")',
    "android=new UiSelector().className(\"android.widget.EditText\").instance(0)",
  ];
}

function uploadButtonSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)(upload|publish|post|upload short)")',
    'android=new UiSelector().descriptionMatches("(?i)(upload|publish|post|upload short)")',
    '//android.widget.Button[@resource-id="com.google.android.youtube:id/upload_bottom_button"]',
    '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button" and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"upload")]',
    '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button" and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"post")]',
    '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button" and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"upload")]',
    '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button" and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"post")]',
  ];
}

function createShortSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)(create a short|create short|short|upload a video|upload video)")',
    'android=new UiSelector().descriptionMatches("(?i)(create a short|create short|short|upload a video|upload video)")',
    'android=new UiSelector().resourceIdMatches("(?i).*short.*")',
  ];
}

function galleryPickerSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)(add|gallery|upload|videos)")',
    'android=new UiSelector().descriptionMatches("(?i)(add|gallery|upload|videos|open gallery|select from device)")',
    'android=new UiSelector().resourceIdMatches("(?i).*(gallery|picker|upload|add).*")',
  ];
}

async function clickNext(driver, label, allowFallbackTap = true) {
  const clicked = await clickIfPresent(
    driver,
    [
      '//android.widget.Button[@content-desc="Continue to upload"]',
      '//android.widget.Button[@content-desc="Continue to editor"]',
      '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button"]',
      '//android.widget.Button[@resource-id="com.google.android.youtube:id/upload_bottom_button"]',
      '//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue to upload")]',
      '//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue to editor")]',
      '//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue to upload")]',
      '//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue to editor")]',
      '//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
      '//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
      'android=new UiSelector().textMatches("(?i).*continue to upload.*")',
      'android=new UiSelector().descriptionMatches("(?i).*continue to upload.*")',
      'android=new UiSelector().textMatches("(?i).*continue to editor.*")',
      'android=new UiSelector().descriptionMatches("(?i).*continue to editor.*")',
      'android=new UiSelector().textMatches("(?i).*continue.*")',
      'android=new UiSelector().descriptionMatches("(?i).*continue.*")',
      'android=new UiSelector().textMatches("(?i).*next.*")',
      'android=new UiSelector().descriptionMatches("(?i).*next.*")',
      'android=new UiSelector().resourceIdMatches("(?i).*next.*")',
      'android=new UiSelector().className("android.widget.Button").textMatches("(?i).*next.*")',
      'android=new UiSelector().className("android.widget.Button").descriptionMatches("(?i).*next.*")',
      'android=new UiSelector().className("android.widget.TextView").textMatches("(?i).*next.*")',
      'android=new UiSelector().className("android.widget.TextView").descriptionMatches("(?i).*next.*")',
      'android=new UiSelector().className("android.view.View").descriptionMatches("(?i).*next.*")',
      'android=new UiSelector().className("android.view.View").textMatches("(?i).*next.*")',
    ],
    label,
    1800
  );

  if (clicked || !allowFallbackTap) {
    return clicked;
  }

  const { width, height } = await getScreenSize(driver);
  await tapAt(driver, Math.round(width * 0.85), Math.round(height * 0.92), `${label} fallback`);
  await pause(driver, 800);

  const fallbackClicked = await clickIfPresent(
    driver,
    [
      '//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
      '//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
      'android=new UiSelector().textMatches("(?i)(next|done|continue)")',
      'android=new UiSelector().descriptionMatches("(?i)(next|done|continue)")',
    ],
    label,
    300
  );

  if (fallbackClicked) {
    return true;
  }

  await tapNextButtonRegion(driver, label);
  await pause(driver, 300);

  const fallbackClicked2 = await clickIfPresent(
    driver,
    [
      '//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
      '//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
      'android=new UiSelector().textMatches("(?i)(next|done|continue)")',
      'android=new UiSelector().descriptionMatches("(?i)(next|done|continue)")',
    ],
    label,
    300
  );

  if (fallbackClicked2) {
    return true;
  }

  await tapNextButtonShell(driver, label);
  return false;
}

async function pressBottomRightAction(driver, label) {
  const bottomButton = await findFirst(
    driver,
    [
      '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button"]',
      '//android.widget.Button[@resource-id="com.google.android.youtube:id/upload_bottom_button"]',
    ],
    600
  );

  if (bottomButton) {
    await tapElementCenterWithAdb(driver, bottomButton, label);
    return true;
  }

  const clicked = await clickIfPresent(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(next|continue|done)")',
      'android=new UiSelector().descriptionMatches("(?i)(next|continue|done)")',
    ],
    label,
    600
  );

  const { width, height } = await getScreenSize(driver);
  await tapAt(driver, Math.round(width * 0.74), Math.round(height * 0.883), `${label} fast fallback`);
  await mobileShell(driver, "input", [
    "tap",
    String(Math.round(width * 0.74)),
    String(Math.round(height * 0.883)),
  ]);
  return clicked;
}

async function pressUploadShort(driver) {
  const selectors = [
    '//android.widget.Button[@resource-id="com.google.android.youtube:id/upload_bottom_button"]',
    '//android.widget.Button[contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"upload short")]',
    '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button" and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"upload")]',
    '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button" and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"post")]',
    '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button" and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"upload")]',
    '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button" and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"post")]',
    'android=new UiSelector().textMatches("(?i)(upload short|upload|publish|post)")',
    'android=new UiSelector().descriptionMatches("(?i)(upload short|upload|publish|post)")',
  ];

  const isStillOnUploadScreen = async () => Boolean(await findFirst(driver, selectors, 400));
  const buttonCenter = async (element) => {
    const bounds = await element.getAttribute("bounds");
    const match = bounds && bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!match) {
      return null;
    }
    const [, left, top, right, bottom] = match.map(Number);
    return {
      x: Math.round((left + right) / 2),
      y: Math.round((top + bottom) / 2),
    };
  };

  const uploadButton = await findFirst(driver, selectors, 1000);

  if (uploadButton) {
    const center = await buttonCenter(uploadButton);

    await clickElement(driver, uploadButton, "Upload Short");
    await pause(driver, 900);
    if (!(await isStillOnUploadScreen())) {
      return true;
    }

    if (center) {
      await tapAt(driver, center.x, center.y, "Upload Short center");
      await pause(driver, 900);
      if (!(await isStillOnUploadScreen())) {
        return true;
      }

      console.log(`Shell tap Upload Short at ${center.x},${center.y}`);
      await mobileShell(driver, "input", ["tap", center.x.toString(), center.y.toString()]);
      await pause(driver, 900);
      if (!(await isStillOnUploadScreen())) {
        return true;
      }
    }
  }

  const { width, height } = await getScreenSize(driver);
  const fallbackPoints = [
    [0.74, 0.89],
    [0.78, 0.89],
    [0.82, 0.89],
  ];

  for (const [px, py] of fallbackPoints) {
    await tapAt(driver, Math.round(width * px), Math.round(height * py), `Upload Short fallback ${px},${py}`);
    await pause(driver, 900);
    if (!(await isStillOnUploadScreen())) {
      return true;
    }
  }

  throw new Error("Upload Short button was tapped, but the Add details screen did not change");
}

async function typeIntoFirst(driver, selectors, value, label) {
  const element = await findFirst(driver, selectors, 1200);
  if (!element) {
    throw new Error(`Could not find input for ${label}`);
  }
  await element.click();
  await element.clearValue().catch(() => undefined);
  await element.setValue(value);
  console.log(`Filled ${label}`);
}

async function handleCommonPopups(driver) {
  const popupButtons = [
    [
      'android=new UiSelector().textMatches("(?i)(start over)")',
      'android=new UiSelector().descriptionMatches("(?i)(start over)")',
      'android=new UiSelector().resourceId("android:id/button2")',
    ],
    [
      'android=new UiSelector().textMatches("(?i)(allow all|allow all photos|allow all photos and videos)")',
      'android=new UiSelector().descriptionMatches("(?i)(allow all|allow all photos|allow all photos and videos)")',
      'android=new UiSelector().resourceId("com.android.permissioncontroller:id/permission_allow_all_button")',
    ],
    [
      'android=new UiSelector().textMatches("(?i)(not now|skip|cancel|dismiss)")',
      'android=new UiSelector().descriptionMatches("(?i)(not now|skip|cancel|dismiss)")',
    ],
    [
      'android=new UiSelector().textMatches("(?i)(allow|while using the app|allow limited access)")',
      'android=new UiSelector().resourceId("com.android.permissioncontroller:id/permission_allow_button")',
      'android=new UiSelector().resourceId("com.android.permissioncontroller:id/permission_allow_foreground_only_button")',
      'android=new UiSelector().resourceId("com.android.permissioncontroller:id/permission_allow_selected_button")',
    ],
  ];

  for (const selectors of popupButtons) {
    await clickIfPresent(driver, selectors, "popup", 250);
    await pause(driver, 200);
  }
}

async function tuneAppiumSettings(driver) {
  if (typeof driver.updateSettings !== "function") {
    return;
  }

  await driver.updateSettings({
    waitForIdleTimeout: 100,
    waitForSelectorTimeout: 400,
  }).catch((error) => {
    console.warn("Could not update Appium settings", error.message || error);
  });
}

async function mobileShell(driver, command, args = []) {
  return runAdb([...adbDeviceArgs(), "shell", command, ...args], `adb shell ${command}`);
}

async function refreshMediaStore(driver, devicePath) {
  await mobileShell(driver, "am", [
    "broadcast",
    "-a",
    "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
    "-d",
    `file://${devicePath}`,
  ]).catch((error) => {
    console.warn("Could not refresh MediaStore", error.message || error);
  });
}

async function clearOldDeviceMedia(driver) {
  console.log("Clearing old photos/videos from device media folders");
  runAdb([...adbDeviceArgs(), "shell", "am", "force-stop", YOUTUBE_PACKAGE], "adb force-stop YouTube");

  runAdb([...adbDeviceArgs(), "shell", "content", "delete", "--uri", "content://media/external/images/media"], "adb clear image MediaStore");
  runAdb([...adbDeviceArgs(), "shell", "content", "delete", "--uri", "content://media/external/video/media"], "adb clear video MediaStore");

  runAdb([...adbDeviceArgs(), "shell", "sh", "-c", [
    "find /sdcard -type f \\(",
    "-iname '*.mp4' -o -iname '*.mov' -o -iname '*.mkv' -o -iname '*.webm' -o -iname '*.3gp' -o",
    "-iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.heic' -o -iname '*.webp'",
    "\\) -delete >/dev/null 2>&1 || true",
  ].join(" ")], "adb delete old media files");

  await refreshMediaStore(driver, "/sdcard/DCIM");
  await refreshMediaStore(driver, "/sdcard/Pictures");
  await refreshMediaStore(driver, "/sdcard/Movies");

  if (config.verifyCleanup) {
    const remaining = runAdb([...adbDeviceArgs(), "shell", "sh", "-c", [
      "find /sdcard -type f \\(",
      "-iname '*.mp4' -o -iname '*.mov' -o -iname '*.mkv' -o -iname '*.webm' -o -iname '*.3gp' -o",
      "-iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.heic' -o -iname '*.webp'",
      "\\) 2>/dev/null | wc -l",
    ].join(" ")], "adb count remaining media files", 10000).trim();
    console.log(`Remaining device media files after cleanup: ${remaining}`);
  }

  console.log("Device media cleanup finished");
}

async function clearOldUploadVideos(driver) {
  console.log(`Clearing old upload videos from ${DEVICE_UPLOAD_DIR}`);
  runAdb([...adbDeviceArgs(), "shell", "mkdir", "-p", DEVICE_UPLOAD_DIR], "adb mkdir upload dir");
  runAdb([...adbDeviceArgs(), "shell", "sh", "-c", [
    `find '${DEVICE_UPLOAD_DIR}' -maxdepth 1 -type f \\(`,
    "-iname '*.mp4' -o -iname '*.mov' -o -iname '*.mkv' -o -iname '*.webm' -o -iname '*.3gp'",
    "\\) -delete >/dev/null 2>&1 || true",
  ].join(" ")], "adb delete old upload videos");
  await refreshMediaStore(driver, DEVICE_UPLOAD_DIR);
  console.log("Old upload videos cleared");
}

async function clearOldDeviceVideos(driver) {
  console.log("Clearing old videos from device media folders");
  runAdb([...adbDeviceArgs(), "shell", "am", "force-stop", YOUTUBE_PACKAGE], "adb force-stop YouTube");
  runAdb([...adbDeviceArgs(), "shell", "content", "delete", "--uri", "content://media/external/video/media"], "adb clear video MediaStore");
  runAdb([...adbDeviceArgs(), "shell", "sh", "-c", [
    "find /sdcard -type f \\(",
    "-iname '*.mp4' -o -iname '*.mov' -o -iname '*.mkv' -o -iname '*.webm' -o -iname '*.3gp'",
    "\\) -delete >/dev/null 2>&1 || true",
  ].join(" ")], "adb delete old device videos");

  await refreshMediaStore(driver, "/sdcard/DCIM");
  await refreshMediaStore(driver, "/sdcard/Movies");
  await refreshMediaStore(driver, "/sdcard/Pictures");
  console.log("Old device videos cleared");
}

function remoteUploadPath(videoPath) {
  const parsed = path.parse(videoPath);
  const safeBaseName = parsed.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "upload";
  const safeExt = parsed.ext || ".mp4";
  return `${DEVICE_UPLOAD_DIR}/${Date.now()}_${safeBaseName}${safeExt}`;
}

function runAdb(args, label, timeout = 60000) {
  console.log(`Running ${label}`);
  const result = spawnSync(config.adbPath, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
    timeout,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${label} failed with exit code ${result.status}${details ? `: ${details}` : ""}`);
  }

  console.log(`Finished ${label}`);
  return result.stdout;
}

function adbDeviceArgs() {
  return config.udid ? ["-s", config.udid] : [];
}

function pushVideoWithAdb(localPath, devicePath) {
  console.log(`ADB push video to device: ${devicePath}`);
  runAdb([...adbDeviceArgs(), "shell", "mkdir", "-p", DEVICE_UPLOAD_DIR], "adb mkdir upload dir");
  runAdb([...adbDeviceArgs(), "push", localPath, devicePath], "adb push video");
}

async function copyVideoToDevice(driver) {
  const devicePath = remoteUploadPath(config.videoPath);

  console.log(`Copying video to device: ${devicePath}`);
  pushVideoWithAdb(config.videoPath, devicePath);
  await refreshMediaStore(driver, devicePath);
  await pause(driver, 800);

  return devicePath;
}

async function prepareDeviceMedia(driver) {
  if (!config.videoPath) {
    console.log("No videoPath provided; using an existing visible video from the YouTube media picker.");
    return null;
  }

  await clearOldDeviceVideos(driver);
  return copyVideoToDevice(driver);
}

async function openYoutube(driver) {
  console.log("Opening YouTube");
  const youtubeActivity = YOUTUBE_ACTIVITY.replace(/\$/g, "\\$");

  await mobileShell(driver, "am", [
    "start",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER",
    "-n",
    `${YOUTUBE_PACKAGE}/${youtubeActivity}`,
  ]);
  await pause(driver, 2500);

  const currentPackage = await driver.getCurrentPackage().catch(() => "");
  if (currentPackage !== YOUTUBE_PACKAGE) {
    throw new Error(`YouTube did not open; current foreground package is ${currentPackage || "unknown"}`);
  }

  console.log("YouTube is foreground");
}

async function openVideoPickerFromCamera(driver) {
  const videoTab = await findFirst(
    driver,
    [
      'android=new UiSelector().text("Video")',
      'android=new UiSelector().descriptionMatches("(?i)(video)")',
    ],
    3000
  );

  if (videoTab) {
    await tapElementCenter(driver, videoTab, "Video tab");
    await pause(driver, 1800);
  } else {
    console.log("Video tab not found; continuing from current screen");
  }

  await handleCommonPopups(driver);
}

async function openShortsGallery(driver) {
  const openedGallery = await clickIfPresent(
    driver,
    galleryPickerSelectors(),
    "Shorts gallery",
    1200
  );

  if (openedGallery) {
    await pause(driver, 900);
    await handleCommonPopups(driver);
    return;
  }

  const { width, height } = await getScreenSize(driver);
  const fallbackTaps = [
    [0.17, 0.86],
    [0.12, 0.88],
    [0.20, 0.90],
    [0.50, 0.86],
  ];

  for (const [px, py] of fallbackTaps) {
    await tapAt(driver, Math.round(width * px), Math.round(height * py), `Shorts gallery fallback ${px},${py}`);
    await pause(driver, 600);

    const mediaPickerVisible = await findFirst(
      driver,
      [
        'android=new UiSelector().textMatches("(?i)(videos|recents|gallery)")',
        'android=new UiSelector().descriptionMatches("(?i)(videos|recents|gallery)")',
      ],
      700
    );
    if (mediaPickerVisible) {
      await handleCommonPopups(driver);
      return;
    }
  }

  throw new Error("Could not open Shorts gallery/media picker");
}

async function openCreateShort(driver) {
  const openedCreate = await clickIfPresent(
    driver,
    [
      'android=new UiSelector().descriptionMatches("(?i)(create|add|plus)")',
      'android=new UiSelector().descriptionMatches("(?i)(create)")',
      'android=new UiSelector().textMatches("(?i)(create)")',
      'android=new UiSelector().resourceIdMatches("(?i).*(create|fab|plus|bottom_bar).*")',
      '//android.widget.ImageButton[contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"create")]',
      '//android.widget.Button[contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"create")]',
    ],
    "Create",
    1600
  );

  if (!openedCreate) {
    const { width, height } = await getScreenSize(driver);
    await tapAt(driver, Math.round(width * 0.50), Math.round(height * 0.94), "Create bottom bar fallback");
  }

  await pause(driver, 700);
  await handleCommonPopups(driver);

  const openedShorts = await clickIfPresent(
    driver,
    createShortSelectors(),
    "Create Short",
    1200
  );

  if (!openedShorts) {
    console.log("Create Short menu item not found; trying current create screen as Shorts camera");
  }

  await pause(driver, 900);
  await handleCommonPopups(driver);
  await openShortsGallery(driver);
}

async function isMediaPickerVisible(driver) {
  const marker = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(recents|create video|search youtube|videos|gallery)")',
      'android=new UiSelector().descriptionMatches("(?i)(recents|create video|search youtube|videos|gallery)")',
    ],
    500
  );

  return Boolean(marker);
}

async function isVideoSelectedInPicker(driver) {
  const marker = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^(next|done|continue|add)$")',
      'android=new UiSelector().descriptionMatches("(?i)^(next|done|continue|add)$")',
      'android=new UiSelector().resourceIdMatches("(?i).*(next|done|continue).*")',
    ],
    500
  );

  return Boolean(marker);
}

async function chooseRandomVisibleVideo(driver) {
  const explicitIndex =
    config.mediaIndex === "random" ? null : Math.max(0, Number(config.mediaIndex || 0));

  await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(videos|video)")',
      'android=new UiSelector().descriptionMatches("(?i)(videos|video)")',
    ],
    1500
  );

  const { width, height } = await getScreenSize(driver);
  const columns = 3;
  const topInset = Math.max(70, Math.round(height * 0.12));
  const bottomInset = Math.max(105, Math.round(height * 0.18));
  const gridBottom = height - bottomInset;
  const cellSize = Math.floor(width / columns);
  const rows = Math.max(1, Math.floor((gridBottom - topInset) / cellSize));
  const totalCells = rows * columns;
  const selectedIndex =
    explicitIndex == null ? randomInt(totalCells) : Math.min(explicitIndex, totalCells - 1);
  const column = selectedIndex % columns;
  const row = Math.floor(selectedIndex / columns);
  const x = selectedIndex === 0 ? Math.round(width * 0.17) : Math.round(column * cellSize + cellSize / 2);
  const y = selectedIndex === 0 ? Math.round(height * 0.50) : Math.round(topInset + row * cellSize + cellSize / 2);

  await tapAt(driver, x, y, `random video ${selectedIndex + 1}/${totalCells}`);
  await pause(driver, 1200);

  if (!(await isMediaPickerVisible(driver)) || (await isVideoSelectedInPicker(driver))) {
    return;
  }

  const fallbackPoints = selectedIndex === 0
    ? [
        [0.17, 0.56],
        [0.30, 0.50],
        [0.17, 0.62],
      ]
    : [
        [0.50, 0.42],
        [0.83, 0.42],
      ];

  for (const [px, py] of fallbackPoints) {
    await tapAt(driver, Math.round(width * px), Math.round(height * py), `video picker fallback ${px},${py}`);
    await pause(driver, 1000);
    if (!(await isMediaPickerVisible(driver)) || (await isVideoSelectedInPicker(driver))) {
      return;
    }
  }
}

function addSoundSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)(add sound|sound|audio|music)")',
    'android=new UiSelector().descriptionMatches("(?i)(add sound|sound|audio|music)")',
    'android=new UiSelector().resourceIdMatches("(?i).*(sound|audio|music).*")',
  ];
}

function soundSearchSelectors() {
  return [
    'android=new UiSelector().textMatches("(?i)(search|search music|search songs|search sounds)")',
    'android=new UiSelector().descriptionMatches("(?i)(search|search music|search songs|search sounds)")',
    'android=new UiSelector().resourceIdMatches("(?i).*(search).*")',
    'android=new UiSelector().className("android.widget.EditText").instance(0)',
  ];
}

function soundResultSelectors() {
  const terms = config.soundQuery
    ? soundSearchQuery().split(/\s+/).filter(Boolean).map(escapeUiText)
    : [config.songTitle, config.soundName].filter(Boolean).map(escapeUiText);
  const selectors = [];
  const songByArtist = [config.soundName, config.songTitle].filter(Boolean).join(" - ");
  const escapedSongByArtist = escapeUiText(songByArtist);

  if (config.soundQuery) {
    selectors.push(
      `//*[contains(@content-desc,"${escapeUiText(config.soundQuery)}") and (contains(@content-desc,"preview") or contains(@content-desc,"Shorts"))]`
    );
  } else if (config.soundName && config.songTitle) {
    selectors.push(
      `//*[contains(@content-desc,"${escapeUiText(config.songTitle)}") and contains(@content-desc,"${escapeUiText(config.soundName)}") and (contains(@content-desc,"preview") or contains(@content-desc,"Shorts"))]`
    );
    selectors.push(
      `//*[contains(@content-desc,"${escapedSongByArtist}") and (contains(@content-desc,"preview") or contains(@content-desc,"Shorts"))]`
    );
  }

  for (const term of terms) {
    selectors.push(
      `//*[contains(@content-desc,"${term}") and (contains(@content-desc,"preview") or contains(@content-desc,"Shorts"))]`
    );
  }

  selectors.push(
    '//*[@content-desc and (contains(@content-desc,"preview") or contains(@content-desc,"Shorts"))][1]'
  );

  return selectors;
}

async function waitForSoundSearchResults(driver, timeout = 3000) {
  await pause(driver, timeout);
  const { width, height } = await getScreenSize(driver);
  const tokens = soundQueryTokens();
  const rows = await soundResultRows(driver, width, height);
  const best = rows
    .map((row, index) => ({ row, index, ...scoreSoundResultRow(row, tokens, index) }))
    .sort((a, b) => b.score - a.score)[0];

  if (best && best.matchedTokens.length >= Math.min(tokens.length, 2)) {
    return true;
  }

  const result = await findFirst(driver, soundResultSelectors(), 500);
  return Boolean(result);
}

function rowsLookLikeEditorTools(rows) {
  const text = rows.map((row) => normalizeSearchText(row.text)).join(" ");
  return /\b(text|effects|filters|stickers|more tools|browse saved)\b/.test(text);
}

async function tapFirstSoundResultByCoordinate(driver) {
  const { width, height } = await getScreenSize(driver);
  await tapAt(
    driver,
    Math.round(width * 0.42),
    Math.round(height * 0.44),
    "first sound result coordinate fallback"
  );
  await pause(driver, 1200);
  return true;
}

async function tapBestSoundSearchResult(driver) {
  const tokens = soundQueryTokens();
  if (tokens.length === 0) {
    return false;
  }

  const { width, height } = await getScreenSize(driver);
  const rows = await soundResultRows(driver, width, height);
  const rankedRows = rows
    .map((row, index) => ({ row, index, ...scoreSoundResultRow(row, tokens, index) }))
    .sort((a, b) => b.score - a.score);
  const best = rankedRows[0];
  const requiredMatches = tokens.length >= 4 ? Math.max(3, tokens.length - 1) : tokens.length;

  if (!best || best.matchedTokens.length < requiredMatches) {
    if ((await isSoundPickerVisible(driver)) && rowsLookLikeEditorTools(rows)) {
      const visibleRows = rows.slice(0, 5).map((row) => `"${row.text}"`).join("; ");
      console.warn(
        `Sound picker results are visible but accessibility tree is stale; tapping first sound result by coordinate. Rows seen: ${visibleRows || "none"}`
      );
      return tapFirstSoundResultByCoordinate(driver);
    }

    if ((await isSoundPickerVisible(driver)) && rows.length > 0 && !rowsLookLikeEditorTools(rows)) {
      const firstRow = rows[0];
      const tapX = firstRow ? Math.max(48, Math.min(Math.round(width * 0.42), firstRow.left + 24)) : Math.round(width * 0.18);
      const tapY = firstRow ? firstRow.centerY : Math.round(height * 0.275);
      const visibleRows = rows.slice(0, 5).map((row) => `"${row.text}"`).join("; ");
      console.warn(
        `Could not read matching sound rows from accessibility tree; tapping first visible sound result. Rows seen: ${visibleRows || "none"}`
      );
      await tapAt(driver, tapX, tapY, "first visible sound result fallback");
      await pause(driver, 1200);
      return true;
    }

    const visibleRows = rows.slice(0, 5).map((row) => `"${row.text}"`).join("; ");
    throw new Error(
      `Could not find a close sound match for "${soundSearchQuery()}". Visible results: ${visibleRows || "none"}`
    );
  }

  const tapX = Math.max(Math.round(width * 0.28), Math.min(Math.round(width * 0.62), Math.round((best.row.left + best.row.right) / 2)));
  const tapY = best.row.centerY;
  console.log(
    `Selected sound result match ${best.matchedTokens.length}/${tokens.length}: ${best.row.text}`
  );
  await tapAt(driver, tapX, tapY, "best matching sound result");
  await pause(driver, 1200);
  return true;
}

async function tapSoundResultRetryPoints(driver) {
  const { width, height } = await getScreenSize(driver);
  const rows = await soundResultRows(driver, width, height);
  const row = rows[0];
  const y = row ? row.centerY : Math.round(height * 0.275);
  const points = [
    [Math.round(width * 0.16), y],
    [Math.round(width * 0.30), y],
    [Math.round(width * 0.50), y],
  ];

  for (const [x, pointY] of points) {
    if (!(await isSoundPickerVisible(driver))) {
      return true;
    }

    await tapAt(driver, x, pointY, "sound result retry");
    await pause(driver, 1000);
  }

  return !(await isSoundPickerVisible(driver));
}

async function tapAddThisMusicButtonFromSource(driver) {
  const source = await driver.getPageSource().catch(() => "");
  const nodes = parseUiNodes(source);
  const addButton = nodes.find((node) => /add this music to your video/i.test(node.text));
  if (!addButton) {
    return false;
  }

  const tapX = Math.round((addButton.bounds.left + addButton.bounds.right) / 2);
  const tapY = Math.round((addButton.bounds.top + addButton.bounds.bottom) / 2);
  await tapAt(driver, tapX, tapY, "Add this music button");
  await pause(driver, 1200);
  return true;
}

async function tapFirstSoundSuggestion(driver) {
  if (await tapBestSoundSearchResult(driver)) {
    return true;
  }

  const result = await findFirst(driver, soundResultSelectors(), 1800);
  if (result) {
    await clickElement(driver, result, "sound result");
    await pause(driver, 1200);
    return true;
  }

  const { width, height } = await getScreenSize(driver);
  await tapAt(driver, Math.round(width * 0.34), Math.round(height * 0.28), "first sound suggestion fallback");
  await pause(driver, 1200);
  return true;
}

async function isSoundPickerVisible(driver) {
  const soundPicker = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^sounds$")',
      'android=new UiSelector().descriptionMatches("(?i)^sounds$")',
      'android=new UiSelector().textMatches("(?i)(create music|cancel)")',
      'android=new UiSelector().descriptionMatches("(?i)(create music|cancel)")',
      'android=new UiSelector().resourceId("com.google.android.youtube:id/music_picker_search_box")',
      'android=new UiSelector().resourceId("com.google.android.youtube:id/music_picker_header_title_text")',
    ],
    300
  );
  if (soundPicker) {
    return true;
  }

  const editorNext = await findFirst(
    driver,
    [
      '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button"]',
      'android=new UiSelector().resourceId("com.google.android.youtube:id/shorts_post_bottom_button")',
    ],
    150
  );
  if (editorNext) {
    return false;
  }

  return false;
}

async function openAddSound(driver) {
  const opened = await clickIfPresent(driver, addSoundSelectors(), "Add sound", 1800);
  if (opened) {
    await pause(driver, 1200);
    return true;
  }

  const { width, height } = await getScreenSize(driver);
  const fallbackPoints = [
    [0.50, 0.08],
    [0.50, 0.12],
    [0.28, 0.08],
  ];

  for (const [px, py] of fallbackPoints) {
    await tapAt(driver, Math.round(width * px), Math.round(height * py), `Add sound fallback ${px},${py}`);
    await pause(driver, 800);

    const searchVisible = await findFirst(driver, soundSearchSelectors(), 600);
    if (searchVisible) {
      return true;
    }
  }

  return false;
}

async function searchSound(driver) {
  const query = soundSearchQuery();
  const searchControl = await findFirst(driver, soundSearchSelectors(), 2000);

  if (!searchControl) {
    throw new Error("Could not find Add sound search input/button");
  }

  await clickElement(driver, searchControl, "sound search");
  await pause(driver, 500);

  const input = await findFirst(
    driver,
    [
      'android=new UiSelector().className("android.widget.EditText").instance(0)',
      'android=new UiSelector().textMatches("(?i)(search|search music|search songs|search sounds)")',
      'android=new UiSelector().descriptionMatches("(?i)(search|search music|search songs|search sounds)")',
    ],
    1600
  );

  if (!input) {
    throw new Error("Could not find sound search text field");
  }

  await input.click();
  await input.clearValue().catch(() => undefined);
  await input.setValue(query).catch(() => undefined);
  await pause(driver, 500);
  await mobileShell(driver, "input", ["keyevent", "ENTER"]).catch(() => undefined);
  console.log(`Searched sound: ${query}`);
  if (!(await waitForSoundSearchResults(driver, 6000))) {
    const source = await driver.getPageSource().catch(() => "");
    const { width, height } = await getScreenSize(driver);
    const visibleRows = soundResultRowsFromSource(source, width, height)
      .slice(0, 5)
      .map((row) => `"${row.text}"`)
      .join("; ");
    throw new Error(`Could not verify sound search results for "${query}". Visible rows: ${visibleRows || "none"}`);
  }
}

async function chooseSoundResult(driver) {
  if (!(await isSoundPickerVisible(driver))) {
    throw new Error("Sound picker closed after search; refusing to select from editor screen");
  }

  await tapFirstSoundSuggestion(driver);

  const clickedConfirm = await clickIfPresent(
    driver,
    [
      'android=new UiSelector().descriptionMatches("(?i)(add this music to your video|use this sound|add this sound)")',
      '//*[contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"add this music to your video")]',
      '//*[contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"use this sound")]',
      'android=new UiSelector().textMatches("(?i)(use|done|select)")',
      'android=new UiSelector().descriptionMatches("(?i)(use|done|select)")',
      'android=new UiSelector().resourceIdMatches("(?i).*(use|done|select|confirm|check).*")',
    ],
    "confirm sound",
    1200
  );
  if (!clickedConfirm) {
    await tapAddThisMusicButtonFromSource(driver);
  }
  await pause(driver, 1200);

  if (await isSoundPickerVisible(driver)) {
    const closed = await clickIfPresent(
      driver,
      [
        'android=new UiSelector().textMatches("(?i)(done|use|select)")',
        'android=new UiSelector().descriptionMatches("(?i)(done|use|select)")',
      ],
      "close sound picker",
      800
    );
    if (!closed && !(await tapSoundResultRetryPoints(driver)) && (await isSoundPickerVisible(driver))) {
      throw new Error("Sound picker is still open after selecting sound");
    }
  }
}

async function lowerSelectedSoundVolume(driver) {
  const requestedVolume = Number.isFinite(config.soundVolumePercent) ? config.soundVolumePercent : 8;
  const volumePercent = Math.max(0, Math.min(100, requestedVolume));
  const { width, height } = await getScreenSize(driver);

  await tapAt(driver, Math.round(width * 0.90), Math.round(height * 0.09), "sound volume button");
  await pause(driver, 900);

  const volumeSheet = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^volume$")',
      'android=new UiSelector().descriptionMatches("(?i)^volume$")',
    ],
    500
  );

  if (!volumeSheet) {
    console.warn("Could not verify Volume sheet; skipping sound volume adjustment.");
    return false;
  }

  let sliderLeft = Math.round(width * 0.04);
  let sliderRight = Math.round(width * 0.97);
  let musicSliderY = Math.round(height * 0.875);

  const seekBars = await driver.$$('android=new UiSelector().className("android.widget.SeekBar")').catch(() => []);
  if (seekBars.length >= 2) {
    const bounds = parseBounds(await seekBars[1].getAttribute("bounds").catch(() => ""));
    if (bounds) {
      sliderLeft = bounds.left;
      sliderRight = bounds.right;
      musicSliderY = Math.round((bounds.top + bounds.bottom) / 2);
    }
  }

  const targetX = sliderLeft + Math.round((sliderRight - sliderLeft) * (volumePercent / 100));

  await mobileShell(driver, "input", ["tap", targetX.toString(), musicSliderY.toString()]);
  await pause(driver, 250);
  await mobileShell(driver, "input", [
    "swipe",
    sliderRight.toString(),
    musicSliderY.toString(),
    targetX.toString(),
    musicSliderY.toString(),
    "700",
  ]);
  await pause(driver, 250);
  await tapAt(driver, targetX, musicSliderY, `selected sound volume ${volumePercent}%`);
  await pause(driver, 400);
  await closeVolumeSheet(driver);

  console.log(`Selected sound volume set near ${volumePercent}%`);
  return true;
}

async function closeDiscardMenuIfPresent(driver) {
  const saveWithoutSound = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i).*save without sound.*")',
      'android=new UiSelector().descriptionMatches("(?i).*save without sound.*")',
    ],
    300
  );

  const cancel = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)^cancel$")',
      'android=new UiSelector().descriptionMatches("(?i)^cancel$")',
      '//*[translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="cancel"]',
    ],
    500
  );

  if (!cancel) {
    return false;
  }

  await tapElementCenterWithAdb(driver, cancel, saveWithoutSound ? "save without sound Cancel" : "discard menu Cancel");
  await pause(driver, 700);
  return true;
}

async function isVolumeSheetVisible(driver) {
  return Boolean(
    await findFirst(
      driver,
      [
        'android=new UiSelector().textMatches("(?i)^volume$")',
        'android=new UiSelector().descriptionMatches("(?i)^volume$")',
      ],
      300
    )
  );
}

async function closeVolumeSheet(driver) {
  await closeDiscardMenuIfPresent(driver);

  if (!(await isVolumeSheetVisible(driver))) {
    return false;
  }

  const { width, height } = await getScreenSize(driver);
  const points = [
    [0.945, 0.665],
    [0.945, 0.700],
    [0.900, 0.665],
  ];

  for (const [px, py] of points) {
    const x = Math.round(width * px);
    const y = Math.round(height * py);
    await tapAt(driver, x, y, `Volume done ${px},${py}`);
    await pause(driver, 150);
    await mobileShell(driver, "input", ["tap", String(x), String(y)]).catch(() => undefined);
    await pause(driver, 450);
    await closeDiscardMenuIfPresent(driver);

    if (!(await isVolumeSheetVisible(driver))) {
      return true;
    }
  }

  console.warn("Volume sheet still visible after tapping done; continuing without BACK to avoid discard menu.");
  return false;
}

async function openSelectedSoundTiming(driver) {
  await closeDiscardMenuIfPresent(driver);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await closeDiscardMenuIfPresent(driver);
    const soundButton = await findFirst(
      driver,
      [
        '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_edit_sound_button"]',
        'android=new UiSelector().resourceId("com.google.android.youtube:id/shorts_edit_sound_button")',
        'android=new UiSelector().resourceId("com.google.android.youtube:id/sound_button_title")',
        `android=new UiSelector().textContains("${escapeUiText(config.songTitle || config.soundName || "")}")`,
        `android=new UiSelector().descriptionContains("${escapeUiText(config.songTitle || config.soundName || "")}")`,
      ].filter((selector) => !selector.includes('textContains("")') && !selector.includes('descriptionContains("")')),
      1200
    );

    if (soundButton) {
      await tapElementCenterWithAdb(driver, soundButton, `selected sound chip ${attempt}`);
    } else {
      const { width, height } = await getScreenSize(driver);
      const x = Math.round(width * 0.50);
      const y = Math.round(height * 0.10);
      await tapAt(driver, x, y, `selected sound chip fallback ${attempt}`);
      await mobileShell(driver, "input", ["tap", String(x), String(y)]).catch(() => undefined);
    }

    await pause(driver, 900);
    await closeDiscardMenuIfPresent(driver);
    if (await soundTimingSeekInfo(driver)) {
      return true;
    }
  }

  throw new Error("Could not open selected sound timing screen");
}

async function closeSoundTimingIfOpen(driver) {
  const closed = await clickIfPresent(
    driver,
    [
      'android=new UiSelector().resourceId("com.google.android.youtube:id/overlay_dialog_fragment_done")',
      '//android.widget.Button[@resource-id="com.google.android.youtube:id/overlay_dialog_fragment_done"]',
      'android=new UiSelector().textMatches("(?i)(done|save|apply|use)")',
      'android=new UiSelector().descriptionMatches("(?i)(done|save|apply|use|close)")',
      'android=new UiSelector().resourceIdMatches("(?i).*(done|save|apply|confirm|close).*")',
    ],
    "sound timing done",
    900
  );

  if (closed) {
    await pause(driver, 700);
    return true;
  }

  const { width, height } = await getScreenSize(driver);
  await tapAt(driver, Math.round(width * 0.90), Math.round(height * 0.90), "sound timing done fallback");
  await pause(driver, 700);
  return false;
}

async function soundTimingSeekInfo(driver) {
  const seekBar = await findFirst(
    driver,
    [
      'android=new UiSelector().resourceId("com.google.android.youtube:id/play_progress_bar")',
      '//android.widget.SeekBar[@resource-id="com.google.android.youtube:id/play_progress_bar"]',
      'android=new UiSelector().className("android.widget.SeekBar").instance(0)',
    ],
    1200
  );

  if (!seekBar) {
    return null;
  }

  const bounds = parseBounds(await seekBar.getAttribute("bounds").catch(() => ""));
  if (!bounds) {
    return null;
  }

  const contentDesc = await seekBar.getAttribute("content-desc").catch(() => "");
  const selectedMatch = String(contentDesc).match(/selected at (.*?) out of/i);
  const totalMatch = String(contentDesc).match(/out of (.*)$/i);
  const currentSeconds = selectedMatch ? parseVerboseDurationSeconds(selectedMatch[1]) : null;
  const totalSeconds = totalMatch ? parseVerboseDurationSeconds(totalMatch[1]) : null;

  return { bounds, currentSeconds, totalSeconds };
}

async function soundWaveformBounds(driver) {
  const waveform = await findFirst(
    driver,
    [
      'android=new UiSelector().resourceId("com.google.android.youtube:id/waveform_container")',
      '//android.widget.RelativeLayout[@resource-id="com.google.android.youtube:id/waveform_container"]',
      'android=new UiSelector().resourceId("com.google.android.youtube:id/waveform_view")',
    ],
    1000
  );

  if (!waveform) {
    return null;
  }

  return parseBounds(await waveform.getAttribute("bounds").catch(() => ""));
}

async function adjustSelectedSoundStart(driver) {
  if (!Number.isFinite(config.soundStartSeconds) || config.soundStartSeconds <= 0) {
    if (!Number.isFinite(config.soundStartPercent) || config.soundStartPercent <= 0) {
      return false;
    }
  }

  await openSelectedSoundTiming(driver);

  const { width, height } = await getScreenSize(driver);
  let seekInfo = await soundTimingSeekInfo(driver);
  const totalSeconds = seekInfo && seekInfo.totalSeconds ? seekInfo.totalSeconds : 223;
  const desiredSeconds = Number.isFinite(config.soundStartSeconds) && config.soundStartSeconds > 0
    ? Math.min(config.soundStartSeconds, totalSeconds)
    : Math.round(totalSeconds * Math.max(0, Math.min(100, config.soundStartPercent)) / 100);

  const waveformBounds = await soundWaveformBounds(driver);
  if (seekInfo && waveformBounds && seekInfo.currentSeconds != null) {
    const toleranceSeconds = Math.max(2, Math.round(totalSeconds * 0.015));
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const currentSeconds = seekInfo.currentSeconds == null ? desiredSeconds : seekInfo.currentSeconds;
      const diffSeconds = desiredSeconds - currentSeconds;
      if (Math.abs(diffSeconds) <= toleranceSeconds) {
        break;
      }

      const waveformWidth = waveformBounds.right - waveformBounds.left;
      const largeCorrection = Math.abs(diffSeconds) > 8;
      const fromX = largeCorrection
        ? (diffSeconds > 0 ? waveformBounds.right - 25 : waveformBounds.left + 25)
        : Math.round((waveformBounds.left + waveformBounds.right) / 2);
      const fineDragPixels = Math.round(-(diffSeconds / totalSeconds) * waveformWidth * 4);
      const toX = largeCorrection
        ? (diffSeconds > 0 ? waveformBounds.left + 25 : waveformBounds.right - 25)
        : Math.max(waveformBounds.left + 25, Math.min(waveformBounds.right - 25, fromX + fineDragPixels));
      const y = Math.round((waveformBounds.top + waveformBounds.bottom) / 2);

      console.log(`Sound start correction attempt ${attempt}: current=${currentSeconds}s desired=${desiredSeconds}s from=${fromX} to=${toX}`);
      await swipeAtWithAdb(driver, fromX, y, toX, y, largeCorrection ? 1500 : 900, `sound waveform start ${desiredSeconds}s attempt ${attempt}`);
      await pause(driver, 700);
      seekInfo = await soundTimingSeekInfo(driver);
      if (!seekInfo || seekInfo.currentSeconds == null) {
        break;
      }
    }
  } else {
    const waveformLeft = waveformBounds ? waveformBounds.left : Math.round(width * 0.04);
    const waveformRight = waveformBounds ? waveformBounds.right : Math.round(width * 0.96);
    const waveformY = waveformBounds ? Math.round((waveformBounds.top + waveformBounds.bottom) / 2) : Math.round(height * 0.81);
    const ratio = Math.max(0, Math.min(0.98, desiredSeconds / totalSeconds));
    const targetX = Math.round(waveformLeft + (waveformRight - waveformLeft) * ratio);

    await swipeAtWithAdb(driver, Math.round((waveformLeft + waveformRight) / 2), waveformY, targetX, waveformY, 900, `sound waveform start ${desiredSeconds}s fallback`);
    await pause(driver, 300);
  }

  const finalInfo = await soundTimingSeekInfo(driver);
  console.log(`Selected sound start adjusted near ${desiredSeconds}s of ${totalSeconds}s${finalInfo && finalInfo.currentSeconds != null ? `; now ${finalInfo.currentSeconds}s` : ""}`);
  await closeSoundTimingIfOpen(driver);
  return true;
}

async function addSoundIfConfigured(driver) {
  if (!hasSoundInput()) {
    return false;
  }

  console.log(`Adding sound: ${soundSearchQuery()}`);
  const opened = await openAddSound(driver);
  if (!opened) {
    throw new Error("Could not open Add sound");
  }

  await searchSound(driver);
  await chooseSoundResult(driver);
  console.log("Sound selected");
  await lowerSelectedSoundVolume(driver);
  await adjustSelectedSoundStart(driver);
  return true;
}

async function continueAfterMediaSelected(driver) {

  await clickIfPresent(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(next)")',
      'android=new UiSelector().descriptionMatches("(?i)(next)")',
    ],
    "first Next",
    1500
  );
  await pause(driver, 900);

  if (await isMediaPickerVisible(driver)) {
    const { width, height } = await getScreenSize(driver);
    const fallbackPoints = [
      [0.86, 0.93],
      [0.90, 0.90],
      [0.50, 0.93],
    ];

    for (const [px, py] of fallbackPoints) {
      await tapAt(driver, Math.round(width * px), Math.round(height * py), `media picker continue fallback ${px},${py}`);
      await pause(driver, 900);
      if (!(await isMediaPickerVisible(driver))) {
        return;
      }
    }

    throw new Error("Could not pick video from media picker");
  }
}

async function readTrimScreenDurationSeconds(driver, requestedSeconds = null) {
  if (Number.isFinite(config.sourceDurationSeconds) && config.sourceDurationSeconds > 0) {
    return config.sourceDurationSeconds;
  }

  const source = await driver.getPageSource().catch(() => "");
  const candidates = [];
  const durationPattern = /(?:text|content-desc)="([^"]*(?:\d+(?::\d+){1,2}|\d+(?:\.\d+)?\s*[hms])[^"]*)"/gi;
  let match;

  while ((match = durationPattern.exec(source))) {
    const raw = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const tokenMatches = raw.match(/\d+(?::[0-5]?\d){1,2}(?:\.\d+)?|\d+(?:\.\d+)?\s*h\s*(?:\d+(?:\.\d+)?\s*m)?\s*(?:\d+(?:\.\d+)?\s*s)?|\d+(?:\.\d+)?\s*m\s*(?:\d+(?:\.\d+)?\s*s)?|\d+(?:\.\d+)?\s*s/gi) || [];

    for (const token of tokenMatches) {
      const seconds = parseDurationSeconds(token);
      if (seconds && Number.isFinite(seconds)) {
        candidates.push(seconds);
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const uniqueCandidates = [...new Set(candidates.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b);
  if (Number.isFinite(requestedSeconds) && requestedSeconds > 0) {
    const selectedDuration = uniqueCandidates.find((value) => value >= requestedSeconds * 1.05);
    if (selectedDuration) {
      console.log(`Trim duration candidates: ${uniqueCandidates.join(", ")}; using ${selectedDuration}s`);
      return selectedDuration;
    }
  }

  console.log(`Trim duration candidates: ${uniqueCandidates.join(", ")}; using ${uniqueCandidates[0]}s`);
  return uniqueCandidates[0];
}

async function adjustTrimDurationIfConfigured(driver) {
  const requestedSeconds = config.clipDurationSeconds;
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
    return false;
  }

  const totalSeconds = await readTrimScreenDurationSeconds(driver, requestedSeconds);
  if (!totalSeconds || requestedSeconds >= totalSeconds) {
    console.log(`Skipping trim duration adjustment; requested=${requestedSeconds}s total=${totalSeconds || "unknown"}s`);
    return false;
  }

  const { width, height } = await getScreenSize(driver);
  const timelineLeft = Math.round(width * 0.05);
  const timelineRight = Math.round(width * 0.94);
  const baseTimelineYPercent = Number.isFinite(config.trimTimelineYPercent) && config.trimTimelineYPercent > 0
    ? config.trimTimelineYPercent
    : 0.815;
  const timelineYPercents = [baseTimelineYPercent].filter((value) => value > 0.72 && value < 0.90);
  const ratio = Math.max(0.05, Math.min(0.98, requestedSeconds / totalSeconds));
  const minVisibleSelectionWidth = Math.round(width * 0.12);
  const targetRight = Math.max(
    Math.round(width * 0.16),
    Math.round(timelineLeft + (timelineRight - timelineLeft) * ratio),
    timelineLeft + minVisibleSelectionWidth
  );

  for (const yPercent of timelineYPercents) {
    const timelineY = Math.round(height * yPercent);
    await swipeAtWithAdb(driver, timelineRight, timelineY, targetRight, timelineY, 900, `trim right handle to ${requestedSeconds}s y=${yPercent.toFixed(3)}`);
    await pause(driver, 350);
  }

  await pause(driver, 800);
  console.log(`Trim duration requested: ${requestedSeconds}s of ${totalSeconds}s`);
  return true;
}

async function continueAfterTrimScreen(driver) {
  await adjustTrimDurationIfConfigured(driver);

  const clicked = await clickIfPresent(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(done|next|continue)")',
      'android=new UiSelector().descriptionMatches("(?i)(done|next|continue)")',
      'android=new UiSelector().resourceIdMatches("(?i).*(done|next|continue).*")',
    ],
    "trim Done",
    1800
  );

  if (!clicked) {
    const { width, height } = await getScreenSize(driver);
    await tapAt(driver, Math.round(width * 0.86), Math.round(height * 0.90), "trim Done fallback");
  }

  console.log("Waiting after trim for YouTube processing");
  await pause(driver, 8000);
}

async function fillDetails(driver) {
  await typeIntoFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(create a title|add a title|title)")',
      'android=new UiSelector().descriptionMatches("(?i)(create a title|add a title|title)")',
      "android=new UiSelector().className(\"android.widget.EditText\").instance(0)",
    ],
    config.title,
    "title"
  );

  const descriptionInput = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(description)")',
      'android=new UiSelector().descriptionMatches("(?i)(description)")',
      "android=new UiSelector().className(\"android.widget.EditText\").instance(1)",
    ],
    1500
  );

  if (descriptionInput) {
    await descriptionInput.click();
    await descriptionInput.setValue(config.description);
    console.log("Filled description");
  }

  await clickFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(next)")',
      'android=new UiSelector().descriptionMatches("(?i)(next)")',
    ],
    "details Next",
    5000
  );
  await pause(driver, 2500);
}

async function continueAfterMediaSelectedRobust(driver) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (await isSoundPickerVisible(driver)) {
      throw new Error("Still on Sounds screen; sound was not selected");
    }

    const titleInput = await findFirst(driver, titleInputSelectors(), 700);
    if (titleInput) {
      console.log("Upload details screen is visible");
      return;
    }

    console.log(`Preview stage: pressing bottom-right action attempt ${attempt}`);
    await pressBottomRightAction(driver, `preview Next ${attempt}`);
    await pause(driver, 1200);
  }

  console.warn("Still could not find title input after multiple Next attempts.");
}

async function fillDetailsRobust(driver) {
  if (await isSoundPickerVisible(driver)) {
    throw new Error("Still on Sounds screen; refusing to type title into sound search");
  }

  let titleInput = await findFirst(driver, titleInputSelectors(), 1200);

  for (let attempt = 1; !titleInput && attempt <= 2; attempt += 1) {
    await clickNext(driver, `details Next fallback ${attempt}`);
    await pause(driver, 800);
    if (await isSoundPickerVisible(driver)) {
      throw new Error("Still on Sounds screen; refusing to type title into sound search");
    }
    titleInput = await findFirst(driver, titleInputSelectors(), 1200);
  }

  if (!titleInput) {
    const directUploadButton = await findFirst(driver, uploadButtonSelectors(), 1000);
    if (directUploadButton) {
      console.log("Add details screen has direct Upload button but no caption input");
      await directUploadButton.click();
      console.log("Direct Upload button clicked");
      await pause(driver, 2500);
      return true;
    }

    throw new Error("Could not find input for title/caption");
  }

  await titleInput.click();
  await titleInput.clearValue().catch(() => undefined);
  await titleInput.setValue(config.title);
  console.log("Filled title");

  const descriptionInput = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(description)")',
      'android=new UiSelector().descriptionMatches("(?i)(description)")',
      "android=new UiSelector().className(\"android.widget.EditText\").instance(1)",
    ],
    700
  );

  if (descriptionInput) {
    await descriptionInput.click();
    await descriptionInput.setValue(config.description);
    console.log("Filled description");
  }

  const uploadAfterDetails = await findFirst(driver, uploadButtonSelectors(), 1000);
  if (uploadAfterDetails) {
    console.log("Short details screen has Upload/Post button");
    return false;
  }

  await clickNext(driver, "details Next");
  await pause(driver, 800);
  return false;
}

async function chooseAudience(driver) {
  const audiencePrompt = await findFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i).*(audience|made for kids|kids).*")',
      'android=new UiSelector().descriptionMatches("(?i).*(audience|made for kids|kids).*")',
    ],
    1500
  );

  if (!audiencePrompt) {
    console.log("Audience screen not detected; continuing");
    return false;
  }

  const selectors = config.madeForKids
    ? [
        'android=new UiSelector().textMatches("(?i).*(yes.*made for kids|made for kids).*")',
        'android=new UiSelector().descriptionMatches("(?i).*(yes.*made for kids|made for kids).*")',
      ]
    : [
        'android=new UiSelector().textMatches("(?i).*(no.*not made for kids|not made for kids|not for kids).*")',
        'android=new UiSelector().descriptionMatches("(?i).*(no.*not made for kids|not made for kids|not for kids).*")',
      ];

  const selected = await clickIfPresent(driver, selectors, config.madeForKids ? "made for kids" : "not made for kids", 1200);
  if (!selected) {
    const { width, height } = await getScreenSize(driver);
    const y = config.madeForKids ? Math.round(height * 0.42) : Math.round(height * 0.52);
    await tapAt(driver, Math.round(width * 0.16), y, config.madeForKids ? "made for kids fallback" : "not made for kids fallback");
  }

  await pause(driver, 700);
  await clickNext(driver, "audience Next");
  await pause(driver, 1000);
  console.log(`Audience selected: ${config.madeForKids ? "made for kids" : "not made for kids"}`);
  return true;
}

async function finishUpload(driver) {
  await pressUploadShort(driver);
  console.log("Final publish/upload button clicked");
  await pause(driver, 2500);
  return true;
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
      "appium:udid": config.udid,
      ...(config.systemPort ? { "appium:systemPort": config.systemPort } : {}),
      "appium:autoLaunch": false,
      "appium:noReset": true,
      "appium:fullReset": false,
      "appium:autoGrantPermissions": true,
      "appium:newCommandTimeout": 120,
    },
  });

  try {
    await tuneAppiumSettings(driver);
    console.log(`Connected to ${config.udid}`);
    if (config.videoPath) {
      console.log(`Video: ${config.videoPath}`);
    } else {
      console.log("Video: existing media picker item");
    }
    console.log(`Title: ${config.title}`);
    if (hasSoundInput()) {
      console.log(`Sound: ${soundSearchQuery()}`);
    }

    const deviceVideoPath = await prepareDeviceMedia(driver);
    await openYoutube(driver);
    await openCreateShort(driver);
    await chooseRandomVisibleVideo(driver);
    await continueAfterMediaSelected(driver);
    await continueAfterTrimScreen(driver);
    await addSoundIfConfigured(driver);
    await continueAfterMediaSelectedRobust(driver);
    const alreadyUploaded = await fillDetailsRobust(driver);
    if (alreadyUploaded) {
      return {
        ok: true,
        published: true,
        deviceUdid: config.udid,
        sourceVideoPath: config.videoPath,
        deviceVideoPath,
        title: config.title,
        soundQuery: config.soundQuery,
        soundName: config.soundName,
        songTitle: config.songTitle,
      };
    }
    const readyToPublish = await findFirst(driver, uploadButtonSelectors(), 1000);
    if (!readyToPublish) {
      await chooseAudience(driver);
    }
    const published = await finishUpload(driver);
    return {
      ok: true,
      published,
      deviceUdid: config.udid,
      sourceVideoPath: config.videoPath,
      deviceVideoPath,
      title: config.title,
      soundQuery: config.soundQuery,
      soundName: config.soundName,
      songTitle: config.songTitle,
    };
  } finally {
    await driver.deleteSession().catch((error) => {
      console.warn("Could not delete Appium session cleanly", error.message || error);
    });
  }
}

main()
  .then((result) => {
    if (result) {
      console.log("RESULT_JSON", JSON.stringify(result));
    }
  })
  .catch((error) => {
    console.error(error);
    console.log(
      "RESULT_JSON",
      JSON.stringify({
        ok: false,
        error: error.message || String(error),
        deviceUdid: config.udid,
        sourceVideoPath: config.videoPath,
        title: config.title,
      })
    );
    process.exitCode = 1;
  });
