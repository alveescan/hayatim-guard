require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  AuditLogEvent,
  ChannelType,
  EmbedBuilder
} = require("discord.js");
const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");

/* =========================
   EXPRESS / UPTIMEROBOT
========================= */
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => res.status(200).send("Bot aktif 🔥"));
app.get("/health", (_, res) => res.status(200).send("OK"));

app.listen(PORT, () => {
  console.log(`Web server aktif: ${PORT}`);
});

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember
  ]
});

const PREFIX = process.env.PREFIX || ".";
const OWNER_IDS = (process.env.OWNER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const SETTINGS = {
  channelLogName: process.env.CHANNEL_LOG_NAME || "kanal-log",
  roleLogName: process.env.ROLE_LOG_NAME || "rol-log",
  banLogName: process.env.BAN_LOG_NAME || "ban-log",
  voiceLogName: process.env.VOICE_LOG_NAME || "voice-log",
  messageLogName: process.env.MESSAGE_LOG_NAME || "message-log",
  timeoutLogName: process.env.TIMEOUT_LOG_NAME || "timeout-log"
};

const COLORS = {
  green: 0x57F287,
  red: 0xED4245,
  yellow: 0xFEE75C,
  orange: 0xFAA61A,
  blue: 0x5865F2,
  white: 0xFFFFFF
};

/* =========================
   DATA / WHITELIST
========================= */
const dataDir = path.join(__dirname, "data");
const whitelistPath = path.join(dataDir, "whitelist.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(whitelistPath)) {
  fs.writeFileSync(whitelistPath, JSON.stringify([], null, 2));
}

function loadWhitelist() {
  try {
    const parsed = JSON.parse(fs.readFileSync(whitelistPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveWhitelist(list) {
  fs.writeFileSync(whitelistPath, JSON.stringify([...new Set(list)], null, 2));
}

function isOwner(userId) {
  return OWNER_IDS.includes(userId);
}

function isWhitelisted(userId) {
  return loadWhitelist().includes(userId) || isOwner(userId);
}

/* =========================
   HELPERS
========================= */
function formatUser(user) {
  return user ? `${user.tag} (${user.id})` : "Bilinmiyor";
}

function formatMember(member) {
  return member ? `${member.user.tag} (${member.id})` : "Bilinmiyor";
}

function getAvatar(entity) {
  if (!entity) return null;

  if (typeof entity.displayAvatarURL === "function") {
    return entity.displayAvatarURL({ size: 512, extension: "png" });
  }

  if (entity.user && typeof entity.user.displayAvatarURL === "function") {
    return entity.user.displayAvatarURL({ size: 512, extension: "png" });
  }

  return null;
}

function truncate(text, max = 1000) {
  if (!text) return "Yok";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

async function getLogChannel(guild, name) {
  return guild.channels.cache.find(
    (c) => c.name === name && c.type === ChannelType.GuildText
  ) || null;
}

async function sendLog(guild, logName, embed) {
  const channel = await getLogChannel(guild, logName);
  if (!channel) return;
  await channel.send({ embeds: [embed] }).catch(() => null);
}

async function fetchAuditEntry(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 6 });
    const now = Date.now();

    return logs.entries.find((entry) => {
      const entryTargetId = entry.target?.id || entry.targetId;
      return (
        String(entryTargetId) === String(targetId) &&
        now - entry.createdTimestamp < 15000
      );
    }) || null;
  } catch {
    return null;
  }
}

async function banMemberSafe(guild, userId, reason) {
  try {
    await guild.members.ban(userId, { reason });
    return true;
  } catch {
    return false;
  }
}

function channelChanges(oldChannel, newChannel) {
  const changes = [];

  if (oldChannel.name !== newChannel.name) {
    changes.push(`İsim: **${oldChannel.name}** → **${newChannel.name}**`);
  }

  if ((oldChannel.topic || "") !== (newChannel.topic || "")) {
    changes.push("Konu değiştirildi.");
  }

  if (oldChannel.nsfw !== newChannel.nsfw) {
    changes.push(
      `NSFW: **${oldChannel.nsfw ? "Açık" : "Kapalı"}** → **${newChannel.nsfw ? "Açık" : "Kapalı"}**`
    );
  }

  if ((oldChannel.rateLimitPerUser || 0) !== (newChannel.rateLimitPerUser || 0)) {
    changes.push(
      `Yavaş mod: **${oldChannel.rateLimitPerUser || 0}s** → **${newChannel.rateLimitPerUser || 0}s**`
    );
  }

  if ((oldChannel.bitrate || 0) !== (newChannel.bitrate || 0)) {
    changes.push(`Bitrate: **${oldChannel.bitrate || 0}** → **${newChannel.bitrate || 0}**`);
  }

  if ((oldChannel.userLimit || 0) !== (newChannel.userLimit || 0)) {
    changes.push(
      `Kullanıcı limiti: **${oldChannel.userLimit || 0}** → **${newChannel.userLimit || 0}**`
    );
  }

  if ((oldChannel.parentId || "Yok") !== (newChannel.parentId || "Yok")) {
    changes.push("Kategori değiştirildi.");
  }

  return changes.length ? changes : ["Kanal ayarlarında değişiklik yapıldı."];
}

async function resolveMember(guild, input) {
  if (!input) return null;
  const id = input.replace(/[^0-9]/g, "");
  if (!id) return null;

  try {
    return await guild.members.fetch(id);
  } catch {
    return null;
  }
}

function parseDuration(input) {
  if (!input) return null;

  const match = input.toLowerCase().match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2];

  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };

  return value * multipliers[unit];
}

function humanizeDuration(ms) {
  if (ms <= 0) return "0 saniye";

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days) return `${days} gün`;
  if (hours) return `${hours} saat`;
  if (minutes) return `${minutes} dakika`;
  return `${seconds} saniye`;
}

