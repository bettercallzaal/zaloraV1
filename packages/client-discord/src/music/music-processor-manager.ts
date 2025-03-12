import { elizaLogger } from "@elizaos/core";
import { MusicProcessor } from "./music-processor";

/**
 * Manages MusicProcessor instances for different guilds
 */
export class MusicProcessorManager {
  private processors: Map<string, MusicProcessor> = new Map();

  /**
   * Get a music processor for a specific guild
   */
  getProcessor(guildId: string): MusicProcessor | undefined {
    return this.processors.get(guildId);
  }

  /**
   * Set a music processor for a specific guild
   */
  setProcessor(guildId: string, processor: MusicProcessor): void {
    this.processors.set(guildId, processor);
  }

  /**
   * Check if a guild has a music processor
   */
  hasProcessor(guildId: string): boolean {
    return this.processors.has(guildId);
  }

  /**
   * Remove a music processor for a specific guild
   */
  removeProcessor(guildId: string): boolean {
    return this.processors.delete(guildId);
  }

  /**
   * Get all guild IDs with active music processors
   */
  getActiveGuildIds(): string[] {
    return Array.from(this.processors.keys());
  }

  /**
   * Stop all music processors and clear them
   */
  stopAll(): void {
    for (const processor of this.processors.values()) {
      try {
        processor.stop();
      } catch (error) {
        elizaLogger.error("Error stopping music processor:", error);
      }
    }
    this.processors.clear();
  }
}
