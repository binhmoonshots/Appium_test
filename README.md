# Appium Environment Setup

Đây là project WebdriverIO + Appium dùng TypeScript để tự động hoá YouTube trên Android mobile web.

## Các bước thiết lập

1. Mở terminal vào `New folder/phonefarm`
2. Cài dependencies:
   ```bash
   npm install
   ```
3. Khởi động Appium server:
   ```bash
   npm run appium
   ```
4. Mở Android emulator hoặc kết nối thiết bị thật.
5. Chạy test:
   ```bash
   npm run wdio
   ```

## Lệnh chính

- `npm run appium` — khởi động Appium server
- `npm run wdio` — chạy WebdriverIO với cấu hình trong `wdio.conf.ts`
- `npm test` — alias chạy `npm run wdio`
- `npm run youtube:upload` — mở app YouTube, chọn ngẫu nhiên một video đang hiện trong media picker và đi tới bước upload cuối.

## Upload video YouTube native

Script mới nằm ở `scripts/youtube-upload-random.js`.

Ví dụ chạy thử, dừng trước nút publish:

```bash
npm run youtube:upload
```

Ví dụ chạy với device cụ thể:

```bash
set ANDROID_DEVICE_UDID=ce031713612cd4040c
set YT_TITLE=Video test Appium
set YT_DESCRIPTION=Uploaded from emulator
npm run youtube:upload
```

Mặc định script không bấm nút Publish/Upload cuối. Nếu muốn tự đăng thật, chỉ bật khi đây là video và kênh của bạn:

```bash
set YT_CONFIRM_PUBLISH=true
npm run youtube:upload
```

## Lưu ý

- Cấu hình `wdio.conf.ts` hiện dùng `browserName: 'Chrome'` và `platformName: 'Android'`.
- Nếu muốn tự động hoá app YouTube native, cần thay `browserName` bằng `appium:appPackage` và `appium:appActivity`.