/* =========================
   READY
========================= */
client.once("ready", async () => {
  console.log(`${client.user.tag} aktif oldu.`);

  client.user.setPresence({
    activities: [{ name: "Guard Sistemi Aktif", type: 3 }],
    status: "online"
  });
});

/* =========================
   COMMANDS
========================= */
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  /* ========== WHITELIST ========== */
  if (command === "wl-ekle") {
    if (!isOwner(message.author.id)) {
      return message.reply("Bu komutu sadece bot sahibi kullanabilir.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return message.reply("Kullanıcı bulunamadı.");

    const list = loadWhitelist();
    if (list.includes(target.id)) {
      return message.reply("Bu kullanıcı zaten whitelistte.");
    }

    list.push(target.id);
    saveWhitelist(list);

    return message.reply(`Whitelist eklendi: **${target.user.tag}** (${target.id})`);
  }

  if (command === "wl-sil") {
    if (!isOwner(message.author.id)) {
      return message.reply("Bu komutu sadece bot sahibi kullanabilir.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return message.reply("Kullanıcı bulunamadı.");

    const list = loadWhitelist().filter((id) => id !== target.id);
    saveWhitelist(list);

    return message.reply(`Whitelistten çıkarıldı: **${target.user.tag}** (${target.id})`);
  }

  if (command === "wl-liste") {
    if (!isOwner(message.author.id)) {
      return message.reply("Bu komutu sadece bot sahibi kullanabilir.");
    }

    const list = loadWhitelist();
    if (!list.length) return message.reply("Whitelist boş.");

    const lines = await Promise.all(
      list.map(async (id, i) => {
        try {
          const user = await client.users.fetch(id);
          return `${i + 1}. ${user.tag} (${id})`;
        } catch {
          return `${i + 1}. Bilinmeyen Kullanıcı (${id})`;
        }
      })
    );

    return message.reply(`**Whitelist Listesi**\n${lines.join("\n")}`);
  }

  /* ========== BAN ========== */
  if (command === "ban") {
    if (!isWhitelisted(message.author.id)) {
      return message.reply("Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      return message.reply("Ban yetkin yok.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return message.reply("Banlanacak kullanıcı bulunamadı.");
    if (target.id === message.author.id) return message.reply("Kendini banlayamazsın.");
    if (!target.bannable) {
      return message.reply("Bu kullanıcıyı banlayamıyorum. Rol sırası veya yetkiyi kontrol et.");
    }

    const reason = args.slice(1).join(" ") || "Sebep belirtilmedi.";
    await target.ban({ reason: `${reason} | Komutu kullanan: ${message.author.tag}` });

    return message.reply(`**${target.user.tag}** banlandı. Sebep: **${reason}**`);
  }

  /* ========== KICK ========== */
  if (command === "kick") {
    if (!isWhitelisted(message.author.id)) {
      return message.reply("Whitelistte olmadığın için bu komutu kullanamazsın.");
    }

    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
      return message.reply("Kick yetkin yok.");
    }

    const target = await resolveMember(message.guild, args[0]);
    if (!target) return message.reply("Atılacak kullanıcı bulunamadı.");
    if (target.id === message.author.id) return message.reply("Kendini kickleyemezsin.");
    if (!target.kickable) {
      return message.reply("Bu kullanıcıyı kickleyemiyorum. Rol sırası veya yetkiyi kontrol et.");
    }

    const reason = args.slice(1).join(" ") || "Sebep belirtilmedi.";
    await target.kick(`${reason} | Komutu kullanan: ${message.author.tag}`);

    return message.reply(`**${target.user.tag}** kicklendi. Sebep: **${reason}**`);
  }

  /* ========== TIMEOUT ========== */
  if (command === "timeout") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      return message.reply("Timeout yetkin yok.");
    }

    const target = await resolveMember(message.guild, args[0]);
    const durationMs = parseDuration(args[1]);

    if (!target) return message.reply("Timeout atılacak kullanıcı bulunamadı.");
    if (!durationMs) {
      return message.reply("Süre formatı yanlış. Örnek: `.timeout @kullanıcı 1h sebep`");
    }
    if (!target.moderatable) {
      return message.reply("Bu kullanıcıya timeout atamıyorum.");
    }

    const reason = args.slice(2).join(" ") || "Sebep belirtilmedi.";
    await target.timeout(durationMs, `${reason} | Komutu kullanan: ${message.author.tag}`);

    return message.reply(
      `**${target.user.tag}** kullanıcısına **${humanizeDuration(durationMs)}** timeout atıldı.`
    );
  }

  /* ========== SIL ========== */
  if (command === "sil") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return message.reply("Mesaj silme yetkin yok.");
    }

    const amount = Number(args[0]);
    if (!amount || amount < 1 || amount > 200) {
      return message.reply("1 ile 200 arasında sayı girmelisin.");
    }

    let remaining = amount;
    let deleted = 0;

    while (remaining > 0) {
      const fetchSize = Math.min(remaining, 100);
      const batch = await message.channel.bulkDelete(fetchSize, true).catch(() => null);
      if (!batch) break;

      deleted += batch.size;
      remaining -= batch.size;

      if (batch.size < fetchSize) break;
    }

    const info = `#${message.channel.name} kanalından **${deleted}** adet mesajı sildim.`;
    const reply = await message.channel.send(info).catch(() => null);
    if (reply) {
      setTimeout(() => reply.delete().catch(() => null), 5000);
    }
    return;
  }

  /* ========== JOIN ========== */
  if (command === "join") {
    if (!message.member.voice.channel) {
      return message.reply("Önce bir ses kanalına girmen gerekiyor.");
    }

    joinVoiceChannel({
      channelId: message.member.voice.channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true
    });

    return message.reply(`Ses kanalına girdim: **${message.member.voice.channel.name}**`);
  }

  /* ========== LEAVE ========== */
  if (command === "leave") {
    const connection = getVoiceConnection(message.guild.id);
    if (!connection) return message.reply("Zaten bir ses kanalında değilim.");

    connection.destroy();
    return message.reply("Ses kanalından çıktım.");
  }
});

