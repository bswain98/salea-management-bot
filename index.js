// index.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType
} = require('discord.js');

const {
  getGuildConfig,
  updateGuildConfig,
  createTicket,
  listTickets,
  getTicketByChannel,
  closeTicketByChannel,
  createApplication,
  listApplications,
  getApplicationById,
  decideApplication,
  clockIn,
  clockOut,
  getOpenSessions
} = require('./storage');

// ------------------------
// ENV
// ------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 10000;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
  console.error('❌ DISCORD_TOKEN, DISCORD_CLIENT_ID, and DISCORD_CLIENT_SECRET must be set.');
  process.exit(1);
}

// ------------------------
// Discord client
// ------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

// Utility
function msToHuman(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.length ? parts.join(' ') : '0m';
}

function getRangeStart(range) {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  if (range === 'today') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today.getTime();
  } else if (range === 'week') {
    return now - 7 * oneDay;
  } else if (range === 'month') {
    return now - 30 * oneDay;
  }
  return 0;
}

// ------------------------
// Slash commands
// ------------------------
const slashCommands = [
  // clock
  {
    name: 'clock',
    description: 'Clock in, clock out, or check status.',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'in',
        description: 'Clock in for duty.',
        options: [
          {
            type: 3, // STRING
            name: 'types',
            description: 'Comma-separated clock types (e.g. patrol,cid)',
            required: true
          }
        ]
      },
      {
        type: 1,
        name: 'out',
        description: 'Clock out of duty.'
      },
      {
        type: 1,
        name: 'status',
        description: 'Check your current duty status.'
      }
    ]
  },
  // simple ticket close
  {
    name: 'ticket',
    description: 'Manage tickets.',
    options: [
      {
        type: 1,
        name: 'close',
        description: 'Close this ticket channel.'
      }
    ]
  },
  // application approve/deny by ID
  {
    name: 'app',
    description: 'Manage applications.',
    options: [
      {
        type: 1,
        name: 'approve',
        description: 'Approve an application by ID.',
        options: [
          {
            type: 3,
            name: 'id',
            description: 'Application ID',
            required: true
          }
        ]
      },
      {
        type: 1,
        name: 'deny',
        description: 'Deny an application by ID.',
        options: [
          {
            type: 3,
            name: 'id',
            description: 'Application ID',
            required: true
          },
          {
            type: 3,
            name: 'reason',
            description: 'Reason for denial.',
            required: true
          }
        ]
      }
    ]
  }
];

// ------------------------
// Duty board per guild
// ------------------------
const dutyBoardMessageIds = new Map(); // guildId -> messageId

async function updateDutyBoard(guild) {
  const cfg = getGuildConfig(guild.id);
  const channelId = cfg.clockStatusChannelId;
  if (!channelId) return;

  let channel;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch {
    console.warn(`[DutyBoard] Channel not found for guild ${guild.id}`);
    return;
  }
  if (!channel || !channel.isTextBased()) return;

  const sessions = getOpenSessions(guild.id);
  let content;

  if (!sessions || sessions.length === 0) {
    content = '📋 **On Duty Board**\nNo one is currently clocked in.';
  } else {
    const lines = sessions.map(s => {
      const startedUnix = Math.floor(s.clockIn / 1000);
      const elapsed = msToHuman(Date.now() - s.clockIn);
      const typesText = (s.clockTypes || []).join(', ') || 'N/A';
      return `• <@${s.userId}> – **${typesText}** – since <t:${startedUnix}:R> (**${elapsed}**)`;
    });
    content = '📋 **On Duty Board**\n' + lines.join('\n');
  }

  const existingId = dutyBoardMessageIds.get(guild.id);
  if (existingId) {
    try {
      const msg = await channel.messages.fetch(existingId);
      await msg.edit(content);
      return;
    } catch {
      // fall through to send new
    }
  }

  const newMsg = await channel.send(content);
  dutyBoardMessageIds.set(guild.id, newMsg.id);
}

// ------------------------
// Discord events
// ------------------------
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log('🔁 Registering slash commands globally...');
    await rest.put(
      Routes.applicationCommands(readyClient.user.id),
      { body: slashCommands }
    );
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Error registering slash commands:', err);
  }

  // Initialize duty boards for all guilds
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await updateDutyBoard(guild);
    } catch (err) {
      console.error(`[DutyBoard] Failed for guild ${guildId}:`, err);
    }
  }
});

