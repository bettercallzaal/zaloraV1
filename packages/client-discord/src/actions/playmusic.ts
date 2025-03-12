import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import { AudioPlayerStatus } from "@discordjs/voice";
import { DiscordClient } from "..";
import { MusicProcessor } from "../music/music-processor";

interface PlayMusicArgs {
  guildId: string;
  url: string;
}

/**
 * Action to play music in a voice channel
 */
export default {
  name: "playmusic",
  description: "Play music from a URL in a voice channel",
  platforms: ["discord"],

  execute: async (args: PlayMusicArgs, runtime: IAgentRuntime) => {
    try {
      const { guildId, url } = args;
      
      // Get the Discord client
      const discordClient = runtime.clients["discord"] as DiscordClient;
      
      if (!discordClient) {
        elizaLogger.error("Discord client not found");
        return {
          success: false,
          error: "Discord client not found",
        };
      }
      
      // Check if the bot is in a voice channel
      const voiceManager = discordClient.getVoiceManager();
      const connections = voiceManager.getConnections();
      const connection = connections.get(guildId);
      
      if (!connection) {
        return {
          success: false,
          error: "Bot is not in a voice channel. Use joinvoice action first.",
        };
      }
      
      // Get or create the music processor for this guild
      const musicProcessorManager = discordClient.getMusicProcessorManager();
      let processor = musicProcessorManager.getProcessor(guildId);
      
      if (!processor) {
        processor = new MusicProcessor();
        musicProcessorManager.setProcessor(guildId, processor);
      }
      
      // Add the song to the queue
      const queueItem = await processor.addToQueue(url);
      
      if (!queueItem) {
        return {
          success: false,
          error: "Failed to add song to queue",
        };
      }
      
      // Subscribe the connection to the audio player
      connection.subscribe(processor.getPlayer());
      
      // Check if this is the currently playing song or in queue
      const currentSong = processor.getCurrentSong();
      const isPlaying = currentSong?.metadata.url === queueItem.metadata.url;
      
      return {
        success: true,
        data: {
          title: queueItem.metadata.title,
          artist: queueItem.metadata.artist,
          url: queueItem.metadata.url,
          isPlaying,
          platform: queueItem.metadata.platform,
        },
      };
    } catch (error) {
      elizaLogger.error("Error in playmusic action:", error);
      return {
        success: false,
        error: `Failed to play music: ${error}`,
      };
    }
  },
};


