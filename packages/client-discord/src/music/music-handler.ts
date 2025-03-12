import { elizaLogger } from "@elizaos/core";
import { Message, MessageReaction, TextChannel, User, MessageCreateOptions } from "discord.js";
import { MusicProcessor, QueueItem } from "./music-processor";
import { VoiceManager } from "../voice";
import { DiscordClient } from "..";
import { BaseGuildVoiceChannel } from "discord.js";

// URL regex patterns
const URL_PATTERNS = {
  YOUTUBE: /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/,
  SPOTIFY: /(?:https?:\/\/)?(?:open\.)?spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/,
  SOUNDCLOUD: /(?:https?:\/\/)?(?:www\.)?soundcloud\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)/
};

export class MusicHandler {
  private client: DiscordClient;
  private voiceManager: VoiceManager;
  private musicProcessor: MusicProcessor;
  private guildMusicProcessors: Map<string, MusicProcessor> = new Map();

  constructor(client: DiscordClient, voiceManager: VoiceManager) {
    this.client = client;
    this.voiceManager = voiceManager;
    this.musicProcessor = new MusicProcessor();
  }

  /**
   * Process a message for music links
   */
  async processMessage(message: Message): Promise<boolean> {
    if (message.author.bot) return false;
    
    const content = message.content;
    const musicUrl = this.extractMusicUrl(content);
    
    if (!musicUrl) return false;
    
    try {
      // Get or create a music processor for this guild
      const guildId = message.guild?.id;
      if (!guildId) return false;
      
      let processor = this.guildMusicProcessors.get(guildId);
      if (!processor) {
        processor = new MusicProcessor();
        this.guildMusicProcessors.set(guildId, processor);
      }
      
      // Parse the URL and get metadata
      const metadata = await processor.parseUrl(musicUrl);
      if (!metadata) {
        await message.reply("I couldn't process that music link. Please try a different one.");
        return false;
      }
      
      // Check if bot is in a voice channel
      const connections = this.voiceManager.getConnections();
      const connection = connections.get(guildId);
      if (!connection) {
        // Ask if user wants bot to join their voice channel
        const reply = await message.reply({
          content: `I found a ${metadata.platform} track: **${metadata.title}** by **${metadata.artist}**. Would you like me to join your voice channel and play it?`
        });
        
        await reply.react('✅');
        await reply.react('❌');
        
        // Create a filter to only accept reactions from the original message author
        const filter = (reaction: MessageReaction, user: User) => 
          ['✅', '❌'].includes(reaction.emoji.name || '') && user.id === message.author.id;
          
        try {
          const collected = await reply.awaitReactions({ filter, max: 1, time: 30000, errors: ['time'] });
          const reaction = collected.first();
          
          if (reaction?.emoji.name === '✅') {
            // Join the user's voice channel
            const member = message.member;
            if (!member?.voice.channel) {
              await message.reply("You need to be in a voice channel for me to join.");
              return false;
            }
            
            await this.voiceManager.joinChannel(member.voice.channel);
            
            // Add the song to the queue
            const queueItem = await processor.addToQueue(musicUrl);
            if (!queueItem) {
              await message.reply("I had trouble adding that song to the queue.");
              return false;
            }
            
            // Subscribe the connection to the audio player
            const connections = this.voiceManager.getConnections();
            const connection = connections.get(guildId);
            connection?.subscribe(processor.getPlayer());
            
            await message.reply(`Now playing: **${queueItem.metadata.title}** by **${queueItem.metadata.artist}**`);
            return true;
          } else {
            await message.reply("Okay, I won't play that music.");
            return false;
          }
        } catch (error) {
          await message.reply("No response received. If you'd like me to play music, please try again.");
          return false;
        }
      } else {
        // Bot is already in a voice channel, add song to queue
        const queueItem = await processor.addToQueue(musicUrl);
        if (!queueItem) {
          await message.reply("I had trouble adding that song to the queue.");
          return false;
        }
        
        // Subscribe the connection to the audio player if not already
        connection.subscribe(processor.getPlayer());
        
        const currentSong = processor.getCurrentSong();
        if (currentSong?.metadata.url === queueItem.metadata.url) {
          await message.reply(`Now playing: **${queueItem.metadata.title}** by **${queueItem.metadata.artist}**`);
        } else {
          await message.reply(`Added to queue: **${queueItem.metadata.title}** by **${queueItem.metadata.artist}**`);
        }
        
        return true;
      }
    } catch (error) {
      elizaLogger.error('Error processing music message:', error);
      await message.reply("I encountered an error while processing your music request.");
      return false;
    }
  }