// Interaction handling (slash, buttons, modals)
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // ---- /clock ----
    if (commandName === 'clock') {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      const userId = interaction.user.id;
      const cfg = getGuildConfig(guildId);
      const member = await interaction.guild.members.fetch(userId);

      if (sub === 'in') {
        const typesRaw = interaction.options.getString('types');
        const typeKeys = typesRaw.split(',').map(s => s.trim()).filter(Boolean);

        if (typeKeys.length === 0) {
          return interaction.reply({ content: '❌ Provide at least one clock type.', ephemeral: true });
        }

        const knownKeys = new Set((cfg.clockTypes || []).map(ct => ct.key));
        const invalid = typeKeys.filter(k => !knownKeys.has(k));
        if (invalid.length > 0) {
          return interaction.reply({
            content: `❌ Unknown clock type(s): \`${invalid.join(', ')}\`.\nConfigured types: \`${Array.from(knownKeys).join(', ') || 'none'}\`.`,
            ephemeral: true
          });
        }

        const session = clockIn(guildId, userId, typeKeys);

        // Add on-duty role + any configured addRoleIds
        if (cfg.onDutyRoleId) {
          await member.roles.add(cfg.onDutyRoleId).catch(() => {});
        }
        for (const ct of cfg.clockTypes || []) {
          if (typeKeys.includes(ct.key)) {
            for (const rId of (ct.addRoleIds || [])) {
              await member.roles.add(rId).catch(() => {});
            }
          }
        }

        await updateDutyBoard(interaction.guild);

        return interaction.reply({
          content: `✅ Clocked in as **${typeKeys.join(', ')}**.`,
          ephemeral: true
        });
      }

      if (sub === 'out') {
        const session = clockOut(guildId, userId);
        if (!session) {
          return interaction.reply({ content: '⚠️ You are not clocked in.', ephemeral: true });
        }

        // Remove on-duty role + removeRoleIdsOnOut
        if (cfg.onDutyRoleId) {
          await member.roles.remove(cfg.onDutyRoleId).catch(() => {});
        }
        for (const ct of cfg.clockTypes || []) {
          if ((session.clockTypes || []).includes(ct.key)) {
            for (const rId of (ct.removeRoleIdsOnOut || [])) {
              await member.roles.remove(rId).catch(() => {});
            }
          }
        }

        await updateDutyBoard(interaction.guild);

        const duration = msToHuman(session.clockOut - session.clockIn);
        return interaction.reply({
          content: `✅ Clocked out. Session duration: **${duration}**.`,
          ephemeral: true
        });
      }

      if (sub === 'status') {
        const open = getOpenSessions(guildId).find(s => s.userId === userId);
        if (!open) {
          return interaction.reply({ content: 'ℹ️ You are not currently clocked in.', ephemeral: true });
        }
        const elapsed = msToHuman(Date.now() - open.clockIn);
        return interaction.reply({
          content: `⏱️ You are clocked in as **${(open.clockTypes || []).join(', ')}** for **${elapsed}**.`,
          ephemeral: true
        });
      }
    }

    // ---- /ticket ----
    if (commandName === 'ticket') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'close') {
        const guildId = interaction.guildId;
        const channel = interaction.channel;

        const ticket = closeTicketByChannel(guildId, channel.id);
        if (!ticket) {
          return interaction.reply({ content: '⚠️ This channel does not appear to be an open ticket.', ephemeral: true });
        }

        await interaction.reply({ content: '✅ Ticket closed. Channel will be deleted in 5 seconds.' });
        setTimeout(() => {
          channel.delete('Ticket closed via /ticket close').catch(() => {});
        }, 5000);
      }
    }

    // ---- /app ----
    if (commandName === 'app') {
      const sub = interaction.options.getSubcommand();
      const appId = interaction.options.getString('id');
      const app = getApplicationById(appId);
      if (!app) {
        return interaction.reply({ content: '❌ Application not found.', ephemeral: true });
      }

      const guildId = interaction.guildId;
      const cfg = getGuildConfig(guildId);
      const appType = (cfg.applicationTypes || []).find(t => t.key === app.typeKey);

      const guild = interaction.guild;
      const member = await guild.members.fetch(app.userId).catch(() => null);

      if (sub === 'approve') {
        decideApplication(appId, 'approved', interaction.user.id);

        if (member && appType) {
          for (const addId of (appType.addRoleIds || [])) {
            await member.roles.add(addId).catch(() => {});
          }
          for (const remId of (appType.removeRoleIds || [])) {
            await member.roles.remove(remId).catch(() => {});
          }
        }

        if (member) {
          member.send(`✅ Your application (**${appType?.label || app.typeKey}**) in **${guild.name}** has been **approved**.`).catch(() => {});
        }

        return interaction.reply({ content: `✅ Approved application \`${appId}\`.`, ephemeral: true });
      }

      if (sub === 'deny') {
        const reason = interaction.options.getString('reason');
        decideApplication(appId, 'denied', interaction.user.id);

        if (member) {
          member.send(
            `❌ Your application (**${appType?.label || app.typeKey}**) in **${guild.name}** has been **denied**.\nReason: ${reason}`
          ).catch(() => {});
        }

        return interaction.reply({ content: `✅ Denied application \`${appId}\`.`, ephemeral: true });
      }
    }
  }

  // ---- Buttons ----
  if (interaction.isButton()) {
    const [kind, payload] = interaction.customId.split(':');

    // Ticket panel: open ticket modal
    if (kind === 'ticket_open') {
      const guildId = interaction.guildId;
      const cfg = getGuildConfig(guildId);
      const ticketType = (cfg.ticketTypes || []).find(t => t.key === payload);
      if (!ticketType) {
        return interaction.reply({ content: '❌ Ticket type not configured.', ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId(`ticket_modal:${ticketType.key}`)
        .setTitle(ticketType.label);

      const subjectInput = new TextInputBuilder()
        .setCustomId('subject')
        .setLabel('Subject')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const bodyInput = new TextInputBuilder()
        .setCustomId('body')
        .setLabel('Describe the issue')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(subjectInput),
        new ActionRowBuilder().addComponents(bodyInput)
      );

      return interaction.showModal(modal);
    }

    // Application panel: open application modal
    if (kind === 'app_open') {
      const guildId = interaction.guildId;
      const cfg = getGuildConfig(guildId);
      const appType = (cfg.applicationTypes || []).find(t => t.key === payload);
      if (!appType) {
        return interaction.reply({ content: '❌ Application type not configured.', ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId(`app_modal:${appType.key}`)
        .setTitle(appType.label);

      const questions = appType.questions || [];
      const rows = [];

      questions.slice(0, 5).forEach((q, idx) => {
        const input = new TextInputBuilder()
          .setCustomId(`q_${idx}`)
          .setLabel(q)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);
        rows.push(new ActionRowBuilder().addComponents(input));
      });

      if (rows.length === 0) {
        const fallback = new TextInputBuilder()
          .setCustomId('q_0')
          .setLabel('Tell us about yourself.')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);
        rows.push(new ActionRowBuilder().addComponents(fallback));
      }

      modal.addComponents(...rows);

      return interaction.showModal(modal);
    }
  }

  // ---- Modals ----
  if (interaction.isModalSubmit()) {
    const [kind, payload] = interaction.customId.split(':');

    // Ticket modal submit
    if (kind === 'ticket_modal') {
      const guildId = interaction.guildId;
      const cfg = getGuildConfig(guildId);
      const type = (cfg.ticketTypes || []).find(t => t.key === payload);
      if (!type) {
        return interaction.reply({ content: '❌ Ticket type not configured.', ephemeral: true });
      }

      const subject = interaction.fields.getTextInputValue('subject');
      const body = interaction.fields.getTextInputValue('body');
      const guild = interaction.guild;

      // create ticket channel
      const baseName = `${payload}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, '');
      const channelName = baseName || `ticket-${payload}`;

      const overwrites = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory
          ]
        }
      ];

      // allow configured admin roles
      for (const rId of (cfg.adminRoleIds || [])) {
        overwrites.push({
          id: rId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels
          ]
        });
      }

      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        permissionOverwrites: overwrites,
        topic: `Ticket (${type.label}) for ${interaction.user.tag} — ${subject}`
      });

      const ticket = createTicket({
        guildId,
        channelId: channel.id,
        userId: interaction.user.id,
        type: type.key,
        subject,
        body
      });

      // ping roles if any
      const pingText = (type.pingRoleIds || [])
        .map(id => `<@&${id}>`)
        .join(' ');

      const embed = new EmbedBuilder()
        .setTitle(`Ticket: ${type.label}`)
        .setDescription(body)
        .addFields(
          { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: false },
          { name: 'Subject', value: subject, inline: false },
          { name: 'Ticket ID', value: ticket.id, inline: false }
        )
        .setColor(0x3b82f6)
        .setTimestamp(new Date(ticket.createdAt));

      await channel.send({
        content: pingText || 'New ticket created.',
        embeds: [embed]
      });

      return interaction.reply({
        content: `✅ Ticket created: ${channel}`,
        ephemeral: true
      });
    }

    // Application modal submit
    if (kind === 'app_modal') {
      const guildId = interaction.guildId;
      const cfg = getGuildConfig(guildId);
      const appType = (cfg.applicationTypes || []).find(t => t.key === payload);
      if (!appType) {
        return interaction.reply({ content: '❌ Application type not configured.', ephemeral: true });
      }

      const qLabels = appType.questions || ['Response'];
      const answers = [];

      qLabels.slice(0, 5).forEach((label, idx) => {
        const key = `q_${idx}`;
        const value = interaction.fields.getTextInputValue(key);
        answers.push({ label, value });
      });

      const app = createApplication({
        guildId,
        userId: interaction.user.id,
        typeKey: appType.key,
        answers
      });

      // log in applications channel if configured
      if (cfg.applicationPanelChannelId) {
        try {
          const ch = await client.channels.fetch(cfg.applicationPanelChannelId);
          if (ch && ch.isTextBased()) {
            const ping = (appType.pingRoleIds || []).map(id => `<@&${id}>`).join(' ');
            const embed = new EmbedBuilder()
              .setTitle(`Application — ${appType.label}`)
              .setDescription(`New application from <@${interaction.user.id}>`)
              .addFields(
                answers.map(a => ({
                  name: a.label,
                  value: a.value || 'N/A',
                  inline: false
                }))
              )
              .setFooter({ text: `Application ID: ${app.id}` })
              .setTimestamp(new Date(app.createdAt))
              .setColor(0x22c55e);

            await ch.send({
              content: ping || 'New application received.',
              embeds: [embed]
            });
          }
        } catch (err) {
          console.error('Error logging application:', err);
        }
      }

      return interaction.reply({
        content: `✅ Your application for **${appType.label}** has been submitted. Application ID: \`${app.id}\``,
        ephemeral: true
      });
    }
  }
});

