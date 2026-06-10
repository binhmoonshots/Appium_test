import { remote } from 'webdriverio';

const devices = [
  "98895a324b38503834",
  "9889db30413151524b",
  "ce0218221a57842304",
  "ce031713149c743603",
  "ce0317133a49531003",
  "ce031713612cd4040c",
  "ce031713ddc3af0503",
  "ce041714b46f4f3502",
  "ce0517157abaa90a03",
  "ce051715a518bb3605",
  "ce0617160be6c85b0d",
  "ce071827ddee8a0105",
  "ce081718f298521c02",
  "ce091719bc60381204",
  "ce091719d363684b0c",
  "ce091719e5b8c10803",
  "ce091829c407de0301",
  "ce10182af13014da0b",
  "ce12171c88fb571d02",
  "ce12171cc956581501"
];

async function launchPlayStore(driver: any, udid: string) {
    try {
        await driver.startActivity(
            'com.android.vending',
            'com.google.android.finsky.activities.MainActivity'
        );
    } catch {
        await driver.execute('mobile: shell', {
            command: 'monkey',
            args: [
                '-p',
                'com.android.vending',
                '-c',
                'android.intent.category.LAUNCHER',
                '1'
            ]
        });
    }
    console.log(`${udid} opened Play Store`);
    await driver.pause(6000);
}

async function runDevice(udid: string) {
    let driver;

    try {
        driver = await remote({
            hostname: '127.0.0.1',
            port: 4723,
            capabilities: {
                platformName: 'Android',
                'appium:automationName': 'UiAutomator2',
                'appium:udid': udid,
                'appium:noReset': true,
                'appium:newCommandTimeout': 300
            }
        });

        console.log(`${udid} connected`);
        await launchPlayStore(driver, udid);
    } catch (err) {
        console.error(`${udid} failed`, err);
    } finally {
        if (driver) {
            await driver.deleteSession();
        }
    }
}

async function main() {
    await Promise.all(devices.map(device => runDevice(device)));
    console.log('Done');
}

main();