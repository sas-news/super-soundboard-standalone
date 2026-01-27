import fs from "fs";
import path from "path";
import axios from "axios";
import crypto from "crypto";
import ffmpeg from "fluent-ffmpeg";
import whisperNode from "whisper-node";
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
  EmbedBuilder,
  AutocompleteInteraction,
} from "discord.js";
import dotenv from "dotenv";
import { OpusEncoder } from "@discordjs/opus";
import prism from "prism-media";
import { Readable } from "stream";
import { createApiServer } from "./api";

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
  guildId?: string;
  whisperModel?: string;
  whisperModelPath?: string;
};

type ResolvedMapping = SoundMapping & {
  filePath: string;
  volume: number; // float (0.0 - 2.0)
};

// --- Logger ---

const log = (
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) => {
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

// --- Audio Conversion Helpers ---

const generateRandomFilename = (): string => {
  return crypto.randomBytes(16).toString("hex") + ".wav";
};

const convertToWav48k = (
  inputPath: string,
  outputPath: string,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFrequency(48000)
      .audioChannels(2)
      .format("wav")
      .on("end", () => {
        // Clean up temporary input file
        if (fs.existsSync(inputPath)) {
          fs.unlinkSync(inputPath);
        }
        resolve();
      })
      .on("error", (err: Error) => {
        // Clean up temporary input file on error
        if (fs.existsSync(inputPath)) {
          fs.unlinkSync(inputPath);
        }
        reject(
          new Error(`Failed to convert audio to WAV 48kHz: ${err.message}`),
        );
      })
      .save(outputPath);
  });
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

    // Sort mappings by longest keyword (descending)
    // This ensures longer keywords are matched first
    parsed.mappings.sort((a, b) => {
      const maxLenA = Math.max(...a.keywords.map((k) => k.length));
      const maxLenB = Math.max(...b.keywords.map((k) => k.length));
      return maxLenB - maxLenA; // Descending order (longer first)
    });

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
    guildId: process.env["GUILD_ID"],
    whisperModel: process.env["WHISPER_MODEL"],
    whisperModelPath: process.env["WHISPER_MODEL_PATH"],
  };
};

const env = resolveEnv();

// Initial Load
reloadConfig();

// --- Helpers ---

const normalizeKeyword = (keyword: string) => keyword.toLowerCase();

