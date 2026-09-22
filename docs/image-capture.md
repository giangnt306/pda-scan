# Image Capture

Label photos are captured exclusively through the [ImageCapture API](https://developer.mozilla.org/en-US/docs/Web/API/ImageCapture). The live video stream is used only as a viewfinder; the app never creates photos from video frames or canvas snapshots.

## Why ImageCapture Only

The previous implementation supported both `ImageCapture` and video-frame capture. The video-frame approach has been removed because it produces lower-resolution images and can reduce label readability.

|            | `ImageCapture.takePhoto()` | Video-frame capture                    |
| ---------- | -------------------------- | -------------------------------------- |
| Resolution | Sensor still resolution    | Stream resolution, typically 1920×1080 |
| Processing | Still-image pipeline       | Preview/video pipeline                 |
| Latency    | Device-dependent           | Near-instant                           |
| Support    | Chrome/Chromium            | Broad browser support                  |

Image quality is more important than capture speed for small label text. The target environment is Chrome on Android, where `ImageCapture` is supported.

There is **no fallback** to video-frame capture. Silently using a lower-quality image would make recognition failures harder to diagnose.

## Capture Pipeline

```text
MediaStreamTrack
    │
    └─→ ImageCapture.takePhoto({ imageWidth, imageHeight })
          │
          ├─→ Original Blob
          │     └─→ Optional device download
          │
          └─→ Downscale to 1280px / JPEG 0.82
                ├─→ Viewfinder preview
                └─→ recognize()
```

1. **Capabilities** — `getPhotoInfo()` reads `getPhotoCapabilities()` when the sheet opens and displays the maximum still resolution, e.g. `ImageCapture · tối đa 4000×3000`.
2. **Capture** — `takeFullPhoto()` requests the maximum supported dimensions. If the device rejects explicit dimensions, it retries without settings. The shutter is disabled during capture and shows `Đang chụp… giữ yên máy`.
3. **Measurement** — `createImageBitmap()` reads the actual image dimensions because the returned size may differ from the requested size. Capture time is measured with `performance.now()`.
4. **Downscaling** — `downscale()` creates a 1280px long-edge JPEG at quality 0.82 (typically ~150 KB). This copy is used for the preview and recognition.
5. **Storage** — `App.handlePhoto` keeps both versions:

```js
photo = {
  blob, url, width, height,        // downscaled copy
  original: { blob, filename, width, height, bytes, ms },
}
```

The original is several MB, while the downscaled copy is much smaller and faster to send over warehouse Wi-Fi.

## Saving the Original

**Tự lưu ảnh gốc vào máy sau khi chụp** is enabled by default. The original can also be saved manually:

* **Tải lại ảnh gốc** — downloads the original using `saveToDevice`. Chrome for Android saves it to `Download/` and may ask once to allow multiple downloads.
* **Lưu vào Thư viện ảnh** — opens the Android share sheet through the Web Share API (Level 2). The file can be saved to Photos/Google Photos or shared elsewhere. If file sharing is unavailable, a toast points to the download button.

Filenames use this format:

```text
pda_<width>x<height>_<YYYYMMDD-HHMMSS>.jpg
```

## Unsupported Browsers

`imageCaptureSupported()` checks for `window.ImageCapture`.

If unsupported, including Firefox and Safari/iOS:

* The shutter button is hidden.
* The subtitle shows:
  `Trình duyệt không hỗ trợ ImageCapture — không chụp được nhãn`
* Manual label entry remains available.

If `takePhoto()` fails on a supported browser, the error is shown above the shutter, the shutter is re-enabled, and the operator can retry.

## Open Questions

* **Capture latency:** Maximum-resolution capture has not yet been measured on the production PDA. If it is too slow, request a smaller `imageWidth` based on `getPhotoCapabilities()` rather than restoring video-frame capture.
* **Backend image:** Recognition and persistence currently receive the downscaled image. If the original is needed for recognition or dispute handling, upload `photo.original.blob` instead.
* **Photo diagnostics:** The photo panel showing dimensions, file size, capture time, and filename is intended for field testing and can be hidden or removed once capture behaviour is stable.
