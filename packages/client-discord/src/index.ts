import {
    getEmbeddingZeroVector,
    stringToUuid,
    elizaLogger,
    type Character,
    type Client as ElizaClient,
    type IAgentRuntime,
} from "@elizaos/core";
import {
    Client,
    Events,
    GatewayIntentBits,
    type Guild,
    type MessageReaction,
    Partials,
    type User,
} from "discord.js";
import { EventEmitter } from "events";
import chat_with_attachments from "./actions/chat_with_attachments.ts";
import download_media from "./actions/download_media.ts";
import joinvoice from "./actions/joinvoice.ts";
import leavevoice from "./actions/leavevoice.ts";
import playmusic from "./actions/playmusic.ts";
import summarize from "./actions/summarize_conversation.ts";
import transcribe_media from "./actions/transcribe_media.ts";
import { MessageManager } from "./messages.ts";
import { MusicHandler } from "./music/music-handler.ts";
import { MusicProcessorManager } from "./music/music-processor-manager.ts";
import channelStateProvider from "./providers/channelState.ts";
import voiceStateProvider from "./providers/voiceState.ts";
import { VoiceManager } from "./voice.ts";
import { PermissionsBitField } from "discord.js";

export class DiscordClient extends EventEmitter {
    apiToken: string;
    client: Client;
    runtime: IAgentRuntime;
    character: Character;
    private messageManager: MessageManager;
    private voiceManager: VoiceManager;
    private musicHandler: MusicHandler;
    private musicProcessorManager: MusicProcessorManager;