// ------------------------
// Express + admin panel
// ------------------------
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Passport (Discord OAuth)
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy(
  {
    clientID: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/auth/discord/callback`,
    scope: ['identify', 'guilds']
  },
  (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
  }
));

// Auth routes
app.get('/auth/discord', passport.authenticate('discord'));
app.get(
  '/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/auth/fail' }),
  (req, res) => {
    res.redirect('/admin');
  }
);
app.get('/auth/fail', (req, res) => {
  res.send('Discord authentication failed.');
});
app.get('/logout', (req, res) => {
  req.logout(() => {});
  req.session.destroy(() => {});
  res.redirect('/');
});

// Middleware
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/auth/discord');
}

async function getGuildAndMember(guildId, userId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { guild: null, member: null };
  let member = null;
  try {
    member = await guild.members.fetch(userId);
  } catch {
    member = null;
  }
  return { guild, member };
}

async function ensureGuildAdmin(req, res, next) {
  const guildId = req.params.guildId;
  const { guild, member } = await getGuildAndMember(guildId, req.user.id);
  if (!guild || !member) {
    return res.status(403).send('You are not in this guild.');
  }

  const cfg = getGuildConfig(guildId);
  const hasAdminRole = (cfg.adminRoleIds || []).some(rid => member.roles.cache.has(rid));
  const hasManageGuild = member.permissions.has(PermissionFlagsBits.ManageGuild);

  if (!hasAdminRole && !hasManageGuild) {
    return res.status(403).send('You do not have admin access for this guild in the panel.');
  }

  req.guild = guild;
  req.guildConfig = cfg;
  req.guildMember = member;
  next();
}

// ------------------------
// Admin routes
// ------------------------
app.get('/', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.redirect('/admin');
  }
  return res.redirect('/auth/discord');
});

// Admin panel (protected by Discord OAuth)
app.get('/admin', ensureAuthenticated, async (req, res) => {
  try {
    // Build a simple list of guilds the bot is in
    const guilds = Array.from(client.guilds.cache.values()).map(g => ({
      id: g.id,
      name: g.name,
    }));

    const guildCount = guilds.length;

    return res.render('admin/home', {
      user: req.user || null,
      guildCount,
      guilds,
    });
  } catch (err) {
    console.error('❌ Error in /admin route:', err);
    return res.status(500).send('Admin error – check server logs.');
  }
});


// Guild dashboard
app.get('/admin/guild/:guildId', ensureAuth, ensureGuildAdmin, (req, res) => {
  const guild = req.guild;
  const cfg = req.guildConfig;

  const onDutySessions = getOpenSessions(guild.id);
  const stats = {
    onDutyCount: onDutySessions.length,
    openTickets: listTickets(guild.id, { status: 'open' }).length,
    pendingApplications: listApplications(guild.id, { status: 'pending' }).length
  };

  const onDuty = onDutySessions.map(s => ({
    userId: s.userId,
    clockTypes: s.clockTypes || [],
    clockIn: s.clockIn,
    elapsedHuman: msToHuman(Date.now() - s.clockIn)
  }));

  const recentTickets = listTickets(guild.id).slice(-10).reverse();
  const recentApps = listApplications(guild.id).slice(-10).reverse();

  res.render('admin/guild_dashboard', {
    title: `${guild.name} — Dashboard`,
    user: req.user,
    activeGuild: { id: guild.id, name: guild.name },
    activeTab: 'dashboard',
    stats,
    onDuty,
    recentTickets,
    recentApps
  });
});

// Guild config (GET)
app.get('/admin/guild/:guildId/config', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const guild = req.guild;
  const cfg = req.guildConfig;

  const roles = (await guild.roles.fetch()).map(r => ({
    id: r.id,
    name: r.name
  }));

  const channels = guild.channels.cache
    .filter(ch => ch.type === ChannelType.GuildText)
    .map(ch => ({
      id: ch.id,
      name: ch.name,
      type: ch.type
    }));

  res.render('admin/guild_config', {
    title: `${guild.name} — Configuration`,
    user: req.user,
    activeGuild: { id: guild.id, name: guild.name },
    activeTab: 'config',
    config: cfg,
    roles,
    channels,
    ticketTypesJson: JSON.stringify(cfg.ticketTypes || [], null, 2),
    applicationTypesJson: JSON.stringify(cfg.applicationTypes || [], null, 2),
    clockTypesJson: JSON.stringify(cfg.clockTypes || [], null, 2)
  });
});

// Helper to normalize multi-select fields
function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

// Guild config (POST)
app.post('/admin/guild/:guildId/config', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const guild = req.guild;
  const cfg = req.guildConfig;
  const body = req.body;

  const adminRoleIds = toArray(body.adminRoleIds).filter(Boolean);
  const onDutyRoleId = body.onDutyRoleId || null;
  const clockStatusChannelId = body.clockStatusChannelId || null;
  const ticketPanelChannelId = body.ticketPanelChannelId || null;
  const applicationPanelChannelId = body.applicationPanelChannelId || null;

  let ticketTypes = cfg.ticketTypes || [];
  let applicationTypes = cfg.applicationTypes || [];
  let clockTypes = cfg.clockTypes || [];

  if (body.ticketTypesJson) {
    try {
      const parsed = JSON.parse(body.ticketTypesJson);
      if (Array.isArray(parsed)) ticketTypes = parsed;
    } catch (err) {
      console.error('Invalid ticketTypesJson:', err);
    }
  }

  if (body.applicationTypesJson) {
    try {
      const parsed = JSON.parse(body.applicationTypesJson);
      if (Array.isArray(parsed)) applicationTypes = parsed;
    } catch (err) {
      console.error('Invalid applicationTypesJson:', err);
    }
  }

  if (body.clockTypesJson) {
    try {
      const parsed = JSON.parse(body.clockTypesJson);
      if (Array.isArray(parsed)) clockTypes = parsed;
    } catch (err) {
      console.error('Invalid clockTypesJson:', err);
    }
  }

  updateGuildConfig(guild.id, {
    name: guild.name,
    adminRoleIds,
    onDutyRoleId,
    clockStatusChannelId,
    ticketPanelChannelId,
    applicationPanelChannelId,
    ticketTypes,
    applicationTypes,
    clockTypes
  });

  res.redirect(`/admin/guild/${guild.id}/config`);
});

// POST panels from admin (auto-post panels)
app.post('/admin/guild/:guildId/panels/post', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const guild = req.guild;
  const cfg = getGuildConfig(guild.id);

  // Ticket panel
  if (cfg.ticketPanelChannelId && (cfg.ticketTypes || []).length > 0) {
    try {
      const ch = await guild.channels.fetch(cfg.ticketPanelChannelId);
      if (ch && ch.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle('Support Tickets')
          .setDescription('Click a button below to open a ticket.')
          .setColor(0x3b82f6);

        const buttons = (cfg.ticketTypes || []).map(t =>
          new ButtonBuilder()
            .setCustomId(`ticket_open:${t.key}`)
            .setLabel(t.label || t.key)
            .setStyle(ButtonStyle.Primary)
        );

        const rows = [];
        for (let i = 0; i < buttons.length; i += 5) {
          rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
        }

        const msg = await ch.send({ embeds: [embed], components: rows });
        cfg.ticketPanelMessageId = msg.id;
      }
    } catch (err) {
      console.error('Error posting ticket panel:', err);
    }
  }

  // Application panel
  if (cfg.applicationPanelChannelId && (cfg.applicationTypes || []).length > 0) {
    try {
      const ch = await guild.channels.fetch(cfg.applicationPanelChannelId);
      if (ch && ch.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle('Applications')
          .setDescription('Click a button below to submit an application.')
          .setColor(0x22c55e);

        const buttons = (cfg.applicationTypes || []).map(t =>
          new ButtonBuilder()
            .setCustomId(`app_open:${t.key}`)
            .setLabel(t.label || t.key)
            .setStyle(ButtonStyle.Secondary)
        );

        const rows = [];
        for (let i = 0; i < buttons.length; i += 5) {
          rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
        }

        const msg = await ch.send({ embeds: [embed], components: rows });
        cfg.applicationPanelMessageId = msg.id;
      }
    } catch (err) {
      console.error('Error posting application panel:', err);
    }
  }

  // Save back any updated message IDs
  updateGuildConfig(guild.id, cfg);

  res.redirect(`/admin/guild/${guild.id}`);
});

// Tickets list
app.get('/admin/guild/:guildId/tickets', ensureAuth, ensureGuildAdmin, (req, res) => {
  const guild = req.guild;
  const status = req.query.status || null;
  const tickets = listTickets(guild.id, status ? { status } : {});

  res.render('admin/tickets', {
    title: `${guild.name} — Tickets`,
    user: req.user,
    activeGuild: { id: guild.id, name: guild.name },
    activeTab: 'tickets',
    tickets,
    filterStatus: status
  });
});

// Applications list
app.get('/admin/guild/:guildId/applications', ensureAuth, ensureGuildAdmin, (req, res) => {
  const guild = req.guild;
  const status = req.query.status || 'pending';
  const apps = listApplications(guild.id, status ? { status } : {});

  res.render('admin/applications', {
    title: `${guild.name} — Applications`,
    user: req.user,
    activeGuild: { id: guild.id, name: guild.name },
    activeTab: 'applications',
    applications: apps,
    filterStatus: status
  });
});

// ------------------------
// Start HTTP + Discord
// ------------------------
app.listen(PORT, () => {
  console.log(`🌐 Admin dashboard listening on port ${PORT}`);
  console.log(`🌐 Using Discord OAuth callback URL: ${BASE_URL}/auth/discord/callback`);
});

client.login(DISCORD_TOKEN);

