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
  udid: process.env.ANDROID_DEVICE_UDID || process.env.UDID || "ce031713612cd4040c",
  videoPath: cliArgs.videoPath || process.env.YT_VIDEO_PATH || process.env.VIDEO_PATH || "",
  title: cliArgs.title || process.env.YT_TITLE || process.env.TITLE || "",
  description: process.env.YT_DESCRIPTION || "Uploaded from Appium automation.",
  soundQuery: cliArgs.sound || cliArgs.soundQuery || process.env.YT_SOUND || process.env.YT_SOUND_QUERY || "",
  soundName: cliArgs.soundName || process.env.YT_SOUND_NAME || process.env.SOUND_NAME || "",
  songTitle: cliArgs.songTitle || process.env.YT_SONG_TITLE || process.env.YT_SOUND_TITLE || process.env.SONG_TITLE || "",
  madeForKids: /^true$/i.test(process.env.YT_MADE_FOR_KIDS || ""),
  confirmPublish: !/^false$/i.test(process.env.YT_CONFIRM_PUBLISH || ""),
  verifyCleanup: /^true$/i.test(process.env.YT_VERIFY_CLEANUP || ""),
  mediaIndex: process.env.YT_VIDEO_INDEX || "0",
};

function validateInputs() {
  if (!config.videoPath) {
    throw new Error("Missing input videoPath. Use --videoPath \"C:\\path\\video.mp4\" or set YT_VIDEO_PATH.");
  }

  if (!config.title) {
    throw new Error("Missing input title. Use --title \"Your title\" or set YT_TITLE.");
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

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

async function pause(driver, ms = 1000) {
  await driver.pause(ms);
}

async function findFirst(driver, selectors, timeout = 800) {
  for (const selector of selectors) {
    const element = await driver.$(selector);
    try {
      await element.waitForExist({ timeout });
      return element;
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
    'android=new UiSelector().textMatches("(?i)(create a short|create short|short)")',
    'android=new UiSelector().descriptionMatches("(?i)(create a short|create short|short)")',
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
  const clicked = await clickIfPresent(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(next|continue|done)")',
      'android=new UiSelector().descriptionMatches("(?i)(next|continue|done)")',
      '//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button"]',
      '//android.widget.Button[@resource-id="com.google.android.youtube:id/upload_bottom_button"]',
    ],
    label,
    600
  );

  if (clicked) {
    return true;
  }

  const { width, height } = await getScreenSize(driver);
  await tapAt(driver, Math.round(width * 0.82), Math.round(height * 0.92), `${label} fast fallback`);
  return false;
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
  await clearOldDeviceMedia(driver);
  return copyVideoToDevice(driver);
}

async function openYoutube(driver) {
  await mobileShell(driver, "monkey", ["-p", YOUTUBE_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"]);
  await pause(driver, 2500);
  
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
  await clickFirst(
    driver,
    [
      'android=new UiSelector().descriptionMatches("(?i)(create)")',
      'android=new UiSelector().textMatches("(?i)(create)")',
      'android=new UiSelector().resourceIdMatches(".*create.*")',
    ],
    "Create"
  );
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
  const x = Math.round(column * cellSize + cellSize / 2);
  const y = Math.round(topInset + row * cellSize + cellSize / 2);

  await tapAt(driver, x, y, `random video ${selectedIndex + 1}/${totalCells}`);
  await pause(driver, 1200);
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
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const result = await findFirst(driver, soundResultSelectors(), 500);
    if (result) {
      return true;
    }
    await pause(driver, 300);
  }
  return false;
}

async function tapFirstSoundSuggestion(driver) {
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
  const { width, height } = await getScreenSize(driver);
  await tapAt(driver, Math.round(width * 0.62), Math.round(height * 0.92), "IME Search");
  await mobileShell(driver, "input", ["keyevent", "ENTER"]).catch(() => undefined);
  console.log(`Searched sound: ${query}`);
  if (!(await waitForSoundSearchResults(driver, 6000))) {
    console.warn(`Could not verify sound search results for: ${query}`);
  }
}

async function chooseSoundResult(driver) {
  await tapFirstSoundSuggestion(driver);

  await clickIfPresent(
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
    if (!closed && (await isSoundPickerVisible(driver))) {
      throw new Error("Sound picker is still open after selecting sound");
    }
  }
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
}

async function continueAfterTrimScreen(driver) {
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

  await pause(driver, 2500);
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
      if (!config.confirmPublish) {
        console.log("Stopped before direct upload. Set YT_CONFIRM_PUBLISH=true to upload automatically.");
        return false;
      }
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

async function finishUpload(driver) {
  if (!config.confirmPublish) {
    console.log("Stopped before final publish. Set YT_CONFIRM_PUBLISH=true to publish automatically.");
    return false;
  }

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
    capabilities: {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "Android",
      "appium:udid": config.udid,
      "appium:appPackage": YOUTUBE_PACKAGE,
      "appium:appActivity": YOUTUBE_ACTIVITY,
      "appium:appWaitPackage": YOUTUBE_PACKAGE,
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
    console.log(`Connected to ${config.udid}`);
    console.log(`Video: ${config.videoPath}`);
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
    await driver.deleteSession();
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
