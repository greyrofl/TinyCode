import type { Provider } from "./provider/types.js";
import type { HardwareMemoryStatus, LocalRuntime, ParallelStatus } from "./runtime.js";

/** Lifecycle adapter for user-owned OpenAI-compatible servers. */
export class PassiveRuntime implements LocalRuntime {
  constructor(private readonly provider: Provider) {}
  async available(): Promise<boolean> { return (await this.provider.health()).ok; }
  async ensureStarted(): Promise<boolean> {
    const health = await this.provider.health();
    if (!health.ok) throw new Error(health.error ?? `${this.provider.name} is unavailable.`);
    return false;
  }
  async parallelStatus(): Promise<ParallelStatus> { return { value: null, source: "user-owned external provider", local: false, canSet: false }; }
  async memoryStatus(): Promise<HardwareMemoryStatus | null> { return null; }
  async waitForMemoryRelease(): Promise<void> {}
  async restartServer(): Promise<void> { throw new Error(`${this.provider.name} is user-owned and cannot be restarted by TinyCode.`); }
  async setParallelOne(): Promise<ParallelStatus> { throw new Error(`${this.provider.name} parallel settings are user-managed.`); }
}
