# Video Enhancer

[Website](https://treeks12.github.io/video-enhancer/) · [Releases](https://github.com/treeks12/video-enhancer/releases)

## What it does

Enhances the main video on a page locally with WebGL2:

- FSR1 (EASU + RCAS) for upscaling and sharpening;
- RAVU-lite + RCAS for adaptive reconstruction;
- experimental frame interpolation for video near 24/30 fps.

There is no telemetry or data collection. The only permission is `storage`, used to save local preferences.

## How to use

1. Download the ZIP for Firefox or Chromium from [Releases](https://github.com/treeks12/video-enhancer/releases).
2. Install it from your browser's extension store. For local testing, use `about:debugging#/runtime/this-firefox` in Firefox or enable Developer mode and **Load unpacked** in Chromium browsers.
3. Open a page with video, click the extension icon, and select Native, FSR1, or RAVU.
4. Enable interpolation only if you want to test 2× output on sources near 24/30 fps.

## Known bugs

- Interpolation can produce ghosting or distortion around occlusions, extreme motion, and scene cuts.
- DRM-protected or CORS-blocked video may reject processing.
- Only the main video in the top-level document is processed; videos inside iframes are unsupported.
- RAVU and interpolation can be reduced or cancelled when they do not fit the GPU budget.
