Major update — smoother playback and more reliable neural interpolation

- New WebGPU pipeline for IFRNet-S interpolation and video enhancement.
- Better playback continuity while preparing the neural model.
- More reliable recovery when switching videos in scrolling feeds.
- Improved video sizing during scrolling and fullscreen transitions.
- Reduced shader preparation overhead and GPU resource churn.
- Expanded automated coverage for playback cadence, feed switching, layout and GPU output correctness.

Performance depends on the browser, GPU and video. Some startup stutter can still occur, especially in Firefox.
