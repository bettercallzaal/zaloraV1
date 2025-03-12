import { elizaLogger } from "@elizaos/core";
import { AudioPlayer, AudioResource, createAudioPlayer, createAudioResource, NoSubscriberBehavior } from "@discordjs/voice";
import ytdl from "ytdl-core";
import spotify from "spotify-url-info";
import { Stream } from "stream";

export interface SongMetadata {
  title: string;
  artist: string;
  url: string;
  thumbnail?: string;
  duration?: string;
  album?: string;
  year?: string;
  platform: string;
}

export interface QueueItem {
  metadata: SongMetadata;
  resource?: AudioResource;
}

export class MusicProcessor {
  private queue: QueueItem[] = [];
  private currentPlaying: QueueItem | null = null;
  private player: AudioPlayer;
  private isPlaying: boolean = false;

  constructor() {
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    // Handle song end
    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status === 'idle' && oldState.status !== 'idle') {
        this.playNext();
      }
    });
  }

  /**
   * Parse a URL and extract metadata
   */
  async parseUrl(url: string): Promise<SongMetadata | null> {
    try {
      // YouTube URL
      if (url.includes('youtube.com') || url.includes('youtu.be')) {
        return await this.parseYouTubeUrl(url);
      }
      
      // Spotify URL
      if (url.includes('spotify.com')) {
        return await this.parseSpotifyUrl(url);
      }

      // SoundCloud URL (basic implementation)
      if (url.includes('soundcloud.com')) {
        return {
          title: "SoundCloud Track", // Will be updated with actual metadata
          artist: "Unknown Artist",
          url: url,
          platform: "soundcloud"
        };
      }

      return null;
    } catch (error) {
      elizaLogger.error('Error parsing URL:', error);
      return null;
    }
  }

  /**
   * Parse YouTube URL and extract metadata
   */
  private async parseYouTubeUrl(url: string): Promise<SongMetadata> {
    try {
      const info = await ytdl.getInfo(url);
      const videoDetails = info.videoDetails;
      
      return {
        title: videoDetails.title,
        artist: videoDetails.author.name,
        url: url,
        thumbnail: videoDetails.thumbnails[0]?.url,
        duration: this.formatDuration(parseInt(videoDetails.lengthSeconds)),
        platform: "youtube"
      };
    } catch (error) {
      elizaLogger.error('Error parsing YouTube URL:', error);
      throw error;
    }
  }

  /**
   * Parse Spotify URL and extract metadata
   */
  private async parseSpotifyUrl(url: string): Promise<SongMetadata> {
    try {
      const data = await spotify.getData(url);
      
      return {
        title: data.name,
        artist: data.artists?.map((artist: any) => artist.name).join(', ') || 'Unknown Artist',
        url: url,
        thumbnail: data.coverArt?.sources?.[0]?.url,
        album: data.album?.name,
        year: data.releaseDate ? new Date(data.releaseDate).getFullYear().toString() : undefined,
        duration: data.duration ? this.formatDuration(Math.floor(data.duration / 1000)) : undefined,
        platform: "spotify"
      };
    } catch (error) {
      elizaLogger.error('Error parsing Spotify URL:', error);
      throw error;
    }
  }

  /**
   * Format duration in seconds to MM:SS format
   */
  private formatDuration(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  /**
   * Add a song to the queue
   */
  async addToQueue(url: string): Promise<QueueItem | null> {
    try {
      const metadata = await this.parseUrl(url);
      if (!metadata) {
        return null;
      }

      const queueItem: QueueItem = { metadata };
      this.queue.push(queueItem);

      // If not playing, start playback
      if (!this.isPlaying) {
        this.playNext();
      }

      return queueItem;
    } catch (error) {
      elizaLogger.error('Error adding to queue:', error);
      return null;
    }
  }

  /**
   * Play the next song in the queue
   */
  async playNext(): Promise<QueueItem | null> {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.currentPlaying = null;
      return null;
    }

    this.isPlaying = true;
    const nextSong = this.queue.shift()!;
    this.currentPlaying = nextSong;

    try {
      // Create audio resource based on platform
      if (nextSong.metadata.platform === 'youtube') {
        const stream = ytdl(nextSong.metadata.url, { 
          filter: 'audioonly',
          quality: 'highestaudio',
          highWaterMark: 1 << 25 // 32MB buffer
        });
        
        nextSong.resource = createAudioResource(stream, {
          inlineVolume: true,
        });
        
        if (nextSong.resource.volume) {
          nextSong.resource.volume.setVolume(0.5);
        }
        
        this.player.play(nextSong.resource);
      } 
      // Add support for other platforms here
      
      return nextSong;
    } catch (error) {
      elizaLogger.error('Error playing next song:', error);
      // Try to play the next song if this one fails
      return this.playNext();
    }
  }

  /**
   * Skip the current song
   */
  skip(): QueueItem | null {
    this.player.stop();
    return this.currentPlaying;
  }

  /**
   * Pause playback
   */
  pause(): boolean {
    return this.player.pause();
  }

  /**
   * Resume playback
   */
  resume(): boolean {
    return this.player.unpause();
  }

  /**
   * Stop playback and clear the queue
   */
  stop(): void {
    this.queue = [];
    this.player.stop();
    this.isPlaying = false;
    this.currentPlaying = null;
  }

  /**
   * Get the current queue
   */
  getQueue(): QueueItem[] {
    return [
      ...(this.currentPlaying ? [this.currentPlaying] : []),
      ...this.queue
    ];
  }

  /**
   * Get the audio player
   */
  getPlayer(): AudioPlayer {
    return this.player;
  }

  /**
   * Get the currently playing song
   */
  getCurrentSong(): QueueItem | null {
    return this.currentPlaying;
  }
}
