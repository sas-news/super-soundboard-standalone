import fs from "fs";
import path from "path";
import axios from "axios";
import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  EndBehaviorType,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import {
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  GuildMember,
  REST,
  Routes,
  SlashCommandBuilder,
  VoiceBasedChannel,
  MessageFlags,
} from "discord.js";
import dotenv from "dotenv";
import { OpusEncoder } from "@discordjs/opus";
// Note: prism-media will fallback to opusscript if we rely on its decoder, 
// but here we might want to ensure we use prism's abstraction. 
import prism from "prism-media";

type SoundMapping = {
  keywords: string[];
  file: string;
  volume?: number;
};

type AppConfig = {
  mappings: SoundMapping[];
  cooldownMs: number;
  lang?: string;
};

type EnvConfig = {
  token: string;
  appId: string;
  guildId: string;
};

type ResolvedMapping = SoundMapping & {
  filePath: string;
  volume: number;
};

const log = (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => {
  const timestamp = new Date().toISOString();
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  // eslint-disable-next-line no-console
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}`);
};

const rootConfigPath = path.resolve(__dirname, "..", "..", "config.json");
const sharedConfigPath = path.resolve(__dirname, "..", "..", "shared", "config.json");
const legacyConfigPath = path.resolve(__dirname, "..", "config.json");

const readJsonFile = <T>(filePath: string): T => {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
};

const clampVolume = (raw?: number): number => {
  const vol = typeof raw === "number" ? raw : 1;
  return Math.min(Math.max(vol, 0), 2);
};

const resolveEnv = (): EnvConfig => {
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
  const read = (key: string) => {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing environment variable: ${key}`);
    }
    return value;
  };

  return {
    token: read("DISCORD_TOKEN"),
    appId: read("DISCORD_APP_ID"),
    guildId: read("GUILD_ID"),
  };
};

const resolveAppConfig = (): AppConfig => {
  const configPath =
    [rootConfigPath, sharedConfigPath, legacyConfigPath].find((p) => fs.existsSync(p)) || rootConfigPath;
  if (!fs.existsSync(configPath)) {
    throw new Error("config.json not found. Place it at repository root.");
  }
  const parsed = readJsonFile<AppConfig>(configPath);
  if (!Array.isArray(parsed.mappings) || parsed.mappings.length === 0) {
    throw new Error("config: mappings must be a non-empty array");
  }

  const normalizedMappings = parsed.mappings.map((m) => {
    const file = m.file || "";
    const withDir =
      path.isAbsolute(file) || file.startsWith("./") || file.startsWith("../") ? file : path.join("sounds", file);
    return { ...m, file: withDir, volume: clampVolume(m.volume) };
  });
  return {
    ...parsed,
    mappings: normalizedMappings,
  };
};

const appConfig = resolveAppConfig();
const env = resolveEnv();

const normalizeKeyword = (keyword: string) => keyword.toLowerCase();

const resolvedMappings: ResolvedMapping[] = appConfig.mappings.map((m) => ({
  ...m,
  volume: clampVolume(m.volume),
  filePath: path.isAbsolute(m.file) ? m.file : path.resolve(__dirname, "..", m.file),
}));

const getMappingForText = (text: string): ResolvedMapping | null => {
  if (!text) return null;
  const normalized = normalizeKeyword(text);
  const mapping = resolvedMappings.find((m) => m.keywords.some((kw) => normalized.includes(normalizeKeyword(kw))));
  return mapping ?? null;
};

// --- Custom Speech Service ---

async function resolveSpeechWithGoogle(buffer: Buffer, lang: string = "en-US") {
  // Extracted Key
  const key = "AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw";
  const profanityFilter = "1";
  // Modified to use 16000Hz
  const url = `https://www.google.com/speech-api/v2/recognize?output=json&lang=${lang}&key=${key}&pFilter=${profanityFilter}`;

  try {
    const response = await axios.post(url, buffer, {
      headers: {
        "Content-Type": "audio/l16; rate=16000;"
      },
      transformResponse: [
        (data: string) => {
          if (!data) return {};
          const fixedData = data.replace('{"result":[]}', "").trim();
          if (!fixedData) return {};
          try {
            const lines = fixedData.split('\n');
            for (const line of lines) {
              if (line.trim().length === 0) continue;
              const json = JSON.parse(line);
              if (json.result && json.result.length > 0) return json;
            }
            return JSON.parse(fixedData);
          } catch (e) {
            return {};
          }
        }
      ]
    });

    if (response.data && response.data.result && response.data.result[0]) {
      return response.data.result[0].alternative[0].transcript;
    }
  } catch (e: any) {
    // log("error", "Google Speech API error", { msg: e.message });
  }
  return null;
}

// --- End Custom Speech Service ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

const audioPlayer: AudioPlayer = createAudioPlayer();
const playbackQueue: { filePath: string; volume: number }[] = [];
let voiceConnection: VoiceConnection | null = null;
const userCooldowns = new Map<string, number>();

