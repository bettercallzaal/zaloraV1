import { elizaLogger, type IAgentRuntime, type ActionExample, type Handler, type Validator } from "@elizaos/core";
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
  similes: [
    "play a song",
    "play music",
    "add song to queue",
    "stream music"
  ],
  
  examples: [
    [
      {
        user: "user123",
        content: { text: "Can you play some music for me?" }
      },
      {
        user: "assistant",
        content: { text: "I'd be happy to play some music for you! Could you share a link to the song you'd like to hear?" }
      },
      {
        user: "user123",
        content: { text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
      },
      {
        user: "assistant",
        content: { text: "I'll play 'Rick Astley - Never Gonna Give You Up' for you now!" }
      }
    ]
  ],
  
  validate: (async (args: any) => {
    const typedArgs = args as PlayMusicArgs;
    if (!typedArgs.guildId) {
      return { valid: false, error: "Guild ID is required" };
    }
    if (!typedArgs.url) {
      return { valid: false, error: "URL is required" };
    }
    return { valid: true };
  }) as unknown as Validator,
  
  handler: (async (args: any, runtime: IAgentRuntime) => {
    const typedArgs = args as PlayMusicArgs;
    const { guildId, url } = typedArgs;
    try {
      
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
  }) as unknown as Handler
};
