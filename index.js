import fs from "fs-extra";
import Database from "better-sqlite3";
import {
  Client, GatewayIntentBits, Partials,
  ChannelType, PermissionsBitField,
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, Routes, REST,
  MessageFlags
} from "discord.js";
import { v4 as uuidv4 } from "uuid";

// read config and locale
const cfg = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const LOCALE = JSON.parse(fs.readFileSync(`./locales/${cfg.lang || "ar"}.json`, "utf8"));
const t = (k, vars = {}) => (LOCALE[k] || k).replace(/\{(\w+)\}/g, (_, x) => String(vars[x] ?? ""));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// ===== SQLite =====
fs.ensureFileSync("./tickets.db");
const db = new Database("./tickets.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  channelId TEXT,
  userId TEXT,
  type TEXT,
  status TEXT,
  state TEXT,
  createdAt INTEGER,
  lastActivityAt INTEGER,
  claimedBy TEXT,
  closedAt INTEGER,
  reopenedCount INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticketId TEXT,
  at INTEGER,
  action TEXT,
  byUser TEXT,
  data TEXT
);
`);
const stmtInsert = db.prepare(`INSERT INTO tickets (id, channelId, userId, type, status, state, createdAt, lastActivityAt, claimedBy, closedAt, reopenedCount)
VALUES (@id, @channelId, @userId, @type, @status, @state, @createdAt, @lastActivityAt, @claimedBy, @closedAt, @reopenedCount)`);
const stmtGetByChannel = db.prepare(`SELECT * FROM tickets WHERE channelId=?`);
const stmtGetByUser = db.prepare(`SELECT * FROM tickets WHERE userId=?`);
const stmtCountOpenByUser = db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE userId=? AND status='open'`);
const stmtCountOpenByUserType = db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE userId=? AND type=? AND status='open'`);
const stmtUpdate = db.prepare(`UPDATE tickets SET status=@status, state=@state, lastActivityAt=@lastActivityAt, claimedBy=@claimedBy, closedAt=@closedAt, reopenedCount=@reopenedCount, type=COALESCE(@type,type) WHERE id=@id`);
const stmtLog = db.prepare(`INSERT INTO actions (ticketId, at, action, byUser, data) VALUES (?,?,?,?,?)`);
const stmtStats = {
  total: db.prepare(`SELECT COUNT(*) AS n FROM tickets`),
  open: db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE status='open'`),
  closed: db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE status='closed'`),
  claimed: db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE claimedBy IS NOT NULL AND claimedBy!=''`)
};

// ==== utils
const isAdmin = m => m.permissions.has(PermissionsBitField.Flags.Administrator);
const hasRole = (m, id) => id && m.roles.cache.has(id);
const can = (m, roleId) => isAdmin(m) || hasRole(m, roleId);
const now = () => Date.now();
const fmtH = ms => (ms / 3600000).toFixed(1);

function panelRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ticket_menu")
      .setPlaceholder(t("select.placeholder"))
      .addOptions([
        { label: t("type.support"), value: "support" },
        { label: t("type.billing"), value: "billing" },
        { label: t("type.technical"), value: "technical" },
        { label: t("type.partnership"), value: "partnership" },
        { label: t("type.report"), value: "report" }
      ])
  );
}
function controlButtons(isClosed = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket_claim").setLabel(t("btn.claim")).setStyle(ButtonStyle.Primary).setDisabled(isClosed),
      new ButtonBuilder().setCustomId("ticket_close").setLabel(t("btn.close")).setStyle(ButtonStyle.Danger).setDisabled(isClosed),
      new ButtonBuilder().setCustomId("ticket_reopen").setLabel(t("btn.reopen")).setStyle(ButtonStyle.Success).setDisabled(!isClosed),
      new ButtonBuilder().setCustomId("ticket_delete").setLabel(t("btn.delete")).setStyle(ButtonStyle.Secondary).setDisabled(!isClosed)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("state_user").setLabel(t("btn.state_user")).setStyle(ButtonStyle.Secondary).setDisabled(isClosed),
      new ButtonBuilder().setCustomId("state_staff").setLabel(t("btn.state_staff")).setStyle(ButtonStyle.Secondary).setDisabled(isClosed)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ticket_macro")
        .setPlaceholder(t("macro.title"))
        .addOptions([
          { label: t("macro.greet"), value: "greet" },
          { label: t("macro.moreinfo"), value: "moreinfo" },
          { label: t("macro.waiting_user"), value: "waiting_user" },
          { label: t("macro.waiting_staff"), value: "waiting_staff" }
        ])
    )
  ];
}
function modalFor(type) {
  const map = {
    support: { title: "modal.support.title", q1: "modal.support.q1", q2: "modal.support.q2" },
    billing: { title: "modal.billing.title", q1: "modal.billing.q1", q2: "modal.billing.q2" },
    technical: { title: "modal.technical.title", q1: "modal.technical.q1", q2: "modal.technical.q2" },
    partnership: { title: "modal.partnership.title", q1: "modal.partnership.q1", q2: "modal.partnership.q2" },
    report: { title: "modal.report.title", q1: "modal.report.q1", q2: "modal.report.q2" }
  }[type];
  const modal = new ModalBuilder().setCustomId(`ticket_modal_${type}`).setTitle(t(map.title));
  const q1 = new TextInputBuilder().setCustomId("q1").setLabel(t(map.q1)).setStyle(TextInputStyle.Paragraph).setRequired(true);
  const q2 = new TextInputBuilder().setCustomId("q2").setLabel(t(map.q2)).setStyle(TextInputStyle.Paragraph).setRequired(false);
  modal.addComponents(new ActionRowBuilder().addComponents(q1), new ActionRowBuilder().addComponents(q2));
  return modal;
}
function closeReasonModal() {
  const modal = new ModalBuilder().setCustomId("close_reason_modal").setTitle(t("close.reason.modal"));
  const input = new TextInputBuilder().setCustomId("reason").setLabel(t("close.reason.label")).setStyle(TextInputStyle.Paragraph).setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}
const esc = s => String(s || "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[m]));

// ==== slash commands
const commands = [
  new SlashCommandBuilder().setName("add").setDescription("Add user to current ticket")
    .addUserOption(o => o.setName("user").setDescription("User to add").setRequired(true)),
  new SlashCommandBuilder().setName("remove").setDescription("Remove user from current ticket")
    .addUserOption(o => o.setName("user").setDescription("User to remove").setRequired(true)),
  new SlashCommandBuilder().setName("move").setDescription("Move ticket to another type")
    .addStringOption(o => o.setName("type").setDescription("support|billing|technical|partnership|report").setRequired(true)),
  new SlashCommandBuilder().setName("note").setDescription("Post staff note to ticket")
    .addStringOption(o => o.setName("text").setDescription("note text").setRequired(true)),
  new SlashCommandBuilder().setName("stats").setDescription("Show ticket stats")
].map(c => c.toJSON());

async function registerSlash() {
  const rest = new REST({ version: "10" }).setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), { body: commands });
  console.log("✅ Slash commands registered");
}

// ==== panel
async function postPanel() {
  const ch = await client.channels.fetch(cfg.panelChannelId);
  const embed = new EmbedBuilder().setTitle(t("panel.title")).setDescription(t("panel.desc")).setColor("#5865F2");
  await ch.send({ embeds: [embed], components: [panelRow()] });
}

// ==== startup
if (process.argv[2] === "register") {
  (async () => { await registerSlash(); })();
}

client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    const ch = await client.channels.fetch(cfg.panelChannelId);
    const msgs = await ch.messages.fetch({ limit: 3 }).catch(() => new Map());
    if (!msgs || msgs.size === 0) await postPanel();
  } catch {}
  setInterval(weeklyReportTick, 60 * 1000);
  setInterval(autoCloseIdle, 10 * 60 * 1000);
});

// track activity
client.on("messageCreate", (m) => {
  if (!m.guild || m.author.bot) return;
  const row = stmtGetByChannel.get(m.channel.id);
  if (row && row.status === "open") {
    db.prepare(`UPDATE tickets SET lastActivityAt=? WHERE id=?`).run(now(), row.id);
  }
});

