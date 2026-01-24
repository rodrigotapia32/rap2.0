/**
 * Singleton AudioContext manager
 * Provides a shared AudioContext across all components, handles unlock lifecycle
 * for mobile browsers that require user gesture to start audio.
 */

type UnlockedCallback = () => void;

class AudioContextManager {
  private context: AudioContext | null = null;
  private unlocked = false;
  private callbacks: UnlockedCallback[] = [];

  /**
   * Get or create the shared AudioContext
   */
  getContext(): AudioContext {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.context = new AudioContextClass();
    }
    return this.context;
  }

  /**
   * Whether the AudioContext is in 'running' state
   */
  isUnlocked(): boolean {
    return this.unlocked && !!this.context && this.isRunning(this.context);
  }

  /**
   * MUST be called from a user click/touch handler.
   * Resumes the AudioContext and plays a silent buffer (Safari workaround).
   */
  async unlockFromGesture(): Promise<boolean> {
    const ctx = this.getContext();

    if (this.isRunning(ctx)) {
      this.markUnlocked();
      return true;
    }

    try {
      await ctx.resume();
    } catch {
      // resume failed, try silent buffer trick below
    }

    // Safari silent-buffer trick for stubborn suspended contexts
    if (!this.isRunning(ctx)) {
      try {
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
        source.stop(0.001);
        // Give Safari a tick to process
        await new Promise(resolve => setTimeout(resolve, 50));
        await ctx.resume();
      } catch {
        // final attempt failed
      }
    }

    if (this.isRunning(ctx)) {
      this.markUnlocked();
      return true;
    }

    return false;
  }

  /**
   * Best-effort resume without requiring a gesture.
   * Returns true if context is running after attempt.
   */
  async tryResume(): Promise<boolean> {
    if (!this.context) return false;

    if (this.isRunning(this.context)) {
      this.markUnlocked();
      return true;
    }

    try {
      await this.context.resume();
      if (this.isRunning(this.context)) {
        this.markUnlocked();
        return true;
      }
    } catch {
      // Cannot resume outside gesture context
    }

    return false;
  }

  /**
   * Register a callback to be invoked when the AudioContext starts running.
   * If already unlocked, the callback fires immediately.
   */
  onUnlocked(cb: UnlockedCallback): () => void {
    if (this.unlocked && this.context && this.isRunning(this.context)) {
      cb();
    } else {
      this.callbacks.push(cb);
    }

    // Return unsubscribe function
    return () => {
      const idx = this.callbacks.indexOf(cb);
      if (idx !== -1) this.callbacks.splice(idx, 1);
    };
  }

  /**
   * Tear down the AudioContext (for cleanup on unmount of root component)
   */
  destroy() {
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
    }
    this.unlocked = false;
    this.callbacks = [];
  }

  /**
   * Check if AudioContext is running (avoids TS control flow narrowing issues)
   */
  private isRunning(ctx: AudioContext): boolean {
    return (ctx.state as string) === 'running';
  }

  private markUnlocked() {
    if (this.unlocked) return;
    this.unlocked = true;
    const cbs = [...this.callbacks];
    this.callbacks = [];
    for (const cb of cbs) {
      try { cb(); } catch { /* consumer error */ }
    }
  }
}

// Singleton instance
export const audioContextManager = new AudioContextManager();