  /**
   * Process a command related to music playback
   */
  async processCommand(message: Message): Promise<boolean> {
    if (message.author.bot) return false;
    
    const content = message.content.toLowerCase();
    const guildId = message.guild?.id;
    if (!guildId) return false;
    
    const processor = this.guildMusicProcessors.get(guildId);
    if (!processor) return false;
    
    // Check if the bot is in a voice channel
    const connections = this.voiceManager.getConnections();
    const connection = connections.get(guildId);
    if (!connection) return false;
    
    try {
      // Skip command
      if (content.includes('skip') || content.includes('next')) {
        const skipped = processor.skip();
        if (skipped) {
          await message.reply(`Skipped: **${skipped.metadata.title}**`);
          
          const current = processor.getCurrentSong();
          if (current) {
            await message.reply(`Now playing: **${current.metadata.title}** by **${current.metadata.artist}**`);
          }
        } else {
          await message.reply("No song to skip.");
        }
        return true;
      }
      
      // Pause command
      if (content.includes('pause')) {
        const paused = processor.pause();
        if (paused) {
          await message.reply("Playback paused.");
        } else {
          await message.reply("Nothing is playing or already paused.");
        }
        return true;
      }
      
      // Resume command
      if (content.includes('resume') || content.includes('play')) {
        const resumed = processor.resume();
        if (resumed) {
          await message.reply("Playback resumed.");
        } else {
          await message.reply("Nothing is paused or already playing.");
        }
        return true;
      }
      
      // Stop command
      if (content.includes('stop')) {
        processor.stop();
        await message.reply("Playback stopped and queue cleared.");
        return true;
      }
      
      // Queue command
      if (content.includes('queue') || content.includes('list')) {
        const queue = processor.getQueue();
        if (queue.length === 0) {
          await message.reply("The queue is empty.");
          return true;
        }
        
        let queueMessage = "🎵 **Current Queue** 🎵\n";
        queue.forEach((item, index) => {
          if (index === 0) {
            queueMessage += `**Now Playing:** ${item.metadata.title} by ${item.metadata.artist}\n`;
          } else {
            queueMessage += `${index}. ${item.metadata.title} by ${item.metadata.artist}\n`;
          }
        });
        
        await message.reply(queueMessage);
        return true;
      }
      
      // Leave command
      if (content.includes('leave') || content.includes('disconnect')) {
        processor.stop();
        const guild = message.guild;
        if (guild) {
          // Get the channel the bot is currently in
          const connections = this.voiceManager.getConnections();
          const connection = connections.get(guild.id);
          if (connection) {
            await this.voiceManager.leaveGuild(guild.id);
            await message.reply("Left the voice channel.");
            return true;
          }
        }
      }
    } catch (error) {
      elizaLogger.error('Error processing music command:', error);
      await message.reply("I encountered an error while processing your command.");
      return false;
    }
    
    return false;
  }

  /**
   * Extract a music URL from a message
   */
  private extractMusicUrl(content: string): string | null {
    // Check for YouTube URLs
    const youtubeMatch = content.match(URL_PATTERNS.YOUTUBE);
    if (youtubeMatch) {
      const videoId = youtubeMatch[1];
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    
    // Check for Spotify URLs
    const spotifyMatch = content.match(URL_PATTERNS.SPOTIFY);
    if (spotifyMatch) {
      return content.match(URL_PATTERNS.SPOTIFY)?.[0] || null;
    }
    
    // Check for SoundCloud URLs
    const soundcloudMatch = content.match(URL_PATTERNS.SOUNDCLOUD);
    if (soundcloudMatch) {
      return content.match(URL_PATTERNS.SOUNDCLOUD)?.[0] || null;
    }
    
    return null;
  }
}