// ==== interactions
client.on("interactionCreate", async (interaction) => {
  // open modal
  if (interaction.isStringSelectMenu() && interaction.customId === "ticket_menu") {
    const type = interaction.values[0];
    return interaction.showModal(modalFor(type));
  }

  // submit modal open
  if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket_modal_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const type = interaction.customId.split("_").pop();
    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user.id);
    const category = guild.channels.cache.get(cfg.ticketsCategoryId);
    if (!category) return interaction.editReply({ content: t("errors.category") });

    // limits
    const perTypeLimit = Math.max(1, Number(cfg.perTypeLimit || 1));
    const globalLimit = Math.max(1, Number(cfg.globalOpenLimit || 2));
    const dailyLimit = Number(cfg.dailyOpenLimit || 0);
    const cooldown = (cfg.openCooldownSec || 0) * 1000;

    const userTickets = stmtGetByUser.all(member.id);
    const lastOpen = userTickets.reduce((mx, x) => Math.max(mx, x.createdAt || 0), 0);
    if (!isAdmin(member) && !hasRole(member, cfg.bypassLimitRoleId) && cooldown > 0 && (now() - lastOpen) < cooldown) {
      const s = Math.ceil((cooldown - (now() - lastOpen)) / 1000);
      return interaction.editReply({ content: t("errors.cooldown", { s }) });
    }
    if (!isAdmin(member) && !hasRole(member, cfg.bypassLimitRoleId)) {
      const openByType = stmtCountOpenByUserType.get(member.id, type).c;
      const openGlobal = stmtCountOpenByUser.get(member.id).c;
      if (openByType >= perTypeLimit) return interaction.editReply({ content: t("errors.limit_type") });
      if (openGlobal >= globalLimit) return interaction.editReply({ content: t("errors.limit_global") });
      if (dailyLimit) {
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
        const todayOpened = userTickets.filter(x => x.createdAt >= startOfDay.getTime()).length;
        if (todayOpened >= dailyLimit) return interaction.editReply({ content: t("errors.limit_daily") });
      }
    }

    // create channel
    const ticketId = uuidv4().split("-")[0].toUpperCase();
    const name = `ticket-${type}-${member.id}-${ticketId}`;
    const typeRoleId = (cfg.typeRoleIds || {})[type] || cfg.supportTeamRoleId;

    const ch = await guild.channels.create({
      name, type: ChannelType.GuildText, parent: cfg.ticketsCategoryId,
      topic: `ticketId:${ticketId} | type:${type} | user:${member.id} | status:open`,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
        { id: typeRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] }
      ]
    });

    const payload = {
      id: ticketId, channelId: ch.id, userId: member.id, type, status: "open",
      state: "waiting_staff", createdAt: now(), lastActivityAt: now(),
      claimedBy: null, closedAt: null, reopenedCount: 0
    };
    stmtInsert.run(payload);
    stmtLog.run(ticketId, now(), "open", member.id, JSON.stringify({
      q1: interaction.fields.getTextInputValue("q1"),
      q2: interaction.fields.getTextInputValue("q2")
    }));

    const embed = new EmbedBuilder()
      .setTitle(t("ticket.opened"))
      .addFields(
        { name: t("ticket.type"), value: `**${type}**`, inline: true },
        { name: t("ticket.id"), value: `**${ticketId}**`, inline: true },
        { name: t("ticket.owner"), value: `<@${member.id}>`, inline: true }
      )
      .setColor("#00A86B");

    await ch.send({ content: `<@${member.id}> <@&${typeRoleId}>`, embeds: [embed] });
    await ch.send({ content: makeWelcome(type, interaction.fields.getTextInputValue("q1"), interaction.fields.getTextInputValue("q2")), components: controlButtons(false) });

    const logCh = await client.channels.fetch(cfg.logChannelId).catch(() => null);
    if (logCh) {
      const e = new EmbedBuilder().setTitle("🆕").setDescription(`type **${type}**\nchannel ${ch}\nid **${ticketId}**\nby <@${member.id}>`).setColor("#00A86B");
      logCh.send({ embeds: [e] });
    }

    return interaction.editReply({ content: t("open.reply", { channel: `${ch}` }) });
  }

  // close reason modal
  if (interaction.isModalSubmit() && interaction.customId === "close_reason_modal") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const row = stmtGetByChannel.get(interaction.channel.id);
    if (!row) return interaction.editReply({ content: t("errors.not_ticket") });

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!can(member, cfg.closeRoleId)) return interaction.editReply({ content: t("errors.no_perm") });
    if (row.status === "closed") return interaction.editReply({ content: t("errors.already_closed") });

    const reason = interaction.fields.getTextInputValue("reason");
    await doClose(interaction, row, member, reason);
    return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(t("ticket.closed")).setDescription(`${t("ticket.id")} **${row.id}**`).setColor("#e74c3c")] });
  }

  // macros
  if (interaction.isStringSelectMenu() && interaction.customId === "ticket_macro") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const row = stmtGetByChannel.get(interaction.channel.id);
    if (!row) return interaction.editReply({ content: t("errors.not_ticket") });
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!can(member, cfg.claimRoleId)) return interaction.editReply({ content: t("errors.no_perm") });

    const val = interaction.values[0];
    const replies = {
      greet: `اهلاً بك 🌟 رجاءً وفّر أكبر قدر من التفاصيل حتى نساعدك بأسرع وقت\n• رقم الطلب او الفاتورة إن وجد\n• وصف المشكلة\n• صور او روابط`,
      moreinfo: `نحتاج تفاصيل أكثر حتى نعالج الطلب ✅\n• شنو حاولت\n• شنو الأخطاء الظاهرة\n• وقت الحدوث وروابط او صور`
    };
    if (val === "waiting_user") {
      row.state = "waiting_user"; stmtUpdate.run(row);
      stmtLog.run(row.id, now(), "state", interaction.user.id, "waiting_user");
      await interaction.channel.send(t("ticket.wait_user"));
    } else if (val === "waiting_staff") {
      row.state = "waiting_staff"; stmtUpdate.run(row);
      stmtLog.run(row.id, now(), "state", interaction.user.id, "waiting_staff");
      await interaction.channel.send(t("ticket.wait_staff"));
    } else {
      await interaction.channel.send(replies[val] || "OK");
    }
    return interaction.editReply({ content: "✅" });
  }

  // buttons
  if (interaction.isButton()) {
    // زر الإغلاق: لا defer قبل عرض المودال
    if (interaction.customId === "ticket_close") {
      const row = stmtGetByChannel.get(interaction.channel.id);
      if (!row) return interaction.reply({ content: t("errors.not_ticket"), flags: MessageFlags.Ephemeral });
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!can(member, cfg.closeRoleId)) return interaction.reply({ content: t("errors.no_perm"), flags: MessageFlags.Ephemeral });
      if (row.status === "closed") return interaction.reply({ content: t("errors.already_closed"), flags: MessageFlags.Ephemeral });
      return interaction.showModal(closeReasonModal());
    }

    // بقية الأزرار: defer بإستخدام flags
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const row = stmtGetByChannel.get(interaction.channel.id);
    if (!row) return interaction.editReply({ content: t("errors.not_ticket") });
    const member = await interaction.guild.members.fetch(interaction.user.id);

    if (interaction.customId === "ticket_claim") {
      if (!can(member, cfg.claimRoleId)) return interaction.editReply({ content: t("errors.no_perm") });
      if (row.claimedBy) return interaction.editReply({ content: `${t("ticket.claimed")} <@${row.claimedBy}>` });
      row.claimedBy = member.id; row.state = "waiting_user"; stmtUpdate.run(row);
      stmtLog.run(row.id, now(), "claim", member.id, "");
      await interaction.channel.send(`${t("ticket.claimed")} <@${member.id}>`);
      return interaction.editReply({ content: "✅" });
    }

    if (interaction.customId === "state_user") {
      if (!can(member, cfg.claimRoleId)) return interaction.editReply({ content: t("errors.no_perm") });
      row.state = "waiting_user"; stmtUpdate.run(row);
      stmtLog.run(row.id, now(), "state", member.id, "waiting_user");
      await interaction.channel.send(t("ticket.wait_user"));
      return interaction.editReply({ content: "✅" });
    }

    if (interaction.customId === "state_staff") {
      if (!can(member, cfg.claimRoleId)) return interaction.editReply({ content: t("errors.no_perm") });
      row.state = "waiting_staff"; stmtUpdate.run(row);
      stmtLog.run(row.id, now(), "state", member.id, "waiting_staff");
      await interaction.channel.send(t("ticket.wait_staff"));
      return interaction.editReply({ content: "✅" });
    }

    if (interaction.customId === "ticket_reopen") {
      if (!can(member, cfg.reopenRoleId)) return interaction.editReply({ content: t("errors.no_perm") });
      if (row.status !== "closed") return interaction.editReply({ content: t("errors.not_closed") });
      if (Number(row.reopenedCount || 0) >= Number(cfg.reopenLimit || 0)) return interaction.editReply({ content: t("errors.reopen_limit") });

      row.status = "open"; row.reopenedCount = (row.reopenedCount || 0) + 1; row.state = "waiting_staff"; stmtUpdate.run(row);
      stmtLog.run(row.id, now(), "reopen", member.id, "");
      await interaction.channel.permissionOverwrites.edit(row.userId, { ViewChannel: true, SendMessages: true }).catch(() => { });
      await interaction.channel.setName(interaction.channel.name.replace(/-closed$/, "")).catch(() => { });
      await interaction.channel.setParent(cfg.ticketsCategoryId).catch(() => { });
      await interaction.channel.send(t("ticket.reopened"));
      await resetControls(interaction.channel, false);
      return interaction.editReply({ content: "✅" });
    }

    if (interaction.customId === "ticket_delete") {
      if (!can(member, cfg.deleteRoleId)) return interaction.editReply({ content: t("errors.no_perm") });
      if (row.status !== "closed") return interaction.editReply({ content: t("errors.must_close_first") });
      stmtLog.run(row.id, now(), "delete", member.id, "");
      await interaction.editReply({ content: "🗑️" });
      const chId = interaction.channel.id;
      const logCh = await client.channels.fetch(cfg.logChannelId).catch(() => null);
      if (logCh) logCh.send({
        embeds: [new EmbedBuilder().setTitle(t("ticket.deleted")).setDescription(`${t("ticket.id")} **${row.id}**\n<#${chId}>`).setColor("#95a5a6")]
      }).catch(() => { });
      try { await interaction.channel.delete("Ticket hard delete"); } catch { }
      return;
    }
  }

  // slash
  if (interaction.isChatInputCommand()) {
    const cmd = interaction.commandName;
    const member = await interaction.guild.members.fetch(interaction.user.id);

    if (cmd === "add") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const row = stmtGetByChannel.get(interaction.channel.id);
      if (!row) return interaction.editReply({ content: t("errors.not_ticket") });
      if (!can(member, cfg.claimRoleId)) return interaction.editReply({ content: t("errors.no_perm") });
      const user = interaction.options.getUser("user", true);
      await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
      stmtLog.run(row.id, now(), "add", member.id, user.id);
      await interaction.channel.send(`➕ تمت إضافة <@${user.id}> إلى التذكرة`);
      return interaction.editReply({ content: "✅" });
    }

    if (cmd === "remove") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const row = stmtGetByChannel.get(interaction.channel.id);
      if (!row) return interaction.editReply({ content: t("errors.not_ticket") });
      if (!can(member, cfg.claimRoleId)) return interaction.editReply({ content: t("errors.no_perm") });
      const user = interaction.options.getUser("user", true);
      await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: false, SendMessages: false });
      stmtLog.run(row.id, now(), "remove", member.id, user.id);
      await interaction.channel.send(`➖ تمت إزالة <@${user.id}> من التذكرة`);
      return interaction.editReply({ content: "✅" });
    }

    if (cmd === "move") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const row = stmtGetByChannel.get(interaction.channel.id);
      if (!row) return interaction.editReply({ content: t("errors.not_ticket") });
      if (!can(member, cfg.claimRoleId)) return interaction.editReply({ content: t("errors.no_perm") });
      const type = interaction.options.getString("type", true);
      const newRole = (cfg.typeRoleIds || {})[type] || cfg.supportTeamRoleId;

      for (const rId of Object.values(cfg.typeRoleIds || {})) {
        try { await interaction.channel.permissionOverwrites.edit(rId, { ViewChannel: false }); } catch { }
      }
      await interaction.channel.permissionOverwrites.edit(newRole, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true }).catch(() => { });
      await interaction.channel.setName(interaction.channel.name.replace(/^ticket-\w+/, `ticket-${type}`)).catch(() => { });

      row.type = type; row.state = "waiting_staff"; stmtUpdate.run(row);
      stmtLog.run(row.id, now(), "move", member.id, type);
      await interaction.channel.send(`🔁 تم نقل التذكرة إلى **${type}** <@&${newRole}>`);
      return interaction.editReply({ content: "✅" });
    }

    if (cmd === "note") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const row = stmtGetByChannel.get(interaction.channel.id);
      if (!row) return interaction.editReply({ content: t("errors.not_ticket") });
      if (!can(member, cfg.claimRoleId)) return interaction.editReply({ content: t("errors.no_perm") });
      const text = interaction.options.getString("text", true);
      stmtLog.run(row.id, now(), "note", member.id, text);
      await interaction.channel.send({
        embeds: [new EmbedBuilder().setTitle("📝 Staff Note").setDescription(text).setColor("#9b59b6").setFooter({ text: `by ${interaction.user.tag}` })]
      });
      return interaction.editReply({ content: "✅" });
    }

    if (cmd === "stats") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const e = new EmbedBuilder().setTitle(t("stats.title"))
        .addFields(
          { name: t("stats.total"), value: String(stmtStats.total.get().n), inline: true },
          { name: t("stats.open"), value: String(stmtStats.open.get().n), inline: true },
          { name: t("stats.closed"), value: String(stmtStats.closed.get().n), inline: true },
          { name: t("stats.claimed"), value: String(stmtStats.claimed.get().n), inline: true }
        ).setColor("#2f3136");
      return interaction.editReply({ embeds: [e] });
    }
  }
});

