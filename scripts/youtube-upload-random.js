const { remote } = require("webdriverio");

const YOUTUBE_PACKAGE = "com.google.android.youtube";
const YOUTUBE_ACTIVITY = "com.google.android.youtube.app.honeycomb.Shell$HomeActivity";

const config = {
  appiumHost: process.env.APPIUM_HOST || "127.0.0.1",
  appiumPort: Number(process.env.APPIUM_PORT || 4723),
  udid: process.env.ANDROID_DEVICE_UDID || process.env.UDID || "ce031713612cd4040c",
  title:
    process.env.YT_TITLE ||
    `Auto upload ${new Date().toISOString().replace(/[:.]/g, "-")}`,
  description: process.env.YT_DESCRIPTION || "Uploaded from Appium automation.",
  madeForKids: /^true$/i.test(process.env.YT_MADE_FOR_KIDS || ""),
  confirmPublish: !/^false$/i.test(process.env.YT_CONFIRM_PUBLISH || ""),
  mediaIndex: process.env.YT_VIDEO_INDEX || "random",
};

function escapeUiText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
    await driver.execute("mobile: shell", {
      command: "input",
      args: ["tap", x.toString(), y.toString()],
    });
    await pause(driver, 300);
  }
}

async function getScreenSize(driver) {
  if (typeof driver.getWindowSize === "function") {
    return driver.getWindowSize();
  }

  const output = await driver.execute("mobile: shell", {
    command: "wm",
    args: ["size"],
  });
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
    'android=new UiSelector().textMatches("(?i)(upload|publish|post)")',
    'android=new UiSelector().descriptionMatches("(?i)(upload|publish|post)")',
    'xpath=//android.widget.Button[@resource-id="com.google.android.youtube:id/upload_bottom_button"]',
  ];
}