/* =========================
   CHANNEL GUARD + LOG
========================= */
client.on("channelCreate", async (channel) => {
  if (!channel.guild) return;

  const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
  const executor = entry?.executor || null;

  const embed = new EmbedBuilder()
    .setColor(COLORS.green)
    .setTitle("Kanal Oluşturuldu")
    .setDescription([
      `**Kanal:** ${channel.name}`,
      `**Tür:** ${ChannelType[channel.type] || channel.type}`,
      `**Oluşturan kişi:** ${formatUser(executor)}`,
      `**Değişiklik:** Yeni kanal oluşturuldu`
    ].join("\n"))
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(channel.guild, SETTINGS.channelLogName, embed);

  if (executor && !executor.bot && !isWhitelisted(executor.id)) {
    await banMemberSafe(channel.guild, executor.id, "Whitelist dışı kanal oluşturma");
  }
});

client.on("channelDelete", async (channel) => {
  if (!channel.guild) return;

  const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
  const executor = entry?.executor || null;

  const embed = new EmbedBuilder()
    .setColor(COLORS.red)
    .setTitle("Kanal Silindi")
    .setDescription([
      `**Kanal:** ${channel.name}`,
      `**Tür:** ${ChannelType[channel.type] || channel.type}`,
      `**Silen kişi:** ${formatUser(executor)}`,
      `**Değişiklik:** Kanal silindi`
    ].join("\n"))
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(channel.guild, SETTINGS.channelLogName, embed);

  if (executor && !executor.bot && !isWhitelisted(executor.id)) {
    await banMemberSafe(channel.guild, executor.id, "Whitelist dışı kanal silme");
  }
});

