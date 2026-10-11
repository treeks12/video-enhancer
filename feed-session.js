/* Feed-aware media session coordinator.
 *
 * A social feed may reuse one <video> node for many sources or replace the
 * node while an old rVFC/inference promise is still in flight.  This tiny
 * coordinator gives every source a monotonic identity and retires the old
 * identity atomically.  Renderers can keep their expensive compiled model,
 * while frame pairs and async results remain owned by one session only.
 */
(function (root) {
  "use strict";

  function now() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now() : Date.now();
  }

  function sourceKey(video) {
    if (!video) return "none";
    const source = String(video.currentSrc || video.src || "");
    const width = Number(video.videoWidth) || 0;
    const height = Number(video.videoHeight) || 0;
    // Duration changes frequently while MSE feeds append segments; it is not
    // part of source identity. loadedmetadata/emptied use force=true for a
    // same-URL replay or replacement.
    return `${source}|${width}x${height}`;
  }

  class FeedSession {
    constructor(id, video, key) {
      this.id = id;
      this.video = video;
      this.key = key;
      this.createdAt = now();
      this.retiredAt = 0;
      this.active = true;
      this.reason = "";
    }

    retire(reason = "source changed") {
      this.active = false;
      this.reason = reason;
      this.retiredAt = now();
    }
  }

  class FeedSessionManager {
    constructor() {
      this.nextId = 0;
      this.active = null;
      this.retired = [];
    }

    ensure(video, { force = false, reason = "source changed" } = {}) {
      if (!video) return null;
      const key = sourceKey(video);
      if (!force && this.active && this.active.active &&
          this.active.video === video && this.active.key === key) {
        return this.active;
      }
      if (this.active?.active) {
        this.active.retire(reason);
        this.retired.push(this.active);
      }
      const session = new FeedSession(++this.nextId, video, key);
      this.active = session;
      // Keep a short history for diagnostics, while preventing a long-lived
      // feed from retaining every old DOM video object.
      if (this.retired.length > 8) this.retired.splice(0, this.retired.length - 8);
      return session;
    }

    isCurrent(session, video = session?.video) {
      return Boolean(session && session.active && this.active === session &&
        session.video === video);
    }

    retire(reason = "no active video") {
      if (this.active?.active) {
        this.active.retire(reason);
        this.retired.push(this.active);
      }
      this.active = null;
    }

    snapshot() {
      return this.active ? {
        id: this.active.id,
        key: this.active.key,
        active: this.active.active,
        ageMs: Math.max(0, now() - this.active.createdAt),
      } : null;
    }
  }

  root.VEFeedSessionManager = FeedSessionManager;
  root.VEFeedSourceKey = sourceKey;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { FeedSessionManager, sourceKey };
  }
})(globalThis);