const commands = [
  new SlashCommandBuilder().setName("join").setDescription("Join the voice channel"),
  new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel"),
  new SlashCommandBuilder().setName("testplay").setDescription("Test playback"),
].map((command) => command.toJSON());

const registerCommands = async () => {
  const rest = new REST({ version: "10" }).setToken(env.token);
  await rest.put(Routes.applicationGuildCommands(env.appId, env.guildId), { body: commands });
  log("info", "Slash commands registered");
};

const startPlaybackIfIdle = () => {
  if (audioPlayer.state.status !== AudioPlayerStatus.Idle) return;
  const next = playbackQueue.shift();
  if (!next) return;
  const resource = createAudioResource(next.filePath, { inlineVolume: true });
  if (resource.volume) resource.volume.setVolume(next.volume);
  audioPlayer.play(resource);
};

audioPlayer.on(AudioPlayerStatus.Idle, startPlaybackIfIdle);

const enqueuePlayback = (filePath: string, volume: number) => {
  if (!fs.existsSync(filePath)) return;
  playbackQueue.push({ filePath, volume });
  startPlaybackIfIdle();
};

const handleUserSpeaking = (userId: string, connection: VoiceConnection) => {
  const receiver = connection.receiver;
  const opusStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 300,
    },
  });

  // 1. Decode Opus to PCM (48kHz, Stereo)
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  decoder.on('error', (e) => log("warn", "Decoder error", { error: e.message }));

  // 2. Transcode PCM to Mono 16kHz for Google Speech API
  const transcoder = new prism.FFmpeg({
    args: [
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', '-',
      '-f', 's16le',
      '-ar', '16000',
      '-ac', '1',
    ],
  });
  transcoder.on('error', (e) => log("warn", "Transcoder error", { error: e.message }));

  const bufferData: Buffer[] = [];

  // Pipeline: Opus -> Decoder -> Transcoder -> Buffer
  const stream = opusStream.pipe(decoder).pipe(transcoder);

  stream.on('data', (chunk: Buffer) => {
    bufferData.push(chunk);
  });

  stream.on('error', (err) => {
    log("warn", "Stream pipeline error", { msg: err.message });
  });

  stream.on('end', async () => {
    const buffer = Buffer.concat(bufferData);
    if (buffer.length < 2000) return; // ~0.06s of 16k mono audio (32000 bytes/sec)

    log("info", "Audio captured", { length: buffer.length, userId });

    try {
      // Send 16000Hz audio
      const text = await resolveSpeechWithGoogle(buffer, appConfig.lang || "ja-JP");
      if (text) {
        log("info", "Recognized", { text, userId });

        const now = Date.now();
        const lastHit = userCooldowns.get(userId) || 0;

        if (now - lastHit < appConfig.cooldownMs) {
          log("info", "Cooldown active", { userId });
          return;
        }

        const mapping = getMappingForText(text);
        if (mapping) {
          userCooldowns.set(userId, now);
          log("info", "Hit!", { keyword: mapping.keywords, userId });
          enqueuePlayback(mapping.filePath, mapping.volume);
        }
      }
    } catch (e) {
      log("error", "Speech processing failed", { error: String(e) });
    }
  });
};

const subscribeReceiver = (connection: VoiceConnection) => {
  connection.receiver.speaking.on('start', (userId) => {
    handleUserSpeaking(userId, connection);
  });
};

const ensureVoiceConnection = async (channel: VoiceBasedChannel) => {
  if (!channel) throw new Error("Voice channel required");

  if (voiceConnection && voiceConnection.joinConfig.channelId === channel.id) {
    return voiceConnection;
  }
  if (voiceConnection) voiceConnection.destroy();

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  voiceConnection = connection;
  connection.subscribe(audioPlayer);
  subscribeReceiver(connection); // Attach listener

  await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  return connection;
};

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "join") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = interaction.member as GuildMember;
      if (member.voice.channel) {
        await ensureVoiceConnection(member.voice.channel);
        await interaction.editReply({ content: "Listening!" });
      } else {
        await interaction.editReply({ content: "Join VC first" });
      }
    } else if (interaction.commandName === "leave") {
      voiceConnection?.destroy();
      voiceConnection = null;
      await interaction.reply({ content: "Left.", flags: MessageFlags.Ephemeral });
    } else if (interaction.commandName === "testplay") {
      if (resolvedMappings[0]) {
        enqueuePlayback(resolvedMappings[0].filePath, resolvedMappings[0].volume);
        await interaction.reply({ content: "Playing...", flags: MessageFlags.Ephemeral });
      }
    }
  } catch (error: any) {
    log("error", "Command error", { error: error.message });
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
      } else {
        await interaction.followUp({ content: "An error occurred.", flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      // ignore
    }
  }
});

const bootstrap = async () => {
  const shouldRegisterOnly = process.argv.includes("--register");
  if (shouldRegisterOnly) {
    await registerCommands();
    process.exit(0);
  }
  await registerCommands();
  await client.login(env.token);
  log("info", "Started.");
};

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled Rejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  log("error", "Uncaught Exception", { error: error.message, stack: error.stack });
});

bootstrap();