client.on("channelUpdate", async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;

  const entry = await fetchAuditEntry(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
  const executor = entry?.executor || null;
  const changes = channelChanges(oldChannel, newChannel);

  const embed = new EmbedBuilder()
    .setColor(COLORS.yellow)
    .setTitle("Kanal Düzenlendi")
    .setDescription([
      `**Kanal:** ${newChannel.name}`,
      `**Düzenleyen kişi:** ${formatUser(executor)}`,
      `**Yapılan değişiklikler:**`,
      changes.map((x) => `• ${x}`).join("\n")
    ].join("\n"))
    .setThumbnail(getAvatar(executor))
    .setTimestamp();

  await sendLog(newChannel.guild, SETTINGS.channelLogName, embed);

  if (executor && !executor.bot && !isWhitelisted(executor.id)) {
    await banMemberSafe(newChannel.guild, executor.id, "Whitelist dışı kanal düzenleme");
  }
});

/* =========================
   ROLE LOG
========================= */
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const oldRoles = oldMember.roles.cache;
  const newRoles = newMember.roles.cache;

  const addedRoles = newRoles.filter(
    (role) => !oldRoles.has(role.id) && role.id !== newMember.guild.id
  );
  const removedRoles = oldRoles.filter(
    (role) => !newRoles.has(role.id) && role.id !== newMember.guild.id
  );

  if (addedRoles.size || removedRoles.size) {
    const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
    const executor = entry?.executor || null;

    for (const role of addedRoles.values()) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.green)
        .setTitle("Rol Verildi")
        .setDescription([
          `**Kullanıcı:** ${formatMember(newMember)}`,
          `**Verilen rol:** ${role.name}`,
          `**Rolü veren kişi:** ${formatUser(executor)}`
        ].join("\n"))
        .setThumbnail(getAvatar(newMember))
        .setTimestamp();

      await sendLog(newMember.guild, SETTINGS.roleLogName, embed);
    }

    for (const role of removedRoles.values()) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.red)
        .setTitle("Rol Alındı")
        .setDescription([
          `**Kullanıcı:** ${formatMember(newMember)}`,
          `**Alınan rol:** ${role.name}`,
          `**Rolü alan kişi:** ${formatUser(executor)}`
        ].join("\n"))
        .setThumbnail(getAvatar(newMember))
        .setTimestamp();

      await sendLog(newMember.guild, SETTINGS.roleLogName, embed);
    }
  }

  /* ===== TIMEOUT LOG ===== */
  const oldTimeout = oldMember.communicationDisabledUntilTimestamp || null;
  const newTimeout = newMember.communicationDisabledUntilTimestamp || null;

  if (oldTimeout !== newTimeout) {
    const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
    const executor = entry?.executor || null;
    const isTimeoutAdded = Boolean(newTimeout && (!oldTimeout || newTimeout > oldTimeout));

    const embed = new EmbedBuilder()
      .setColor(isTimeoutAdded ? COLORS.yellow : COLORS.green)
      .setTitle(isTimeoutAdded ? "Zaman Aşımı İşlemi" : "Zaman Aşımı Kaldırıldı")
      .setDescription([
        `**Kullanıcı:** ${formatMember(newMember)}`,
        `**İşlemi yapan kişi:** ${formatUser(executor)}`,
        isTimeoutAdded
          ? `**Süre:** ${humanizeDuration(newTimeout - Date.now())}`
          : `**Durum:** Timeout kaldırıldı`
      ].join("\n"))
      .setThumbnail(getAvatar(newMember))
      .setTimestamp();

    await sendLog(newMember.guild, SETTINGS.timeoutLogName, embed);
  }
});

/* =========================
   BAN / KICK GUARD + LOG
========================= */
client.on("guildBanAdd", async (ban) => {
  const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  const executor = entry?.executor || null;
  const reason = entry?.reason || "Sebep belirtilmedi.";

  if (executor && !executor.bot && !isWhitelisted(executor.id)) {
    await ban.guild.members.unban(ban.user.id, "Whitelist dışı ban geri alındı").catch(() => null);
    await banMemberSafe(ban.guild, executor.id, "Whitelist dışı sağ tık ban");
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.red)
    .setTitle("Kullanıcı Banlandı")
    .setDescription([
      `**Banlanan kişi:** ${formatUser(ban.user)}`,
      `**Banlayan kişi:** ${formatUser(executor)}`,
      `**Sebep:** ${reason}`
    ].join("\n"))
    .setThumbnail(getAvatar(ban.user))
    .setTimestamp();

  await sendLog(ban.guild, SETTINGS.banLogName, embed);
});