// helpers
function makeWelcome(type, a, b) {
  const lines = {
    support: `👋 اهلاً بك حتى نساعدك بسرعة\n• وصف المشكلة  ${a}\n• أدلة او روابط  ${b || "—"}`,
    billing: `💳 تذكرة فواتير\n• رقم الفاتورة  ${a}\n• التفاصيل  ${b || "—"}`,
    technical: `🛠️ تذكرة تقنية\n• البيئة او النظام  ${a}\n• الوصف  ${b || "—"}`,
    partnership: `🤝 تذكرة شراكة\n• رابط او معلومات السيرفر  ${a}\n• العرض  ${b || "—"}`,
    report: `🚨 تذكرة بلاغ\n• المُبلَّغ عنه  ${a}\n• التفاصيل او الأدلة  ${b || "—"}`
  };
  return lines[type] || "مرحبا بك";
}
async function resetControls(channel, isClosed) {
  await channel.send({ components: controlButtons(isClosed) }).catch(() => { });
}
async function doClose(interaction, row, byMember, reason) {
  row.status = "closed"; row.closedAt = now();
  stmtUpdate.run(row);
  stmtLog.run(row.id, now(), "close", byMember.id, reason);

  await interaction.channel.permissionOverwrites.edit(row.userId, { ViewChannel: false, SendMessages: false }).catch(() => { });
  await interaction.channel.setName(`${interaction.channel.name}-closed`).catch(() => { });
  if (cfg.archiveCategoryId) await interaction.channel.setParent(cfg.archiveCategoryId).catch(() => { });
  await interaction.message?.edit({ components: controlButtons(true) }).catch(() => { });

  const msgs = await interaction.channel.messages.fetch({ limit: 200 }).catch(() => null);
  let html = `<!doctype html><meta charset="utf-8"><title>Transcript ${row.id}</title><style>body{font-family:ui-sans-serif,system-ui,Segoe UI;max-width:900px;margin:20px auto;padding:10px} .m{margin:8px 0;padding:8px;border:1px solid #ddd;border-radius:8px} .h{color:#666;font-size:12px}</style><h2>Transcript ${row.id}</h2>`;
  if (msgs) {
    const sorted = [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const m of sorted) {
      const time = new Date(m.createdTimestamp).toISOString();
      const author = esc(m.author?.tag || m.author?.id);
      const content = esc(m.cleanContent || "");
      const attaches = m.attachments?.size ? [...m.attachments.values()].map(a => `<div><a href="${esc(a.url)}">${esc(a.name)}</a></div>`).join("") : "";
      html += `<div class="m"><div class="h">[${time}] ${author}</div><div>${content || "<i>—</i>"}${attaches}</div></div>`;
    }
  }
  const path = `./transcript-${row.id}.html`;
  try { fs.writeFileSync(path, html); } catch {}

  const logCh = await client.channels.fetch(cfg.logChannelId).catch(() => null);
  if (logCh) {
    const e = new EmbedBuilder().setTitle(t("ticket.closed")).setDescription(`${t("ticket.id")} **${row.id}**\n${t("ticket.archived")}`).setColor("#e74c3c");
    await logCh.send({ embeds: [e], files: [path] }).catch(() => { });
  }
  try { fs.unlinkSync(path); } catch {}

  if (cfg.dmOnClose) {
    const user = await client.users.fetch(row.userId).catch(() => null);
    if (user) user.send(t("dm.closed", { id: row.id })).catch(() => { });
  }
}

