import { remote } from 'webdriverio';

async function main() {
    const driver = await remote({
        hostname: '127.0.0.1',
        port: 4723,
        capabilities: {
            platformName: 'Android',
            'appium:automationName': 'UiAutomator2',
            'appium:udid': 'ce031713ddc3af0503'
        }
    });

    console.log('Connected!');

    await driver.pause(5000);

    await driver.deleteSession();
}

main().catch(console.error);