async function clickNext(driver, label, allowFallbackTap = true) {
  const clicked = await clickIfPresent(
    driver,
    [
      'xpath=//android.widget.Button[@content-desc="Continue to upload"]',
      'xpath=//android.widget.Button[@content-desc="Continue to editor"]',
      'xpath=//android.widget.Button[@resource-id="com.google.android.youtube:id/shorts_post_bottom_button"]',
      'xpath=//android.widget.Button[@resource-id="com.google.android.youtube:id/upload_bottom_button"]',
      'xpath=//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue to upload")]',
      'xpath=//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue to editor")]',
      'xpath=//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue to upload")]',
      'xpath=//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue to editor")]',
      'xpath=//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
      'xpath=//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
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
      'xpath=//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
      'xpath=//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
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
      'xpath=//*[@content-desc and contains(translate(@content-desc,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
      'xpath=//*[@text and contains(translate(@text,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"continue")]',
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

async function typeIntoFirst(driver, selectors, value, label) {
  const element = await findFirst(driver, selectors, 3000);
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
    await clickIfPresent(driver, selectors, "popup", 1200);
    await pause(driver, 500);
  }
}

async function openYoutube(driver) {
  await driver.execute("mobile: shell", {
    command: "monkey",
    args: ["-p", YOUTUBE_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"],
  });
  await pause(driver, 5000);
  await handleCommonPopups(driver);
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

async function openCreateUpload(driver) {
  await clickFirst(
    driver,
    [
      'android=new UiSelector().descriptionMatches("(?i)(create)")',
      'android=new UiSelector().textMatches("(?i)(create)")',
      'android=new UiSelector().resourceIdMatches(".*create.*")',
    ],
    "Create"
  );
  await pause(driver, 1500);
  await handleCommonPopups(driver);

  const openedUploadMenu = await clickIfPresent(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(upload a video|upload video)")',
      'android=new UiSelector().descriptionMatches("(?i)(upload a video|upload video)")',
    ],
    "Upload video",
    2500
  );

  if (!openedUploadMenu) {
    await openVideoPickerFromCamera(driver);
    return;
  }

  await pause(driver, 2500);
  await handleCommonPopups(driver);
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
    5000
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
  await pause(driver, 3500);
}

async function continueAfterMediaSelected(driver) {
  await handleCommonPopups(driver);

  await clickIfPresent(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(next)")',
      'android=new UiSelector().descriptionMatches("(?i)(next)")',
    ],
    "first Next",
    4000
  );
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
  await handleCommonPopups(driver);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const titleInput = await findFirst(driver, titleInputSelectors(), 700);
    if (titleInput) {
      console.log("Upload details screen is visible");
      return;
    }

    console.log(`Preview stage: pressing Next attempt ${attempt}`);
    const nextPressed = await clickNext(driver, `preview Next ${attempt}`);
    if (!nextPressed) {
      console.warn(`preview Next ${attempt} could not be found; trying region tap fallback`);
    }
    await pause(driver, 2500);
    await handleCommonPopups(driver);
  }

  console.warn("Still could not find title input after multiple Next attempts.");
}

async function fillDetailsRobust(driver) {
  const directUploadButton = await findFirst(driver, uploadButtonSelectors(), 2000);
  if (directUploadButton) {
    console.log("Add details screen has direct Upload button");
    if (!config.confirmPublish) {
      console.log("Stopped before direct upload. Set YT_CONFIRM_PUBLISH=true to upload automatically.");
      return false;
    }
    await directUploadButton.click();
    console.log("Direct Upload button clicked");
    await pause(driver, 5000);
    return true;
  }

  let titleInput = await findFirst(driver, titleInputSelectors(), 2500);

  for (let attempt = 1; !titleInput && attempt <= 2; attempt += 1) {
    await clickNext(driver, `details Next fallback ${attempt}`);
    await pause(driver, 2000);
    titleInput = await findFirst(driver, titleInputSelectors(), 2500);
  }

  if (!titleInput) {
    throw new Error("Could not find input for title");
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
    1500
  );

  if (descriptionInput) {
    await descriptionInput.click();
    await descriptionInput.setValue(config.description);
    console.log("Filled description");
  }

  await clickNext(driver, "details Next");
  await pause(driver, 2500);
  return false;
}

async function chooseAudience(driver) {
  const audienceText = config.madeForKids
    ? "(?i)(yes.*made for kids)"
    : "(?i)(no.*not made for kids)";

  const clickedAudience = await clickIfPresent(
    driver,
    [
      `android=new UiSelector().textMatches("${escapeUiText(audienceText)}")`,
      `android=new UiSelector().descriptionMatches("${escapeUiText(audienceText)}")`,
    ],
    config.madeForKids ? "made for kids" : "not made for kids",
    4000
  );

  if (!clickedAudience) {
    console.log("Audience option not found; leaving current YouTube default selected");
  }

  await clickFirst(
    driver,
    [
      'android=new UiSelector().textMatches("(?i)(next)")',
      'android=new UiSelector().descriptionMatches("(?i)(next)")',
    ],
    "audience Next",
    5000
  );
  await pause(driver, 2500);
}

async function finishUpload(driver) {
  const publishButton = await findFirst(driver, uploadButtonSelectors(), 5000);
  if (!publishButton) {
    throw new Error("Could not find final Upload/Publish button");
  }

  if (!config.confirmPublish) {
    console.log("Stopped before final publish. Set YT_CONFIRM_PUBLISH=true to publish automatically.");
    return false;
  }

  await publishButton.click();
  console.log("Final publish/upload button clicked");
  await pause(driver, 5000);
  return true;
}

async function main() {
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
      "appium:noReset": true,
      "appium:fullReset": false,
      "appium:autoGrantPermissions": true,
      "appium:newCommandTimeout": 300,
    },
  });

  try {
    console.log(`Connected to ${config.udid}`);
    console.log(`Title: ${config.title}`);
    await openYoutube(driver);
    await openCreateUpload(driver);
    await chooseRandomVisibleVideo(driver);
    await continueAfterMediaSelectedRobust(driver);
    const alreadyUploaded = await fillDetailsRobust(driver);
    if (alreadyUploaded) {
      return;
    }
    await chooseAudience(driver);
    await finishUpload(driver);
  } finally {
    await driver.deleteSession();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