const validateKeywords = (
  newKeywords: string[],
  ignoreMapping?: SoundMapping,
): string | null => {
  for (const newKw of newKeywords) {
    const nKw = normalizeKeyword(newKw);
    for (const mapping of appConfig.mappings) {
      if (mapping === ignoreMapping) continue;
      for (const existingKw of mapping.keywords) {
        const eKw = normalizeKeyword(existingKw);
        // Only check for exact duplicates
        // Substring relationships are now allowed since we sort by keyword length
        if (nKw === eKw) return `Keyword "${newKw}" is already used.`;
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
    m.keywords.some((kw) => normalized.includes(normalizeKeyword(kw))),
  );
  return mapping ?? null;
};

// --- Whisper.cpp Speech Recognition (whisper-node) ---

// Global whisper instance (initialized once)
let whisperInstance: any = null;

// Convert language codes from ja-JP format to ja format for Whisper
function convertLangCodeForWhisper(lang: string): string {
  if (lang.includes("-")) {
    return lang.split("-")[0];
  }
  return lang;
}

// Initialize whisper once at startup
async function initializeWhisper() {
  if (whisperInstance) return whisperInstance;

  const modelName = env.whisperModel || "base";
  const modelPath = env.whisperModelPath;

  try {
    log("info", "Initializing whisper-node...", { model: modelName });

    const defaultOptions: any = {
      modelName: modelName,
      whisperOptions: {
        language: "auto", // Will be overridden per-transcription
        gen_file_txt: false,
        gen_file_subtitle: false,
        gen_file_vtt: true, // request VTT output so parsing works
        word_timestamps: false,
      },
    };

    if (modelPath) {
      defaultOptions.modelPath = modelPath;
    }

    // whisper-node exports a function: whisper(filePath, options)
    // Provide a small wrapper with a `transcribe` method to match existing code expectations
    // Add defensive handling: return an empty array on errors or unexpected outputs
    whisperInstance = {
      transcribe: async (filePath: string, opts: any = {}) => {
        const mergedOptions = {
          ...defaultOptions,
          ...opts,
          whisperOptions: {
            ...(defaultOptions.whisperOptions || {}),
            ...(opts.whisperOptions || {}),
          },
        };

        try {
          const result = await whisperNode(filePath, mergedOptions);

          // If the module returned undefined/null or not an array, normalize to []
          if (!result || !Array.isArray(result)) {
            log(
              "warn",
              "Whisper returned unexpected result; normalizing to empty array",
              { type: typeof result },
            );
            return [];
          }

          return result;
        } catch (err: any) {
          log("error", "Whisper transcribe failed", {
            msg: err?.message || String(err),
          });
          return [];
        }
      },
    };

    log("info", "Whisper initialized successfully");
    return whisperInstance;
  } catch (e: any) {
    log("error", "Failed to initialize Whisper", { msg: e.message });
    throw e;
  }
}

async function resolveSpeechStreamWithWhisper(
  audioStream: Readable,
  lang: string = "ja",
  onResult: (text: string) => void,
) {
  try {
    // Ensure whisper is initialized
    const whisper = await initializeWhisper();

    // Collect audio stream into a temporary file
    const tempDir = path.resolve(__dirname, "..", "temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFileName = `audio_${Date.now()}_${Math.random().toString(36).substring(7)}.wav`;
    const tempFilePath = path.join(tempDir, tempFileName);

    // Collect all audio data
    const chunks: Buffer[] = [];
    audioStream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    await new Promise<void>((resolve) => {
      audioStream.on("end", () => resolve());
    });

    const audioBuffer = Buffer.concat(chunks);

    // Write WAV header + PCM data
    const sampleRate = 16000;
    const bitsPerSample = 16;
    const channels = 1;
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const dataSize = audioBuffer.length;

    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(36 + dataSize, 4);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(channels, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(byteRate, 28);
    wavHeader.writeUInt16LE(blockAlign, 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);
    wavHeader.write("data", 36);
    wavHeader.writeUInt32LE(dataSize, 40);

    fs.writeFileSync(tempFilePath, Buffer.concat([wavHeader, audioBuffer]));

    // Transcribe
    const language = convertLangCodeForWhisper(lang);
    // Allow enabling verbose whisper output by setting WHISPER_DEBUG=1 in env
    const shellOptions = { silent: process.env.WHISPER_DEBUG ? false : true };

    const transcript = await whisper.transcribe(tempFilePath, {
      whisperOptions: { language },
      shellOptions,
    });

    // Clean up temp file
    try {
      fs.unlinkSync(tempFilePath);
    } catch (e) {
      // Ignore cleanup errors
    }

    // Defensive: ensure we got an array back
    if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
      log("warn", "Whisper returned no transcription segments");
      log(
        "info",
        "If this persists, ensure a whisper model is installed (run 'npx whisper-node download' in bot-node) and set WHISPER_DEBUG=1 to view raw whisper output for debugging.",
      );
      return;
    }

    // Process result
    if (transcript && transcript.length > 0) {
      const fullText = transcript
        .map((segment: any) => segment.speech?.trim() || "")
        .filter((text: string) => text.length > 0)
        .join(" ");

      if (fullText) {
        onResult(fullText);
      }
    }
  } catch (e: any) {
    log("error", "Whisper transcription error", { msg: e.message });
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
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("ボイスチャンネルに参加"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("ボイスチャンネルから退出"),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("キーワードで効果音を再生")
    .addStringOption((opt) =>
      opt
        .setName("keyword")
        .setDescription("再生する効果音のキーワード")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("config.json の内容を表示"),
  new SlashCommandBuilder().setName("help").setDescription("ヘルプを表示"),
  new SlashCommandBuilder()
    .setName("sound")
    .setDescription("効果音を管理")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("新しい効果音を登録")
        .addStringOption((opt) =>
          opt
            .setName("keyword")
            .setDescription("キーワード（カンマ区切りで複数可）")
            .setRequired(true),
        )
        .addAttachmentOption((opt) =>
          opt
            .setName("file")
            .setDescription("音声ファイル（mp3/wav）")
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("volume")
            .setDescription("音量（0-200%、デフォルト100）")
            .setMinValue(0)
            .setMaxValue(200),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("効果音を削除")
        .addStringOption((opt) =>
          opt
            .setName("keyword")
            .setDescription("削除する効果音のキーワード")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("効果音の設定を編集")
        .addStringOption((opt) =>
          opt
            .setName("target_keyword")
            .setDescription("編集対象のキーワード")
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("new_keywords")
            .setDescription("新しいキーワード（カンマ区切りで複数可）"),
        )
        .addAttachmentOption((opt) =>
          opt.setName("new_file").setDescription("新しい音声ファイル"),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("new_volume")
            .setDescription("新しい音量（0-200%）")
            .setMinValue(0)
            .setMaxValue(200),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("登録済みの効果音一覧"),
    ),
].map((command) => command.toJSON());

const registerCommands = async () => {
  const rest = new REST({ version: "10" }).setToken(env.token);

  if (env.guildId) {
    await rest.put(Routes.applicationGuildCommands(env.appId, env.guildId), {
      body: commands,
    });
    log("info", `Slash commands registered (Guild: ${env.guildId})`);
  } else {
    await rest.put(Routes.applicationCommands(env.appId), { body: commands });
    log("info", "Slash commands registered (Global)");
  }
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

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
  decoder.on("error", (e) => {
    // log("warn", "Opus decoder error", { error: e.message });
  });

  const transcoder = new prism.FFmpeg({
    args: [
      "-analyzeduration",
      "0",
      "-loglevel",
      "0",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      "-",
      "-f",
      "s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
    ],
  });
  transcoder.on("error", (e) => {
    // log("warn", "FFmpeg transcoder error", { error: e.message });
  });

  const stream = opusStream.pipe(decoder).pipe(transcoder);

  // Stream directly to Faster-Whisper
  const whisperLang = convertLangCodeForWhisper(appConfig.lang || "ja");
  resolveSpeechStreamWithWhisper(stream, whisperLang, (text) => {
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
    adapterCreator: channel.guild
      .voiceAdapterCreator as DiscordGatewayAdapterCreator,
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
  // --- Autocomplete Handling ---
  if (interaction.isAutocomplete()) {
    const focusedOption = interaction.options.getFocused(true);
    if (
      focusedOption.name === "target_keyword" ||
      focusedOption.name === "keyword"
    ) {
      // Covers /sound edit, /sound remove, and /play
      const focusedValue = focusedOption.value.toLowerCase();
      // Collect all keywords from all mappings
      const allKeywords = appConfig.mappings.flatMap((m) => m.keywords);
      // Filter
      const filtered = allKeywords.filter((kw) =>
        kw.toLowerCase().includes(focusedValue),
      );
      // Unique and limit to 25
      const unique = [...new Set(filtered)].slice(0, 25);

      await interaction.respond(
        unique.map((choice) => ({ name: choice, value: choice })),
      );
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    const { commandName } = interaction;

    // Helper to create success/error embeds
    const createEmbed = (
      title: string,
      description: string,
      color: number = 0x00ff00,
    ) => {
      // Green
      return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
    };

    const createErrorEmbed = (description: string) => {
      return new EmbedBuilder()
        .setTitle("Error")
        .setDescription(description)
        .setColor(0xff0000); // Red
    };

    if (commandName === "help") {
      const embed = new EmbedBuilder()
        .setTitle("🤖 Super Soundboard Help")
        .setColor(0x0099ff)
        .addFields(
          {
            name: "/join",
            value: "ボイスチャンネルに参加して音声認識を開始します。",
          },
          { name: "/leave", value: "ボイスチャンネルから退出します。" },
          {
            name: "/play <keyword>",
            value: "キーワードを指定して効果音を再生します。",
          },
          {
            name: "/config",
            value: "config.json をファイルとして表示します。",
          },
          { name: "/sound list", value: "登録済みの効果音一覧を表示します。" },
          {
            name: "/sound add <keyword> <file> [volume]",
            value:
              "新しい効果音を登録します。キーワードはカンマ区切りで複数指定可。",
          },
          {
            name: "/sound edit <target> ...",
            value: "既存の効果音の設定を編集します。",
          },
          { name: "/sound remove <keyword>", value: "効果音を削除します。" },
        )
        .setFooter({ text: "キーワードを話すと効果音が再生されます！" });

      await interaction.reply({ embeds: [embed] });
    } else if (commandName === "join") {
      // Defer as public
      await interaction.deferReply();
      const member = interaction.member as GuildMember;
      if (member.voice.channel) {
        await ensureVoiceConnection(member.voice.channel);
        await interaction.editReply({
          embeds: [
            createEmbed(
              "Connected",
              `Listening in **${member.voice.channel.name}**!`,
              0x0099ff,
            ),
          ],
        });
      } else {
        await interaction.editReply({
          embeds: [createErrorEmbed("You must be in a Voice Channel first.")],
        });
      }
    } else if (commandName === "leave") {
      voiceConnection?.destroy();
      voiceConnection = null;
      await interaction.reply({
        embeds: [
          createEmbed("Disconnected", "Left the voice channel.", 0x0099ff),
        ],
      });
    } else if (commandName === "play") {
      const keyword = interaction.options.getString("keyword", true);
      const mapping = appConfig.mappings.find((m) =>
        m.keywords.some(
          (kw) => normalizeKeyword(kw) === normalizeKeyword(keyword),
        ),
      );

      if (mapping) {
        const resolved = resolvedMappings.find(
          (rm) => rm.file === mapping.file,
        );
        if (resolved) {
          enqueuePlayback(resolved.filePath, resolved.volume);
          await interaction.reply({
            embeds: [
              createEmbed(
                "▶️ Playing",
                `Playing sound for keyword "**${keyword}**"`,
                0x0099ff,
              ),
            ],
          });
        } else {
          await interaction.reply({
            embeds: [
              createErrorEmbed(
                `Sound file not found for keyword "${keyword}".`,
              ),
            ],
            flags: MessageFlags.Ephemeral,
          });
        }
      } else {
        await interaction.reply({
          embeds: [
            createErrorEmbed(`No sound found with keyword "${keyword}".`),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
    } else if (commandName === "config") {
      await interaction.reply({
        content: "📄 Current config.json:",
        files: [{ attachment: rootConfigPath, name: "config.json" }],
      });
    } else if (commandName === "sound") {
      const sub = interaction.options.getSubcommand();

      if (sub === "add") {
        await interaction.deferReply();

        const keywordInput = interaction.options.getString("keyword", true);
        const attachment = interaction.options.getAttachment("file", true);
        const volume = interaction.options.getInteger("volume") ?? 100;

        const keywords = keywordInput
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k.length > 0);

        if (keywords.length === 0) {
          await interaction.editReply({
            embeds: [createErrorEmbed("Invalid keywords.")],
          });
          return;
        }

        const validationError = validateKeywords(keywords);
        if (validationError) {
          await interaction.editReply({
            embeds: [createErrorEmbed(validationError)],
          });
          return;
        }

        const isAudioOrVideo =
          attachment.contentType?.startsWith("audio/") ||
          attachment.contentType?.startsWith("video/");
        if (!isAudioOrVideo) {
          await interaction.editReply({
            embeds: [createErrorEmbed("File must be an audio or video file.")],
          });
          return;
        }

        const randomFileName = generateRandomFilename();
        const tempPath = path.join(
          soundsDir,
          `temp_${Date.now()}_${attachment.name}`,
        );
        const finalPath = path.join(soundsDir, randomFileName);

        try {
          // Download the file
          const response = await axios.get(attachment.url, {
            responseType: "arraybuffer",
          });
          fs.writeFileSync(tempPath, response.data);

          // Convert to WAV 48kHz
          await convertToWav48k(tempPath, finalPath);
        } catch (e: any) {
          // Clean up temporary file if it exists
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
          await interaction.editReply({
            embeds: [
              createErrorEmbed(`Failed to process audio file: ${e.message}`),
            ],
          });
          return;
        }

        appConfig.mappings.push({
          keywords: keywords,
          file: randomFileName,
          volume: volume,
        });
        saveConfig();
        // Restart API to pick up the new mapping
        await restartApiServer();

        const embed = createEmbed(
          "Sound Added",
          `New sound registered successfully!`,
        ).addFields(
          { name: "Keywords", value: keywords.join(", "), inline: true },
          { name: "File", value: randomFileName, inline: true },
          { name: "Volume", value: `${volume}%`, inline: true },
        );

        await interaction.editReply({ embeds: [embed] });
      } else if (sub === "edit") {
        await interaction.deferReply();
        const targetKeyword = interaction.options.getString(
          "target_keyword",
          true,
        );

        const mapping = appConfig.mappings.find((m) =>
          m.keywords.includes(targetKeyword),
        );

        if (!mapping) {
          await interaction.editReply({
            embeds: [
              createErrorEmbed(
                `No sound found with keyword "${targetKeyword}".`,
              ),
            ],
          });
          return;
        }

        const newKeywordsInput = interaction.options.getString("new_keywords");
        const newFile = interaction.options.getAttachment("new_file");
        const newVolume = interaction.options.getInteger("new_volume");

        let changes = [];

        if (newKeywordsInput) {
          const newKeywords = newKeywordsInput
            .split(",")
            .map((k) => k.trim())
            .filter((k) => k.length > 0);
          if (newKeywords.length === 0) {
            await interaction.editReply({
              embeds: [createErrorEmbed("Invalid new keywords.")],
            });
            return;
          }

          const err = validateKeywords(newKeywords, mapping);
          if (err) {
            await interaction.editReply({ embeds: [createErrorEmbed(err)] });
            return;
          }

          mapping.keywords = newKeywords;
          changes.push(`**Keywords**: ${newKeywords.join(", ")}`);
        }

        if (newVolume !== null) {
          mapping.volume = newVolume;
          changes.push(`**Volume**: ${newVolume}%`);
        }

        if (newFile) {
          const isAudioOrVideo =
            newFile.contentType?.startsWith("audio/") ||
            newFile.contentType?.startsWith("video/");
          if (!isAudioOrVideo) {
            await interaction.editReply({
              embeds: [
                createErrorEmbed("New file must be an audio or video file."),
              ],
            });
            return;
          }

          const randomFileName = generateRandomFilename();
          const tempPath = path.join(
            soundsDir,
            `temp_${Date.now()}_${newFile.name}`,
          );
          const finalPath = path.join(soundsDir, randomFileName);

          try {
            // Download the file
            const response = await axios.get(newFile.url, {
              responseType: "arraybuffer",
            });
            fs.writeFileSync(tempPath, response.data);

            // Convert to WAV 48kHz
            await convertToWav48k(tempPath, finalPath);

            // Delete old file if it exists
            const oldFilePath = path.join(soundsDir, mapping.file);
            if (fs.existsSync(oldFilePath)) {
              fs.unlinkSync(oldFilePath);
            }

            mapping.file = randomFileName;
            changes.push(`**File**: ${randomFileName}`);
          } catch (e: any) {
            // Clean up temporary file if it exists
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
            }
            await interaction.editReply({
              embeds: [
                createErrorEmbed(`Failed to process audio file: ${e.message}`),
              ],
            });
            return;
          }
        }

        if (changes.length === 0) {
          await interaction.editReply({
            embeds: [
              createEmbed("No Changes", "No edits were specified.", 0xffff00),
            ],
          }); // Yellow
          return;
        }

        saveConfig();
        // Restart API to pick up changes
        await restartApiServer();
        await interaction.editReply({
          embeds: [createEmbed("Sound Updated", changes.join("\n"))],
        });
      } else if (sub === "remove") {
        const keyword = interaction.options.getString("keyword", true);
        const initialCount = appConfig.mappings.length;
        const newMappings = appConfig.mappings.filter(
          (m) => !m.keywords.includes(keyword),
        );

        if (newMappings.length === initialCount) {
          await interaction.reply({
            embeds: [
              createErrorEmbed(`No sound found with keyword "${keyword}".`),
            ],
            flags: MessageFlags.Ephemeral,
          });
        } else {
          appConfig.mappings = newMappings;
          saveConfig();
          // Restart API to pick up removal
          await restartApiServer();
          await interaction.reply({
            embeds: [
              createEmbed(
                "Sound Removed",
                `Successfully removed sound for keyword "**${keyword}**".`,
              ),
            ],
          });
        }
      } else if (sub === "list") {
        let description = "";
        if (appConfig.mappings.length === 0) {
          description =
            "No sounds registered yet. Use `/sound add` to get started!";
        } else {
          appConfig.mappings.forEach((m, i) => {
            const line = `**${i + 1}.** ${m.keywords
              .map((k) => `\`${k}\``)
              .join(", ")} \n   └ 📁 ${m.file} 🔊 ${m.volume ?? 100}%\n`;
            if (description.length + line.length < 4000) {
              description += line;
            }
          });
        }

        const embed = new EmbedBuilder()
          .setTitle("📋 Registered Sounds")
          .setColor(0x0099ff)
          .setDescription(description.length > 0 ? description : "None.");

        await interaction.reply({ embeds: [embed] });
      }
    }
  } catch (error: any) {
    log("error", "Command error", { error: error.message });
    const content = `An error occurred: ${error.message}`;
    // Always ephemeral for errors
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      // ignore
    }
  }
});

// --- Auto-Disconnect ---

client.on("voiceStateUpdate", (oldState, newState) => {
  if (
    !voiceConnection ||
    voiceConnection.state.status === VoiceConnectionStatus.Destroyed
  )
    return;

  const botChannelId = voiceConnection.joinConfig.channelId;
  if (!botChannelId) return;

  const changedChannelId = oldState.channelId || newState.channelId;

  // Ideally, we only care if someone LEFT the bot's channel.
  // But checking on any update to our channel is safe.
  if (botChannelId === changedChannelId) {
    // Get the channel from cache
    const channel = client.channels.cache.get(
      botChannelId,
    ) as VoiceBasedChannel;
    if (channel && channel.members.size === 1) {
      log("info", "Auto-disconnecting because channel is empty.");
      voiceConnection.destroy();
      voiceConnection = null;
    }
  }
});

// --- API Server ---

let apiServer = createApiServer(appConfig, soundsDir, log);

const restartApiServer = async () => {
  try {
    log("info", "Restarting API server...");
    if (apiServer.stopServer) {
      await apiServer.stopServer();
    }
    // Create a new API server with the updated config
    apiServer = createApiServer(appConfig, soundsDir, log);
    apiServer.startServer();
    log("info", "API server restarted successfully");
  } catch (e: any) {
    log("error", "Failed to restart API server", { error: e.message });
  }
};

// --- Start ---

const bootstrap = async () => {
  const shouldRegisterOnly = process.argv.includes("--register");
  if (shouldRegisterOnly) {
    await registerCommands();
    process.exit(0);
  }

  // Start API server
  apiServer.startServer();

  await registerCommands();
  await client.login(env.token);
  log("info", "Started.");
};

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled Rejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  log("error", "Uncaught Exception", {
    error: error.message,
    stack: error.stack,
  });
});

bootstrap();
