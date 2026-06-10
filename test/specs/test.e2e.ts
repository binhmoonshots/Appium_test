import { remote } from "webdriverio";

async function main() {
    const driver = await remote({
        hostname: "127.0.0.1",
        port: 4723,
        path: "/",
        capabilities: {
            platformName: "Android",
            "appium:automationName": "UiAutomator2",
            "appium:deviceName": "Android",
            "appium:udid": process.env.ANDROID_DEVICE_UDID || "ce031713612cd4040c",
            "appium:appPackage": "com.google.android.youtube",
            "appium:appActivity": "com.google.android.youtube.app.honeycomb.Shell$HomeActivity",
            "appium:appWaitPackage": "com.google.android.youtube",
            "appium:appWaitActivity": "*",
            "appium:noReset": true,
            "appium:fullReset": false,
            "appium:autoGrantPermissions": true
        }
    });

    await driver.pause(7000);
    await driver.startActivity("com.google.android.youtube", "com.google.android.youtube.app.honeycomb.Shell$HomeActivity");
    await driver.pause(5000);

    console.log(await driver.getCurrentPackage());

    await driver.deleteSession();
}

main();