// auto close idle
async function autoCloseIdle() {
  const hrs = Number(cfg.idleAutoCloseHours || 0);
  if (!hrs) return;
  const cutoff = now() - hrs * 3600000;
  const rows = db.prepare(`SELECT * FROM tickets WHERE status='open' AND COALESCE(lastActivityAt, createdAt) < ?`).all(cutoff);
  for (const row of rows) {
    const ch = await client.channels.fetch(row.channelId).catch(() => null);
    if (!ch) {
      row.status = "closed"; row.closedAt = now();
      stmtUpdate.run(row);
      stmtLog.run(row.id, now(), "auto-close-idle", client.user.id, "");
      continue;
    }
    await ch.send({ embeds: [ new EmbedBuilder().setTitle("🟠 Auto Close").setDescription(`Idle > ${hrs}h`).setColor("#e67e22") ] });
    await doClose({ channel: ch, message: null }, row, { id: client.user.id }, "Auto close idle");
  }
}

// weekly report
async function weeklyReportTick() {
  const day = (cfg.weeklyReport?.day ?? 0);
  const hour = (cfg.weeklyReport?.hour ?? 20);
  const d = new Date();
  if (d.getUTCDay() !== day) return;
  if (d.getUTCHours() !== hour) return;
  if (weeklyReportTick.didRunAt === `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${hour}`) return;
  weeklyReportTick.didRunAt = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${hour}`;

  const since = d.getTime() - 7 * 24 * 3600000;
  const opened = db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE createdAt >= ?`).get(since).n;
  const closed = db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE closedAt IS NOT NULL AND closedAt >= ?`).get(since).n;
  const avgMs = db.prepare(`SELECT AVG(closedAt - createdAt) AS a FROM tickets WHERE closedAt IS NOT NULL AND closedAt >= ?`).get(since).a || 0;
  const e = new EmbedBuilder()
    .setTitle(t("weekly.title"))
    .addFields(
      { name: t("weekly.opened"), value: String(opened), inline: true },
      { name: t("weekly.closed"), value: String(closed), inline: true },
      { name: t("weekly.avg_time"), value: fmtH(avgMs), inline: true }
    ).setColor("#1abc9c");
  const ch = await client.channels.fetch(cfg.weeklyReportChannelId).catch(() => null);
  if (ch) ch.send({ embeds: [e] });
}

client.login(cfg.token);
