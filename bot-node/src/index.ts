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
  Attachment,
} from "discord.js";
import dotenv from "dotenv";
import { OpusEncoder } from "@discordjs/opus";
import prism from "prism-media";
import { Readable } from "stream";

// --- Types ---

type SoundMapping = {
  keywords: string[];
  file: string;
  volume?: number; // percent (0-200)
};

type AppConfig = {
  mappings: SoundMapping[];
  cooldownMs: number;
  lang?: string;
  wsPort?: number; // legacy
};

type EnvConfig = {
  token: string;
  appId: string;
  guildId: string;
};

type ResolvedMapping = SoundMapping & {
  filePath: string;
  volume: number; // float (0.0 - 2.0)
};

// --- Logger ---

const log = (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => {
  const timestamp = new Date().toISOString();
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  // eslint-disable-next-line no-console
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}`);
};

// --- Paths & State ---

// Root of the repo (assuming bot-node/src/../..)
const rootDir = path.resolve(__dirname, "..", "..");
const rootConfigPath = path.resolve(rootDir, "config.json");
const soundsDir = path.resolve(__dirname, "..", "sounds");

// Ensure sounds directory exists
if (!fs.existsSync(soundsDir)) {
  fs.mkdirSync(soundsDir, { recursive: true });
}

let appConfig: AppConfig;
let resolvedMappings: ResolvedMapping[] = [];

// --- Config Management ---

const readJsonFile = <T>(filePath: string): T => {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
};

const writeJsonFile = (filePath: string, data: any) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
};

const reloadConfig = () => {
  try {
    if (!fs.existsSync(rootConfigPath)) {
      throw new Error(`config.json not found at ${rootConfigPath}`);
    }
    const parsed = readJsonFile<AppConfig>(rootConfigPath);

    // Validate
    if (!parsed.mappings) parsed.mappings = [];

    appConfig = parsed;

    // Resolve Mappings
    resolvedMappings = appConfig.mappings.map((m) => {
      // Volume: Config (Percent) -> Logic (Float)
      // Default to 100% if missing
      const volPercent = m.volume ?? 100;
      const volFloat = Math.max(0, volPercent / 100);

      const file = m.file || "";
      // If absolute or starts with ./ ../, use as is. Otherwise join with soundsDir.
      const filePath =
        path.isAbsolute(file) || file.startsWith("./") || file.startsWith("../")
          ? file
          : path.join(soundsDir, file);

      return {
        ...m,
        volume: volFloat,
        filePath,
      };
    });

    log("info", "Config loaded", { mappings: resolvedMappings.length });
  } catch (e: any) {
    log("error", "Failed to load config", { error: e.message });
    // Initialize empty if failed, to prevent crash
    appConfig = { mappings: [], cooldownMs: 3000, lang: "ja-JP" };
    resolvedMappings = [];
  }
};

const saveConfig = () => {
  try {
    writeJsonFile(rootConfigPath, appConfig);
    reloadConfig();
  } catch (e: any) {
    log("error", "Failed to save config", { error: e.message });
  }
};

// --- Env ---

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

const env = resolveEnv();

// Initial Load
reloadConfig();

// --- Helpers ---

const normalizeKeyword = (keyword: string) => keyword.toLowerCase();

const validateKeywords = (newKeywords: string[], ignoreMapping?: SoundMapping): string | null => {
  for (const newKw of newKeywords) {
    const nKw = normalizeKeyword(newKw);
    for (const mapping of appConfig.mappings) {
      if (mapping === ignoreMapping) continue;
      for (const existingKw of mapping.keywords) {
        const eKw = normalizeKeyword(existingKw);
        if (nKw === eKw) return `Keyword "${newKw}" is already used.`;
        if (nKw.includes(eKw)) return `Keyword "${newKw}" contains existing keyword "${existingKw}".`;
        if (eKw.includes(nKw)) return `Existing keyword "${existingKw}" contains new keyword "${newKw}".`;
      }
    }
  }
  return null;
};

const getMappingForText = (text: string): ResolvedMapping | null => {
  if (!text) return null;
  const normalized = normalizeKeyword(text);
  // Find mapping where ANY of its keywords are contained in the text
  const mapping = resolvedMappings.find((m) =>
    m.keywords.some((kw) => normalized.includes(normalizeKeyword(kw)))
  );
  return mapping ?? null;
};

// --- Google Speech API ---

// --- Google Speech API (Streaming) ---

async function resolveSpeechStreamWithGoogle(
  audioStream: Readable,
  lang: string = "ja-JP",
  onResult: (text: string) => void
) {
  const key = "AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw"; // Using existing key
  const profanityFilter = "1";
  // The v2 API supports full duplex streaming if we pipe properly, 
  // but here we just stream the upload and read the response stream.
  const url = `https://www.google.com/speech-api/v2/recognize?output=json&lang=${lang}&key=${key}&pFilter=${profanityFilter}`;

  try {
    const response = await axios.post(url, audioStream, {
      headers: {
        "Content-Type": "audio/l16; rate=16000;",
      },
      responseType: "stream",
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const stream = response.data as Readable;
    let buffer = "";

    stream.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          // Check for result
          if (json.result && json.result.length > 0) {
            const res = json.result[0];
            if (res.alternative && res.alternative.length > 0) {
              const transcript = res.alternative[0].transcript;
              if (transcript) {
                onResult(transcript);
              }
            }
          }
        } catch (e) {
          // ignore parsing/json errors
        }
      }
    });

    return new Promise<void>((resolve) => {
      stream.on("end", () => resolve());
      stream.on("error", () => resolve());
    });
  } catch (e: any) {
    if (e.message !== "socket hang up" && e.code !== "ECONNRESET") {
      log("error", "Google Speech API error", { msg: e.message });
    }
  }
}

