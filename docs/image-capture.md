# Image capture

Label photos are taken exclusively through the
[ImageCapture API](https://developer.mozilla.org/en-US/docs/Web/API/ImageCapture).
The live video stream is used only for the viewfinder; no photo is ever produced by drawing a video frame to a canvas.

## Why ImageCapture only

An earlier iteration offered two capture methods side by side, `ImageCapture`
and a canvas grab of the current video frame, so their output could be compared
on the target device. The video-frame path has since been removed.

| | `ImageCapture.takePhoto()` | Video frame grab (removed) |
| --- | --- | --- |
| Resolution | Sensor still resolution, reported by `getPhotoCapabilities()` | Stream resolution, requested as 1920×1080 |
| Processing | Still-capture pipeline of the camera | Preview pipeline, tuned for frame rate |
| Latency | Slower, device dependent | Near-instant |
| Browser support | Chrome and Chromium browsers | Universal |

Legibility of small label text matters more than capture latency, and the
target hardware is Chrome on Android, where ImageCapture is available.

There is deliberately no silent fallback. A fallback would hand the recognition
service a lower-quality image without anyone noticing, which is precisely the
failure that is hardest to diagnose later.

## Pipeline

```
MediaStreamTrack ─→ new ImageCapture(track).takePhoto({ imageWidth, imageHeight })
                          │
                          ├─→ original Blob ─→ saved to device (optional)
                          │                    kept in photo.original
                          │
                          └─→ downscale(1280 px, JPEG 0.82) ─→ viewfinder preview
                                                              ─→ recognize()
```

1. **Capabilities.** When the sheet opens, `getPhotoInfo` reads
   `getPhotoCapabilities()` and the sheet subtitle shows the maximum still size,
   e.g. `ImageCapture · tối đa 4000×3000`.
2. **Shot.** `takeFullPhoto` requests `imageWidth` and `imageHeight` at their
   maximum. Some devices reject an explicit pair; the call is then retried with
   no settings, letting the browser pick. While the photo is taken the shutter
   is disabled and reads "Đang chụp… giữ yên máy".
3. **Measurement.** The actual size is read back from the blob through
   `createImageBitmap`, since the delivered size may differ from the requested
   one. Capture time is measured with `performance.now()`.
4. **Downscale.** `downscale` produces a 1280 px long-edge JPEG at quality 0.82,
   roughly 150 KB. This copy is displayed in the viewfinder and passed to
   `recognize`. The original is several megabytes, which on warehouse WiFi is
   the difference between recognition feeling immediate and not.
5. **Storage.** `App.handlePhoto` keeps both copies in `photo` state:

   ```js
   photo = {
     blob, url, width, height,        // downscaled copy
     original: { blob, filename, width, height, bytes, ms },
   }
   ```

## Saving the original

With "Tự lưu ảnh gốc vào máy sau khi chụp" ticked (the default), the original
is downloaded immediately after each shot. The photo panel also offers:

- **Tải lại ảnh gốc** — download the original again (`saveToDevice`). Chrome for
  Android stores it in `Download/`; from the second file it may ask once to
  allow multiple downloads.
- **Lưu vào Thư viện ảnh** — open the Android share sheet (`shareFile`, Web
  Share API level 2) so the operator can save to Photos, Google Photos, or send
  it on. Where file sharing is unavailable a toast points to the download button.

Files are named by `buildFilename`:

```
pda_<width>x<height>_<YYYYMMDD-HHMMSS>.jpg
```

## Unsupported browsers

`imageCaptureSupported()` checks for `window.ImageCapture`. Where it is absent
(Firefox, Safari, including every browser on iOS), the sheet subtitle reads
"Trình duyệt không hỗ trợ ImageCapture — không chụp được nhãn" and the shutter
button is not rendered. Manual entry is unaffected.

A `takePhoto()` rejection on a supported browser is shown above the shutter
("Chụp thất bại, thử lại" or the browser's message), the shutter is re-enabled,
and the operator can retry.

## Open questions

- **Latency on the target PDA.** Maximum-resolution capture has not been timed
  on the production handset. If it is too slow, request a smaller `imageWidth`
  from `getPhotoCapabilities()` instead of reintroducing video-frame capture.
- **What the backend receives.** Recognition and the persistence payload
  currently use the downscaled copy. If the recognition service benefits from
  the original, or disputes need it, upload `photo.original.blob` instead.
- **Test bench UI.** The photo panel (size, bytes, capture time, filename) is a
  field-trial aid. It can be removed or hidden once capture settings are fixed.