    constructor(runtime: IAgentRuntime) {
        super();

        this.apiToken = runtime.getSetting("DISCORD_API_TOKEN") as string;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.DirectMessageTyping,
                GatewayIntentBits.GuildMessageTyping,
                GatewayIntentBits.GuildMessageReactions,
            ],
            partials: [
                Partials.Channel,
                Partials.Message,
                Partials.User,
                Partials.Reaction,
            ],
        });

        this.runtime = runtime;
        this.voiceManager = new VoiceManager(this);
        this.musicProcessorManager = new MusicProcessorManager();
        this.musicHandler = new MusicHandler(this, this.voiceManager);
        this.messageManager = new MessageManager(this, this.voiceManager);

        this.client.once(Events.ClientReady, this.onClientReady.bind(this));
        this.client.login(this.apiToken);

        this.setupEventListeners();

        this.runtime.registerAction(joinvoice);
        this.runtime.registerAction(leavevoice);
        // TODO: Fix playmusic action to match Action interface
        // this.runtime.registerAction(playmusic);
        this.runtime.registerAction(summarize);
        this.runtime.registerAction(chat_with_attachments);
        this.runtime.registerAction(transcribe_media);
        this.runtime.registerAction(download_media);

        this.runtime.providers.push(channelStateProvider);
        this.runtime.providers.push(voiceStateProvider);
    }

    private setupEventListeners() {
        // When joining to a new server
        this.client.on("guildCreate", this.handleGuildCreate.bind(this));

        this.client.on(
            Events.MessageReactionAdd,
            this.handleReactionAdd.bind(this)
        );
        this.client.on(
            Events.MessageReactionRemove,
            this.handleReactionRemove.bind(this)
        );

        // Handle voice events with the voice manager
        this.client.on(
            "voiceStateUpdate",
            this.voiceManager.handleVoiceStateUpdate.bind(this.voiceManager)
        );
        this.client.on(
            "userStream",
            this.voiceManager.handleUserStream.bind(this.voiceManager)
        );

        // Handle a new message with the message manager
        this.client.on(Events.MessageCreate, async (message) => {
            // First check if it's a music-related message
            const isMusicMessage = await this.musicHandler.processMessage(message);
            const isMusicCommand = await this.musicHandler.processCommand(message);
            
            // If it's not music-related, pass it to the message manager
            if (!isMusicMessage && !isMusicCommand) {
                await this.messageManager.handleMessage(message);
            }
        });

        // Handle a new interaction
        this.client.on(Events.InteractionCreate, async (interaction) => {
            // Handle music-related slash commands
            if (interaction.isCommand()) {
                const { commandName } = interaction;
                
                if (commandName === 'play' && interaction.options) {
                    await interaction.deferReply();
                    const url = interaction.options?.get('url')?.value as string;
                    if (!url) {
                        await interaction.editReply('Please provide a valid URL.');
                        return;
                    }
                    
                    // Check if bot is in a voice channel
                    const guildId = interaction.guildId;
                    if (!guildId) {
                        await interaction.editReply('This command can only be used in a server.');
                        return;
                    }
                    
                    const connections = this.voiceManager.getConnections();
                    const connection = connections.get(guildId);
                    
                    if (!connection) {
                        await interaction.editReply('I need to be in a voice channel first. Use /joinchannel to invite me.');
                        return;
                    }
                    
                    // Get or create a music processor for this guild
                    let processor = this.musicProcessorManager.getProcessor(guildId);
                    if (!processor) {
                        const { MusicProcessor } = await import('./music/music-processor');
                        processor = new MusicProcessor();
                        this.musicProcessorManager.setProcessor(guildId, processor);
                    }
                    
                    try {
                        const queueItem = await processor.addToQueue(url);
                        if (!queueItem) {
                            await interaction.editReply('I had trouble processing that music link.');
                            return;
                        }
                        
                        connection.subscribe(processor.getPlayer());
                        
                        await interaction.editReply(`Added to queue: **${queueItem.metadata.title}** by **${queueItem.metadata.artist}**`);
                    } catch (error) {
                        elizaLogger.error('Error playing music:', error);
                        await interaction.editReply('An error occurred while trying to play that music.');
                    }
                } else if (commandName === 'skip') {
                    await interaction.deferReply();
                    const guildId = interaction.guildId;
                    if (!guildId) {
                        await interaction.editReply('This command can only be used in a server.');
                        return;
                    }
                    
                    const processor = this.musicProcessorManager.getProcessor(guildId);
                    if (!processor) {
                        await interaction.editReply('No music is currently playing.');
                        return;
                    }
                    
                    const skipped = processor.skip();
                    if (skipped) {
                        await interaction.editReply(`Skipped: **${skipped.metadata.title}**`);
                    } else {
                        await interaction.editReply('No song to skip.');
                    }
                } else if (commandName === 'pause') {
                    await interaction.deferReply();
                    const guildId = interaction.guildId;
                    if (!guildId) {
                        await interaction.editReply('This command can only be used in a server.');
                        return;
                    }
                    
                    const processor = this.musicProcessorManager.getProcessor(guildId);
                    if (!processor) {
                        await interaction.editReply('No music is currently playing.');
                        return;
                    }
                    
                    const paused = processor.pause();
                    if (paused) {
                        await interaction.editReply('Playback paused.');
                    } else {
                        await interaction.editReply('Nothing is playing or already paused.');
                    }
                } else if (commandName === 'resume') {
                    await interaction.deferReply();
                    const guildId = interaction.guildId;
                    if (!guildId) {
                        await interaction.editReply('This command can only be used in a server.');
                        return;
                    }
                    
                    const processor = this.musicProcessorManager.getProcessor(guildId);
                    if (!processor) {
                        await interaction.editReply('No music is currently playing.');
                        return;
                    }
                    
                    const resumed = processor.resume();
                    if (resumed) {
                        await interaction.editReply('Playback resumed.');
                    } else {
                        await interaction.editReply('Nothing is paused or already playing.');
                    }
                } else if (commandName === 'stop') {
                    await interaction.deferReply();
                    const guildId = interaction.guildId;
                    if (!guildId) {
                        await interaction.editReply('This command can only be used in a server.');
                        return;
                    }
                    
                    const processor = this.musicProcessorManager.getProcessor(guildId);
                    if (!processor) {
                        await interaction.editReply('No music is currently playing.');
                        return;
                    }
                    
                    processor.stop();
                    await interaction.editReply('Playback stopped and queue cleared.');
                } else if (commandName === 'queue') {
                    await interaction.deferReply();
                    const guildId = interaction.guildId;
                    if (!guildId) {
                        await interaction.editReply('This command can only be used in a server.');
                        return;
                    }
                    
                    const processor = this.musicProcessorManager.getProcessor(guildId);
                    if (!processor) {
                        await interaction.editReply('No music is currently playing.');
                        return;
                    }
                    
                    const queue = processor.getQueue();
                    if (queue.length === 0) {
                        await interaction.editReply('The queue is empty.');
                        return;
                    }
                    
                    let queueMessage = '🎵 **Current Queue** 🎵\n';
                    queue.forEach((item, index) => {
                        if (index === 0) {
                            queueMessage += `**Now Playing:** ${item.metadata.title} by ${item.metadata.artist}\n`;
                        } else {
                            queueMessage += `${index}. ${item.metadata.title} by ${item.metadata.artist}\n`;
                        }
                    });
                    
                    await interaction.editReply(queueMessage);
                } else {
                    // Handle other commands with the original method
                    this.handleInteractionCreate(interaction);
                }
            } else {
                // Handle other interactions with the original method
                this.handleInteractionCreate(interaction);
            }
        });
    }

    async stop() {
        try {
            // Stop all music processors
            this.musicProcessorManager.stopAll();
            
            // disconnect websocket
            // this unbinds all the listeners
            await this.client.destroy();
        } catch (e) {
            elizaLogger.error("client-discord instance stop err", e);
        }
    }
    
    /**
     * Get the voice manager
     */
    getVoiceManager(): VoiceManager {
        return this.voiceManager;
    }
    
    /**
     * Get the music processor manager
     */
    getMusicProcessorManager(): MusicProcessorManager {
        return this.musicProcessorManager;
    }
    
    /**
     * Get the music handler
     */
    getMusicHandler(): MusicHandler {
        return this.musicHandler;
    }

    private async onClientReady(readyClient: { user: { tag: any; id: any } }) {
        elizaLogger.success(`Logged in as ${readyClient.user?.tag}`);

        // Register slash commands
        const commands = [
            {
                name: "joinchannel",
                description: "Join a voice channel",
                options: [
                    {
                        name: "channel",
                        type: 7, // CHANNEL type
                        description: "The voice channel to join",
                        required: true,
                        channel_types: [2], // GuildVoice type
                    },
                ],
            },
            {
                name: "leavechannel",
                description: "Leave the current voice channel",
            },
            {
                name: "play",
                description: "Play music from a URL",
                options: [
                    {
                        name: "url",
                        type: 3, // STRING type
                        description: "The URL of the music to play",
                        required: true,
                    },
                ],
            },
            {
                name: "skip",
                description: "Skip the current song",
            },
            {
                name: "pause",
                description: "Pause the current song",
            },
            {
                name: "resume",
                description: "Resume playback",
            },
            {
                name: "stop",
                description: "Stop playback and clear the queue",
            },
            {
                name: "queue",
                description: "Show the current music queue",
            },
        ];

        try {
            await this.client.application?.commands.set(commands);
            elizaLogger.success("Slash commands registered");
        } catch (error) {
            console.error("Error registering slash commands:", error);
        }

        // Required permissions for the bot
        const requiredPermissions = [
            // Text Permissions
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.SendMessagesInThreads,
            PermissionsBitField.Flags.CreatePrivateThreads,
            PermissionsBitField.Flags.CreatePublicThreads,
            PermissionsBitField.Flags.EmbedLinks,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.AddReactions,
            PermissionsBitField.Flags.UseExternalEmojis,
            PermissionsBitField.Flags.UseExternalStickers,
            PermissionsBitField.Flags.MentionEveryone,
            PermissionsBitField.Flags.ManageMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            // Voice Permissions
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.UseVAD,
            PermissionsBitField.Flags.PrioritySpeaker,
        ].reduce((a, b) => a | b, 0n);

        elizaLogger.success("Use this URL to add the bot to your server:");
        elizaLogger.success(
            `https://discord.com/api/oauth2/authorize?client_id=${readyClient.user?.id}&permissions=${requiredPermissions}&scope=bot%20applications.commands`
        );
        await this.onReady();
    }

    async handleReactionAdd(reaction: MessageReaction, user: User) {
        try {
            elizaLogger.log("Reaction added");

            // Early returns
            if (!reaction || !user) {
                elizaLogger.warn("Invalid reaction or user");
                return;
            }

            // Get emoji info
            let emoji = reaction.emoji.name;
            if (!emoji && reaction.emoji.id) {
                emoji = `<:${reaction.emoji.name}:${reaction.emoji.id}>`;
            }

            // Fetch full message if partial
            if (reaction.partial) {
                try {
                    await reaction.fetch();
                } catch (error) {
                    elizaLogger.error(
                        "Failed to fetch partial reaction:",
                        error
                    );
                    return;
                }
            }

            // Generate IDs with timestamp to ensure uniqueness
            const timestamp = Date.now();
            const roomId = stringToUuid(
                `${reaction.message.channel.id}-${this.runtime.agentId}`
            );
            const userIdUUID = stringToUuid(
                `${user.id}-${this.runtime.agentId}`
            );
            const reactionUUID = stringToUuid(
                `${reaction.message.id}-${user.id}-${emoji}-${timestamp}-${this.runtime.agentId}`
            );

            // Validate IDs
            if (!userIdUUID || !roomId) {
                elizaLogger.error("Invalid user ID or room ID", {
                    userIdUUID,
                    roomId,
                });
                return;
            }

            // Process message content
            const messageContent = reaction.message.content || "";
            const truncatedContent =
                messageContent.length > 100
                    ? `${messageContent.substring(0, 100)}...`
                    : messageContent;
            const reactionMessage = `*<${emoji}>: "${truncatedContent}"*`;

            // Get user info
            const userName = reaction.message.author?.username || "unknown";
            const name = reaction.message.author?.displayName || userName;

            // Ensure connection
            await this.runtime.ensureConnection(
                userIdUUID,
                roomId,
                userName,
                name,
                "discord"
            );

            // Create memory with retry logic
            const memory = {
                id: reactionUUID,
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                content: {
                    text: reactionMessage,
                    source: "discord",
                    inReplyTo: stringToUuid(
                        `${reaction.message.id}-${this.runtime.agentId}`
                    ),
                },
                roomId,
                createdAt: timestamp,
                embedding: getEmbeddingZeroVector(),
            };

            try {
                await this.runtime.messageManager.createMemory(memory);
                elizaLogger.debug("Reaction memory created", {
                    reactionId: reactionUUID,
                    emoji,
                    userId: user.id,
                });
            } catch (error) {
                if (error.code === "23505") {
                    // Duplicate key error
                    elizaLogger.warn("Duplicate reaction memory, skipping", {
                        reactionId: reactionUUID,
                    });
                    return;
                }
                throw error; // Re-throw other errors
            }
        } catch (error) {
            elizaLogger.error("Error handling reaction:", error);
        }
    }

    async handleReactionRemove(reaction: MessageReaction, user: User) {
        elizaLogger.log("Reaction removed");
        // if (user.bot) return;

        let emoji = reaction.emoji.name;
        if (!emoji && reaction.emoji.id) {
            emoji = `<:${reaction.emoji.name}:${reaction.emoji.id}>`;
        }

        // Fetch the full message if it's a partial
        if (reaction.partial) {
            try {
                await reaction.fetch();
            } catch (error) {
                console.error(
                    "Something went wrong when fetching the message:",
                    error
                );
                return;
            }
        }

        const messageContent = reaction.message.content;
        const truncatedContent =
            messageContent.length > 50
                ? messageContent.substring(0, 50) + "..."
                : messageContent;

        const reactionMessage = `*Removed <${emoji} emoji> from: "${truncatedContent}"*`;

        const roomId = stringToUuid(
            reaction.message.channel.id + "-" + this.runtime.agentId
        );
        const userIdUUID = stringToUuid(user.id);

        // Generate a unique UUID for the reaction removal
        const reactionUUID = stringToUuid(
            `${reaction.message.id}-${user.id}-${emoji}-removed-${this.runtime.agentId}`
        );

        const userName = reaction.message.author.username;
        const name = reaction.message.author.displayName;

        await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            userName,
            name,
            "discord"
        );

        try {
            // Save the reaction removal as a message
            await this.runtime.messageManager.createMemory({
                id: reactionUUID, // This is the ID of the reaction removal message
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                content: {
                    text: reactionMessage,
                    source: "discord",
                    inReplyTo: stringToUuid(
                        reaction.message.id + "-" + this.runtime.agentId
                    ), // This is the ID of the original message
                },
                roomId,
                createdAt: Date.now(),
                embedding: getEmbeddingZeroVector(),
            });
        } catch (error) {
            console.error("Error creating reaction removal message:", error);
        }
    }

    private handleGuildCreate(guild: Guild) {
        console.log(`Joined guild ${guild.name}`);
        this.voiceManager.scanGuild(guild);
    }

    private async handleInteractionCreate(interaction: any) {
        if (!interaction.isCommand()) return;

        switch (interaction.commandName) {
            case "joinchannel":
                await this.voiceManager.handleJoinChannelCommand(interaction);
                break;
            case "leavechannel":
                await this.voiceManager.handleLeaveChannelCommand(interaction);
                break;
        }
    }

    private async onReady() {
        const guilds = await this.client.guilds.fetch();
        for (const [, guild] of guilds) {
            const fullGuild = await guild.fetch();
            this.voiceManager.scanGuild(fullGuild);
        }
    }
}

export function startDiscord(runtime: IAgentRuntime) {
    return new DiscordClient(runtime);
}

export const DiscordClientInterface: ElizaClient = {
    start: async (runtime: IAgentRuntime) => new DiscordClient(runtime),
    stop: async (runtime: IAgentRuntime) => {
        try {
            // stop it
            elizaLogger.log("Stopping discord client", runtime.agentId);
            await runtime.clients.discord.stop();
        } catch (e) {
            elizaLogger.error("client-discord interface stop error", e);
        }
    },
};