client.on("guildMemberRemove", async (member) => {
  const entry = await fetchAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id);
  if (!entry) return;

  const executor = entry.executor || null;
  const reason = entry.reason || "Sebep belirtilmedi.";

  if (executor && !executor.bot && !isWhitelisted(executor.id)) {
    await banMemberSafe(member.guild, executor.id, "Whitelist dışı sağ tık kick");
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.orange)
    .setTitle("Kullanıcı Kicklendi")
    .setDescription([
      `**Kicklenen kişi:** ${formatMember(member)}`,
      `**Kickleyen kişi:** ${formatUser(executor)}`,
      `**Sebep:** ${reason}`
    ].join("\n"))
    .setThumbnail(getAvatar(member))
    .setTimestamp();

  await sendLog(member.guild, SETTINGS.banLogName, embed);
});

/* =========================
   MESSAGE LOG
========================= */
client.on("messageDelete", async (message) => {
  if (!message.guild || message.author?.bot) return;

  const embed = new EmbedBuilder()
    .setColor(COLORS.red)
    .setTitle("Mesaj Silindi")
    .setDescription([
      `**Mesaj atan:** ${message.author ? `${message.author.tag} (${message.author.id})` : "Bilinmiyor"}`,
      `**Kanal:** ${message.channel}`,
      `**Silinen mesaj:**`,
      truncate(message.content || "İçerik alınamadı.")
    ].join("\n"))
    .setThumbnail(getAvatar(message.author))
    .setTimestamp();

  await sendLog(message.guild, SETTINGS.messageLogName, embed);
});

client.on("messageDeleteBulk", async (messages) => {
  const first = messages.first();
  if (!first?.guild) return;

  const embed = new EmbedBuilder()
    .setColor(COLORS.orange)
    .setTitle("Toplu Mesaj Silme")
    .setDescription([
      `**Kanal:** ${first.channel}`,
      `**Silinen adet:** ${messages.size}`
    ].join("\n"))
    .setTimestamp();

  await sendLog(first.guild, SETTINGS.messageLogName, embed);
});

/* =========================
   VOICE LOG
========================= */
client.on("voiceStateUpdate", async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  if (oldState.channelId && !newState.channelId) {
    const entry = await fetchAuditEntry(guild, AuditLogEvent.MemberDisconnect, oldState.id);
    const executor = entry?.executor || null;

    const embed = new EmbedBuilder()
      .setColor(COLORS.red)
      .setTitle("Ses Bağlantısı Kesildi")
      .setDescription([
        `**Bağlantısı kesilen kişi:** ${formatMember(oldState.member)}`,
        `**Bağlantıyı kesen kişi:** ${formatUser(executor)}`,
        `**Eski kanal:** ${oldState.channel?.name || "Bilinmiyor"}`
      ].join("\n"))
      .setThumbnail(getAvatar(oldState.member))
      .setTimestamp();

    await sendLog(guild, SETTINGS.voiceLogName, embed);
    return;
  }

  if (!oldState.channelId && newState.channelId) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.green)
      .setTitle("Ses Kanalına Giriş")
      .setDescription([
        `**Kullanıcı:** ${formatMember(newState.member)}`,
        `**Kanal:** ${newState.channel?.name || "Bilinmiyor"}`
      ].join("\n"))
      .setThumbnail(getAvatar(newState.member))
      .setTimestamp();

    await sendLog(guild, SETTINGS.voiceLogName, embed);
    return;
  }

  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.blue)
      .setTitle("Ses Kanalı Değişti")
      .setDescription([
        `**Kullanıcı:** ${formatMember(newState.member)}`,
        `**Eski kanal:** ${oldState.channel?.name || "Bilinmiyor"}`,
        `**Yeni kanal:** ${newState.channel?.name || "Bilinmiyor"}`
      ].join("\n"))
      .setThumbnail(getAvatar(newState.member))
      .setTimestamp();

    await sendLog(guild, SETTINGS.voiceLogName, embed);
  }
});

/* =========================
   PROCESS SAFETY
========================= */
process.on("unhandledRejection", (error) => {
  console.error("Unhandled Rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

/* =========================
   LOGIN
========================= */
client.login(process.env.TOKEN);