// Watch for config changes
if (fs.existsSync(rootConfigPath)) {
  fs.watch(rootConfigPath, (eventType) => {
    if (eventType === "change") {
      log("info", "Config file changed, reloading...");
      // Debounce slightly to avoid read during write
      setTimeout(() => reloadConfig(), 100);
    }
  });
}

// --- Discord Client ---

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

// --- Slash Commands ---

const commands = [
  new SlashCommandBuilder().setName("join").setDescription("Join the voice channel"),
  new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel"),
  new SlashCommandBuilder().setName("testplay").setDescription("Test playback"),
  new SlashCommandBuilder()
    .setName("sound")
    .setDescription("Manage Soundboard")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a new sound mapping")
        .addStringOption((opt) =>
          opt.setName("keyword").setDescription("Keywords (comma separated)").setRequired(true)
        )
        .addAttachmentOption((opt) =>
          opt.setName("file").setDescription("Audio file (mp3/wav)").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("volume")
            .setDescription("Volume Percentage (0-200, default 100)")
            .setMinValue(0)
            .setMaxValue(200)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a sound mapping")
        .addStringOption((opt) =>
          opt.setName("keyword").setDescription("A keyword of the sound to remove").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Edit an existing sound mapping")
        .addStringOption((opt) =>
          opt.setName("target_keyword").setDescription("The keyword to find the sound").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("new_keywords").setDescription("New keywords (comma separated)")
        )
        .addAttachmentOption((opt) =>
          opt.setName("new_file").setDescription("New audio file")
        )
        .addIntegerOption((opt) =>
          opt
            .setName("new_volume")
            .setDescription("New Volume Percentage (0-200)")
            .setMinValue(0)
            .setMaxValue(200)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List all registered sounds")
    ),
].map((command) => command.toJSON());

const registerCommands = async () => {
  const rest = new REST({ version: "10" }).setToken(env.token);
  await rest.put(Routes.applicationGuildCommands(env.appId, env.guildId), { body: commands });
  log("info", "Slash commands registered");
};

// --- Playback Logic ---

const startPlaybackIfIdle = () => {
  if (audioPlayer.state.status !== AudioPlayerStatus.Idle) return;
  const next = playbackQueue.shift();
  if (!next) return;

  const resource = createAudioResource(next.filePath, { inlineVolume: true });
  if (resource.volume) {
    resource.volume.setVolume(next.volume);
  }
  audioPlayer.play(resource);
};

audioPlayer.on(AudioPlayerStatus.Idle, startPlaybackIfIdle);

const enqueuePlayback = (filePath: string, volume: number) => {
  if (!fs.existsSync(filePath)) {
    log("warn", "File not found", { filePath });
    return;
  }
  playbackQueue.push({ filePath, volume });
  startPlaybackIfIdle();
};

// --- Voice Recognition ---

const handleUserSpeaking = (userId: string, connection: VoiceConnection) => {
  const receiver = connection.receiver;
  const opusStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 300,
    },
  });

  opusStream.on("error", (e) => {
    // log("warn", "Opus stream error", { error: e.message });
  });

  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  decoder.on("error", (e) => {
    // log("warn", "Opus decoder error", { error: e.message });
  });

  const transcoder = new prism.FFmpeg({
    args: [
      "-analyzeduration", "0",
      "-loglevel", "0",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-i", "-",
      "-f", "s16le",
      "-ar", "16000",
      "-ac", "1",
    ],
  });
  transcoder.on("error", (e) => {
    // log("warn", "FFmpeg transcoder error", { error: e.message });
  });

  const stream = opusStream.pipe(decoder).pipe(transcoder);

  // Stream directly to Google
  resolveSpeechStreamWithGoogle(stream, appConfig.lang || "ja-JP", (text) => {
    log("info", "Recognized", { text, userId });

    const now = Date.now();
    const lastHit = userCooldowns.get(userId) || 0;

    if (now - lastHit < appConfig.cooldownMs) {
      log("info", "Cooldown active", { userId });
      return;
    }

    const mapping = getMappingForText(text);
    if (mapping) {
      // Update cooldown immediately to prevent double triggering on final result
      userCooldowns.set(userId, now);
      log("info", "Hit!", {
        keyword: mapping.keywords,
        file: mapping.file,
        volume: mapping.volume,
        currText: text,
      });
      enqueuePlayback(mapping.filePath, mapping.volume);
    }
  });

  stream.on("error", (e) => {
    // log("warn", "Pipeline error", { error: e.message });
  });
};

