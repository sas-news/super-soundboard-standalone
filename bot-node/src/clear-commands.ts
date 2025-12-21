import { REST, Routes } from "discord.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const token = process.env.DISCORD_TOKEN!;
const appId = process.env.DISCORD_APP_ID!;
const guildId = process.env.GUILD_ID;

const rest = new REST({ version: "10" }).setToken(token);

async function clearCommands() {
    console.log("古いコマンドを削除中...");

    // グローバルコマンドを削除
    console.log("グローバルコマンドを削除...");
    await rest.put(Routes.applicationCommands(appId), { body: [] });
    console.log("✓ グローバルコマンド削除完了");

    // ギルドコマンドも削除（GUILD_IDがある場合）
    if (guildId) {
        console.log(`ギルドコマンドを削除 (${guildId})...`);
        await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [] });
        console.log("✓ ギルドコマンド削除完了");
    }

    console.log("\n全コマンド削除完了！");
    console.log("次に `npm run deploy:commands` を実行してコマンドを再登録してください。");
}

clearCommands().catch(console.error);