const subscribeReceiver = (connection: VoiceConnection) => {
  connection.receiver.speaking.on("start", (userId) => {
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
  subscribeReceiver(connection);

  await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  return connection;
};

// --- Interaction Handler ---

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const { commandName } = interaction;

    if (commandName === "join") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = interaction.member as GuildMember;
      if (member.voice.channel) {
        await ensureVoiceConnection(member.voice.channel);
        await interaction.editReply({ content: "Listening!" });
      } else {
        await interaction.editReply({ content: "Join VC first" });
      }
    } else if (commandName === "leave") {
      voiceConnection?.destroy();
      voiceConnection = null;
      await interaction.reply({ content: "Left.", flags: MessageFlags.Ephemeral });
    } else if (commandName === "testplay") {
      if (resolvedMappings[0]) {
        enqueuePlayback(resolvedMappings[0].filePath, resolvedMappings[0].volume);
        await interaction.reply({ content: "Playing first sound...", flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: "No sounds configured.", flags: MessageFlags.Ephemeral });
      }
    } else if (commandName === "sound") {
      const sub = interaction.options.getSubcommand();

      if (sub === "add") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const keywordInput = interaction.options.getString("keyword", true);
        const attachment = interaction.options.getAttachment("file", true);
        const volume = interaction.options.getInteger("volume") ?? 100;

        const keywords = keywordInput.split(",").map((k) => k.trim()).filter((k) => k.length > 0);

        if (keywords.length === 0) {
          await interaction.editReply("Invalid keywords.");
          return;
        }

        const validationError = validateKeywords(keywords);
        if (validationError) {
          await interaction.editReply(`Error: ${validationError}`);
          return;
        }

        // Validate attachment
        if (!attachment.contentType?.startsWith("audio/")) {
          await interaction.editReply("File must be an audio type.");
          return;
        }

        const fileName = attachment.name;
        // Check if file already exists? Or overwrite? 
        // User said "Modify easily", overwriting with same name is probably expected.
        // We will prepend timestamp or something if we wanted uniqueness, but keeping simple for now.
        const savePath = path.join(soundsDir, fileName);

        // Download
        try {
          const response = await axios.get(attachment.url, { responseType: "arraybuffer" });
          fs.writeFileSync(savePath, response.data);
        } catch (e: any) {
          await interaction.editReply(`Failed to download file: ${e.message}`);
          return;
        }

        // Update Config
        appConfig.mappings.push({
          keywords: keywords,
          file: fileName,
          volume: volume
        });
        saveConfig();

        await interaction.editReply({ content: `Added sound!\n**Keywords**: ${keywords.join(", ")}\n**File**: ${fileName}\n**Volume**: ${volume}%` });

      } else if (sub === "edit") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targetKeyword = interaction.options.getString("target_keyword", true);

        // Find mapping
        const mapping = appConfig.mappings.find(m => m.keywords.includes(targetKeyword));

        if (!mapping) {
          await interaction.editReply(`No sound found with keyword "${targetKeyword}".`);
          return;
        }

        const newKeywordsInput = interaction.options.getString("new_keywords");
        const newFile = interaction.options.getAttachment("new_file");
        const newVolume = interaction.options.getInteger("new_volume");

        let changes = [];

        if (newKeywordsInput) {
          const newKeywords = newKeywordsInput.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
          if (newKeywords.length === 0) {
            await interaction.editReply("Invalid new keywords.");
            return;
          }

          const err = validateKeywords(newKeywords, mapping);
          if (err) {
            await interaction.editReply(`Error: ${err}`);
            return;
          }

          mapping.keywords = newKeywords;
          changes.push(`Keywords updated: ${newKeywords.join(", ")}`);
        }

        if (newVolume !== null) {
          mapping.volume = newVolume;
          changes.push(`Volume updated: ${newVolume}%`);
        }

        if (newFile) {
          if (!newFile.contentType?.startsWith("audio/")) {
            await interaction.editReply("New file must be an audio type.");
            return;
          }

          const fileName = newFile.name;
          const savePath = path.join(soundsDir, fileName);

          try {
            const response = await axios.get(newFile.url, { responseType: "arraybuffer" });
            fs.writeFileSync(savePath, response.data);
            mapping.file = fileName;
            changes.push(`File updated: ${fileName}`);
          } catch (e: any) {
            await interaction.editReply(`Failed to download file: ${e.message}`);
            return;
          }
        }

        if (changes.length === 0) {
          await interaction.editReply("No changes specified.");
          return;
        }

        saveConfig();
        await interaction.editReply(`Updated sound!\n${changes.join("\n")}`);

      } else if (sub === "remove") {
        const keyword = interaction.options.getString("keyword", true);
        const initialCount = appConfig.mappings.length;

        // Remove any mapping that contains this keyword in its keywords list
        // OR exact match? Let's do: if the mapping's keyword LIST contains the target keyword.
        const newMappings = appConfig.mappings.filter(m => !m.keywords.includes(keyword));

        if (newMappings.length === initialCount) {
          await interaction.reply({ content: `No sound found with keyword "${keyword}".`, flags: MessageFlags.Ephemeral });
        } else {
          appConfig.mappings = newMappings;
          saveConfig();
          await interaction.reply({ content: `Removed ${initialCount - newMappings.length} sound(s).`, flags: MessageFlags.Ephemeral });
        }

      } else if (sub === "list") {
        let msg = "**Registered Sounds**:\n";
        appConfig.mappings.forEach((m, i) => {
          msg += `**${i + 1}.** ${m.keywords.join(", ")} -> ${m.file} (${m.volume ?? 100}%)\n`;
        });

        if (appConfig.mappings.length === 0) msg += "None.";

        if (msg.length > 1900) msg = msg.substring(0, 1900) + "... (truncated)";

        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
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

// --- Start ---

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
