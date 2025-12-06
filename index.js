// index.js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const bodyParser = require('body-parser');

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const {
  getGuildConfig,
  updateGuildConfig,
  createTicket,
  getTicketByChannel,
  getTicketById,
  closeTicket,
  listTickets,
  createApplication,
  getApplicationById,
  listApplications,
  decideApplication,
  clockIn,
  clockOut,
  getOpenSessions,
  getUserSessionsInRange,
  getSessionsInRange,
  addGlobalBan,
  removeGlobalBan,
  isGloballyBanned,
  listGlobalBans
} = require('./storage');

// ---------------------------
// ENV + constants
// ---------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'salea-secret';
const BASE_URL = process.env.BASE_URL || 'https://salea-management-bot.onrender.com';

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
  console.error('❌ Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_CLIENT_SECRET env vars.');
  process.exit(1);
}

const CALLBACK_URL = `${BASE_URL.replace(/\/+$/, '')}/auth/discord/callback`;
console.log('🌐 Using Discord OAuth callback URL:', CALLBACK_URL);

// ---------------------------
// Discord client
// ---------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

// ---------------------------
// Slash commands
// ---------------------------
const commands = [
  // Clock commands
  new SlashCommandBuilder()
    .setName('clock')
    .setDescription('Clock in/out and view duty status.')
    .addSubcommand(sub =>
      sub
        .setName('in')
        .setDescription('Clock in.')
        .addStringOption(opt =>
          opt
            .setName('types')
            .setDescription('Comma-separated clock types (keys) configured in admin panel.')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('out').setDescription('Clock out.')
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('View your current duty status.')
    ),

  // Ticket commands
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Manage tickets.')
    .addSubcommand(sub =>
      sub
        .setName('close')
        .setDescription('Close this ticket.')
    ),

  // Application commands
  new SlashCommandBuilder()
    .setName('app')
    .setDescription('Manage applications.')
    .addSubcommand(sub =>
      sub
        .setName('approve')
        .setDescription('Approve an application.')
        .addStringOption(opt =>
          opt
            .setName('id')
            .setDescription('Application ID.')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('deny')
        .setDescription('Deny an application.')
        .addStringOption(opt =>
          opt
            .setName('id')
            .setDescription('Application ID.')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('reason')
            .setDescription('Reason for denial.')
            .setRequired(true)
        )
    ),

  // Moderation / global bans
  new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Moderation commands.')
    .addSubcommand(sub =>
      sub
        .setName('gban')
        .setDescription('Globally ban a user from all guilds using this bot.')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('User to ban.')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('reason')
            .setDescription('Reason.')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('ungban')
        .setDescription('Remove a user from global ban list.')
        .addStringOption(opt =>
          opt
            .setName('userid')
            .setDescription('User ID to unban.')
            .setRequired(true)
        )
    )
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  // Register as global application commands
  await rest.put(
    Routes.applicationCommands(DISCORD_CLIENT_ID),
    { body: commands }
  );

  console.log('✅ Slash commands registered globally.');
}

// ---------------------------
// Utility
// ---------------------------
function msToHuman(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours <= 0 && minutes <= 0) return '0m';
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

function isAdmin(member, guildConfig) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (!guildConfig || !guildConfig.adminRoleIds) return false;
  return guildConfig.adminRoleIds.some(id => member.roles.cache.has(id));
}

async function updateDutyBoardForGuild(guild) {
  const cfg = getGuildConfig(guild.id);
  if (!cfg.clockStatusChannelId) return;

  const channel = await guild.channels.fetch(cfg.clockStatusChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const sessions = getOpenSessions(guild.id);
  if (sessions.length === 0) {
    await channel.send('📋 **On Duty Board**\nNo one is currently on duty.').catch(() => {});
    return;
  }

  const lines = await Promise.all(
    sessions.map(async s => {
      const user = await guild.members.fetch(s.userId).catch(() => null);
      const name = user ? user.displayName : s.userId;
      const started = `<t:${Math.floor(s.clockIn / 1000)}:R>`;
      const elapsed = msToHuman(Date.now() - s.clockIn);
      return `• **${name}** (<@${s.userId}>) – ${s.clockTypes.join(', ')} – on since ${started} (**${elapsed}**)`;
    })
  );

  const content = '📋 **On Duty Board**\n' + lines.join('\n');
  await channel.send(content).catch(() => {});
}

// ---------------------------
// Discord events
// ---------------------------
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('❌ Error registering commands:', err);
  }

  // Initialize guild configs
  client.guilds.cache.forEach(guild => {
    const cfg = getGuildConfig(guild.id);
    if (!cfg.name) {
      cfg.name = guild.name;
      updateGuildConfig(guild.id, cfg);
    }
  });
});

// Auto-kick globally banned users
client.on('guildMemberAdd', member => {
  if (isGloballyBanned(member.id)) {
    member.kick('Globally banned by SALEA management bot.').catch(() => {});
  }
});

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const guild = interaction.guild;
    if (!guild) return;
    const cfg = getGuildConfig(guild.id);

    // CLOCK
    if (interaction.commandName === 'clock') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'in') {
        const typesRaw = interaction.options.getString('types');
        const keys = typesRaw
          .split(',')
          .map(x => x.trim())
          .filter(Boolean);

        if (keys.length === 0) {
          return interaction.reply({ content: '❌ No clock types specified.', ephemeral: true });
        }

        const knownKeys = cfg.clockTypes.map(ct => ct.key);
        const invalid = keys.filter(k => !knownKeys.includes(k));
        if (invalid.length > 0) {
          return interaction.reply({
            content: `❌ Invalid clock type(s): \`${invalid.join(', ')}\`.\nValid keys: \`${knownKeys.join(', ')}\``,
            ephemeral: true
          });
        }

        const session = clockIn(guild.id, interaction.user.id, keys);

        // role handling
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (member && cfg.onDutyRoleId) {
          await member.roles.add(cfg.onDutyRoleId).catch(() => {});
        }

        await interaction.reply({
          content: `✅ Clocked in as: **${keys.join(', ')}**.`,
          ephemeral: true
        });

        await updateDutyBoardForGuild(guild);
      }

      if (sub === 'out') {
        const session = clockOut(guild.id, interaction.user.id);
        if (!session) {
          return interaction.reply({
            content: '⚠️ You are not currently clocked in.',
            ephemeral: true
          });
        }

        const duration = session.clockOut - session.clockIn;

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (member && cfg.onDutyRoleId) {
          await member.roles.remove(cfg.onDutyRoleId).catch(() => {});
        }

        await interaction.reply({
          content: `✅ Clocked out. Session duration: **${msToHuman(duration)}**.`,
          ephemeral: true
        });

        await updateDutyBoardForGuild(guild);
      }

      if (sub === 'status') {
        const openSessions = getOpenSessions(guild.id).filter(
          s => s.userId === interaction.user.id
        );
        if (openSessions.length === 0) {
          return interaction.reply({
            content: 'ℹ️ You are not currently on duty.',
            ephemeral: true
          });
        }
        const s = openSessions[0];
        const elapsed = msToHuman(Date.now() - s.clockIn);
        return interaction.reply({
          content:
            `⏱️ On duty as: **${s.clockTypes.join(', ')}**\n` +
            `Started: <t:${Math.floor(s.clockIn / 1000)}:R>\n` +
            `Elapsed: **${elapsed}**`,
          ephemeral: true
        });
      }
    }

    // TICKET
    if (interaction.commandName === 'ticket') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'close') {
        const ticket = getTicketByChannel(guild.id, interaction.channelId);
        if (!ticket) {
          return interaction.reply({
            content: '❌ This channel is not registered as a ticket.',
            ephemeral: true
          });
        }

        const member = await guild.members.fetch(interaction.user.id);
        if (!isAdmin(member, cfg)) {
          return interaction.reply({
            content: '❌ You do not have permission to close tickets.',
            ephemeral: true
          });
        }

        closeTicket(ticket.id);

        await interaction.reply('✅ Ticket closed. This channel will be deleted in 5 seconds.');
        setTimeout(() => {
          interaction.channel.delete('Ticket closed').catch(() => {});
        }, 5000);
      }
    }

    // APPLICATIONS
    if (interaction.commandName === 'app') {
      const sub = interaction.options.getSubcommand();
      const member = await guild.members.fetch(interaction.user.id);
      if (!isAdmin(member, cfg)) {
        return interaction.reply({
          content: '❌ You do not have permission to manage applications.',
          ephemeral: true
        });
      }

      if (sub === 'approve') {
        const id = interaction.options.getString('id');
        const app = getApplicationById(id);
        if (!app || app.guildId !== guild.id) {
          return interaction.reply({
            content: '❌ Application not found for this guild.',
            ephemeral: true
          });
        }

        decideApplication(id, 'approved', interaction.user.id);

        const typeCfg = cfg.applicationTypes.find(t => t.key === app.type);
        const targetMember = await guild.members.fetch(app.userId).catch(() => null);

        if (targetMember && typeCfg) {
          if (typeCfg.addRoleIds && typeCfg.addRoleIds.length > 0) {
            await targetMember.roles.add(typeCfg.addRoleIds).catch(() => {});
          }
          if (typeCfg.removeRoleIds && typeCfg.removeRoleIds.length > 0) {
            await targetMember.roles.remove(typeCfg.removeRoleIds).catch(() => {});
          }
        }

        await interaction.reply({
          content: `✅ Application **${id}** approved.`,
          ephemeral: true
        });
      }

      if (sub === 'deny') {
        const id = interaction.options.getString('id');
        const reason = interaction.options.getString('reason');
        const app = getApplicationById(id);
        if (!app || app.guildId !== guild.id) {
          return interaction.reply({
            content: '❌ Application not found for this guild.',
            ephemeral: true
          });
        }

        decideApplication(id, 'denied', interaction.user.id);
        await interaction.reply({
          content: `✅ Application **${id}** denied.\nReason: ${reason}`,
          ephemeral: true
        });
      }
    }

    // MOD / GLOBAL BAN
    if (interaction.commandName === 'mod') {
      const sub = interaction.options.getSubcommand();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!isAdmin(member, cfg)) {
        return interaction.reply({
          content: '❌ You do not have permission to run moderation commands.',
          ephemeral: true
        });
      }

      if (sub === 'gban') {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        addGlobalBan(user.id, reason, interaction.user.id);

        // Kick from all mutual guilds
        client.guilds.cache.forEach(g => {
          g.members.fetch(user.id).then(m => {
            m.kick(`Globally banned: ${reason}`).catch(() => {});
          }).catch(() => {});
        });

        await interaction.reply({
          content: `✅ Globally banned **${user.tag}** (${user.id}).`,
          ephemeral: true
        });
      }

      if (sub === 'ungban') {
        const userId = interaction.options.getString('userid');
        removeGlobalBan(userId);
        await interaction.reply({
          content: `✅ Removed global ban for user ID **${userId}**.`,
          ephemeral: true
        });
      }
    }
  }

  // BUTTONS (Panels)
  if (interaction.isButton()) {
    const parts = interaction.customId.split(':');
    if (parts.length < 3) return;

    const [kind, guildId, typeKey] = parts;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return interaction.reply({ content: '❌ Guild no longer available.', ephemeral: true });
    }
    const cfg = getGuildConfig(guildId);

    // Ticket panel button
    if (kind === 'ticket') {
      const typeCfg = cfg.ticketTypes.find(t => t.key === typeKey);
      if (!typeCfg) {
        return interaction.reply({ content: '❌ Ticket type not configured.', ephemeral: true });
      }

      const baseName = `ticket-${typeKey}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, '');
      const channel = await guild.channels.create({
        name: baseName.substring(0, 90),
        type: ChannelType.GuildText,
        topic: `Ticket type: ${typeCfg.label} | User: ${interaction.user.tag}`
      });

      const ticket = createTicket({
        guildId,
        channelId: channel.id,
        userId: interaction.user.id,
        type: typeKey
      });

      // ping roles
      const pings = (typeCfg.pingRoleIds || []).map(id => `<@&${id}>`).join(' ');

      const embed = new EmbedBuilder()
        .setTitle(`Ticket - ${typeCfg.label}`)
        .setDescription(typeCfg.template || 'A staff member will be with you shortly.')
        .addFields(
          { name: 'User', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Ticket ID', value: ticket.id, inline: true }
        )
        .setTimestamp(new Date());

      await channel.send({
        content: pings || undefined,
        embeds: [embed]
      });

      await interaction.reply({
        content: `✅ Ticket created: ${channel}`,
        ephemeral: true
      });
    }

    // Application panel button
    if (kind === 'app') {
      const typeCfg = cfg.applicationTypes.find(t => t.key === typeKey);
      if (!typeCfg) {
        return interaction.reply({ content: '❌ Application type not configured.', ephemeral: true });
      }

      const app = createApplication({
        guildId,
        userId: interaction.user.id,
        type: typeKey,
        answers: {},
        roleAddIds: typeCfg.addRoleIds || [],
        roleRemoveIds: typeCfg.removeRoleIds || []
      });

      const pingText = (typeCfg.pingRoleIds || []).map(id => `<@&${id}>`).join(' ');

      // Log to app panel channel if configured
      if (cfg.applicationPanelChannelId) {
        const ch = await guild.channels.fetch(cfg.applicationPanelChannelId).catch(() => null);
        if (ch && ch.isTextBased()) {
          const embed = new EmbedBuilder()
            .setTitle(`New Application - ${typeCfg.label}`)
            .setDescription(`User: <@${interaction.user.id}>\nApplication ID: \`${app.id}\``)
            .setTimestamp(new Date());
          await ch.send({ content: pingText || undefined, embeds: [embed] }).catch(() => {});
        }
      }

      await interaction.reply({
        content: `✅ Application **${typeCfg.label}** started.\nA staff member will complete review via the admin panel.`,
        ephemeral: true
      });
    }
  }
});

// ---------------------------
// Express admin backend
// ---------------------------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Passport Discord
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new DiscordStrategy(
    {
      clientID: DISCORD_CLIENT_ID,
      clientSecret: DISCORD_CLIENT_SECRET,
      callbackURL: CALLBACK_URL,
      scope: ['identify', 'guilds']
    },
    (accessToken, refreshToken, profile, done) => {
      const user = {
        id: profile.id,
        username: profile.username,
        guilds: profile.guilds || []
      };
      return done(null, user);
    }
  )
);

// Auth routes
app.get('/auth/discord', passport.authenticate('discord'));

app.get(
  '/auth/discord/callback',
  passport.authenticate('discord', {
    failureRedirect: '/auth/failure'
  }),
  (req, res) => {
    res.redirect('/admin');
  }
);

app.get('/auth/failure', (req, res) => {
  res.status(401).send('Discord authentication failed.');
});

// Middleware
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.redirect('/auth/discord');
}

function canManageGuild(user, guildId) {
  if (!user || !user.guilds) return false;
  const g = user.guilds.find(g => g.id === guildId);
  if (!g) return false;
  const perms = BigInt(g.permissions || '0');
  const ADMINISTRATOR = BigInt(0x0000000000000008);
  return (perms & ADMINISTRATOR) === ADMINISTRATOR;
}

// Static admin UI
app.use('/public', express.static('public'));

// Admin page
app.get('/admin', ensureAuth, (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'admin.html'));
});

// API: current user
app.get('/api/me', ensureAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, guilds: req.user.guilds || [] });
});

// API: list manageable guilds (where user is admin)
app.get('/api/guilds', ensureAuth, (req, res) => {
  const manageable = (req.user.guilds || []).filter(g => {
    const perms = BigInt(g.permissions || '0');
    const ADMINISTRATOR = BigInt(0x0000000000000008);
    return (perms & ADMINISTRATOR) === ADMINISTRATOR;
  });
  res.json(manageable);
});

// API: get guild config
app.get('/api/guilds/:guildId/config', ensureAuth, (req, res) => {
  const guildId = req.params.guildId;
  if (!canManageGuild(req.user, guildId)) return res.status(403).json({ error: 'Forbidden' });
  const cfg = getGuildConfig(guildId);
  res.json(cfg);
});

// API: update guild config (clock types, panel channels, admin roles, etc.)
app.post('/api/guilds/:guildId/config', ensureAuth, (req, res) => {
  const guildId = req.params.guildId;
  if (!canManageGuild(req.user, guildId)) return res.status(403).json({ error: 'Forbidden' });

  const patch = req.body || {};
  const updated = updateGuildConfig(guildId, patch);
  res.json(updated);
});

// API: deploy panels (ticket or application) from admin panel
app.post('/api/guilds/:guildId/deploy-panel', ensureAuth, async (req, res) => {
  const guildId = req.params.guildId;
  const { kind } = req.body; // 'ticket' or 'application'
  if (!canManageGuild(req.user, guildId)) return res.status(403).json({ error: 'Forbidden' });

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ error: 'Guild not found by bot' });

  const cfg = getGuildConfig(guildId);

  if (kind === 'ticket') {
    if (!cfg.ticketPanelChannelId) {
      return res.status(400).json({ error: 'ticketPanelChannelId not set in config' });
    }
    if (!Array.isArray(cfg.ticketTypes) || cfg.ticketTypes.length === 0) {
      return res.status(400).json({ error: 'No ticketTypes configured' });
    }

    const channel = await guild.channels.fetch(cfg.ticketPanelChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({ error: 'Invalid ticketPanelChannelId (not a text channel)' });
    }

    // delete old panel message if exists
    if (cfg.ticketPanelMessageId) {
      try {
        const oldMsg = await channel.messages.fetch(cfg.ticketPanelMessageId);
        if (oldMsg) await oldMsg.delete();
      } catch (e) {
        // ignore
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('Support Tickets')
      .setDescription('Click a button below to open a ticket.')
      .setColor(0x2563eb);

    const rows = [];
    let currentRow = new ActionRowBuilder();
    let countInRow = 0;

    cfg.ticketTypes.forEach(t => {
      const btn = new ButtonBuilder()
        .setCustomId(`ticket:${guildId}:${t.key}`)
        .setLabel(t.label || t.key)
        .setStyle(ButtonStyle.Primary);

      currentRow.addComponents(btn);
      countInRow++;

      if (countInRow === 5) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
        countInRow = 0;
      }
    });

    if (countInRow > 0) rows.push(currentRow);

    const msg = await channel.send({ embeds: [embed], components: rows });
    cfg.ticketPanelMessageId = msg.id;
    updateGuildConfig(guildId, cfg);

    return res.json({ ok: true, messageId: msg.id });
  }

  if (kind === 'application') {
    if (!cfg.applicationPanelChannelId) {
      return res.status(400).json({ error: 'applicationPanelChannelId not set in config' });
    }
    if (!Array.isArray(cfg.applicationTypes) || cfg.applicationTypes.length === 0) {
      return res.status(400).json({ error: 'No applicationTypes configured' });
    }

    const channel = await guild.channels.fetch(cfg.applicationPanelChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({ error: 'Invalid applicationPanelChannelId (not a text channel)' });
    }

    // delete old panel message if exists
    if (cfg.applicationPanelMessageId) {
      try {
        const oldMsg = await channel.messages.fetch(cfg.applicationPanelMessageId);
        if (oldMsg) await oldMsg.delete();
      } catch (e) {
        // ignore
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('Applications')
      .setDescription('Click a button below to start an application.')
      .setColor(0x22c55e);

    const rows = [];
    let currentRow = new ActionRowBuilder();
    let countInRow = 0;

    cfg.applicationTypes.forEach(t => {
      const btn = new ButtonBuilder()
        .setCustomId(`app:${guildId}:${t.key}`)
        .setLabel(t.label || t.key)
        .setStyle(ButtonStyle.Secondary);

      currentRow.addComponents(btn);
      countInRow++;

      if (countInRow === 5) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
        countInRow = 0;
      }
    });

    if (countInRow > 0) rows.push(currentRow);

    const msg = await channel.send({ embeds: [embed], components: rows });
    cfg.applicationPanelMessageId = msg.id;
    updateGuildConfig(guildId, cfg);

    return res.json({ ok: true, messageId: msg.id });
  }

  return res.status(400).json({ error: 'Unknown kind, expected ticket or application' });
});

// API: tickets list
app.get('/api/guilds/:guildId/tickets', ensureAuth, (req, res) => {
  const guildId = req.params.guildId;
  if (!canManageGuild(req.user, guildId)) return res.status(403).json({ error: 'Forbidden' });
  const status = req.query.status || null;
  const list = listTickets(guildId, { status });
  res.json(list);
});

// API: ticket detail
app.get('/api/guilds/:guildId/tickets/:id', ensureAuth, (req, res) => {
  const guildId = req.params.guildId;
  const id = req.params.id;
  if (!canManageGuild(req.user, guildId)) return res.status(403).json({ error: 'Forbidden' });
  const ticket = getTicketById(id);
  if (!ticket || ticket.guildId !== guildId) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  res.json(ticket);
});

// API: applications list
app.get('/api/guilds/:guildId/applications', ensureAuth, (req, res) => {
  const guildId = req.params.guildId;
  if (!canManageGuild(req.user, guildId)) return res.status(403).json({ error: 'Forbidden' });
  const status = req.query.status || null;
  const list = listApplications(guildId, { status });
  res.json(list);
});

// API: application detail
app.get('/api/guilds/:guildId/applications/:id', ensureAuth, (req, res) => {
  const guildId = req.params.guildId;
  const id = req.params.id;
  if (!canManageGuild(req.user, guildId)) return res.status(403).json({ error: 'Forbidden' });
  const appRec = getApplicationById(id);
  if (!appRec || appRec.guildId !== guildId) {
    return res.status(404).json({ error: 'Application not found' });
  }
  res.json(appRec);
});

// API: application decision (approve/deny)
app.post('/api/guilds/:guildId/applications/:id/decision', ensureAuth, async (req, res) => {
  const guildId = req.params.guildId;
  const id = req.params.id;
  const { status } = req.body;
  if (!canManageGuild(req.user, guildId)) return res.status(403).json({ error: 'Forbidden' });
  if (!['approved', 'denied'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const appRec = decideApplication(id, status, req.user.id);
  if (!appRec) return res.status(404).json({ error: 'Application not found' });

  // Try to apply roles if approved
  if (status === 'approved') {
    const cfg = getGuildConfig(guildId);
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      const typeCfg = cfg.applicationTypes.find(t => t.key === appRec.type);
      if (typeCfg) {
        const member = await guild.members.fetch(appRec.userId).catch(() => null);
        if (member) {
          if (typeCfg.addRoleIds && typeCfg.addRoleIds.length > 0) {
            await member.roles.add(typeCfg.addRoleIds).catch(() => {});
          }
          if (typeCfg.removeRoleIds && typeCfg.removeRoleIds.length > 0) {
            await member.roles.remove(typeCfg.removeRoleIds).catch(() => {});
          }
        }
      }
    }
  }

  res.json(appRec);
});

// API: duty sessions (live board + reports)
app.get('/api/guilds/:guildId/duty/live', ensureAuth, (req, res) => {
  const guildId = req.params.guildId;
  if (!canManageGuild(req.user, guildId)) return res.status(403).json({ error: 'Forbidden' });
  const sessions = getOpenSessions(guildId);
  res.json(sessions);
});

// Simple range: today, week, month
function getRangeStart(range) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range === 'week') return now - 7 * day;
  if (range === 'month') return now - 30 * day;
  return 0;
}

app.get('/api/guilds/:guildId/duty/report', ensureAuth, (req, res) => {
  const guildId = req.params.guildId;
  const range = req.query.range || 'week';
  const clockTypeKey = req.query.clockType || null;
  if (!canManageGuild(req.user, guildId)) return res.status(403).json({ error: 'Forbidden' });

  const from = getRangeStart(range);
  const sessions = getSessionsInRange(guildId, from, clockTypeKey);

  const totals = {};
  sessions.forEach(s => {
    const dur = s.clockOut - s.clockIn;
    if (!totals[s.userId]) totals[s.userId] = 0;
    totals[s.userId] += dur;
  });

  res.json({ range, clockTypeKey, totals });
});

// API: global bans
app.get('/api/global-bans', ensureAuth, (req, res) => {
  res.json(listGlobalBans());
});

// API: current user
app.get('/api/me', ensureAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, guilds: req.user.guilds || [] });
});

// Admin logout
app.post('/api/logout', ensureAuth, (req, res) => {
  req.logout(() => {
    res.json({ ok: true });
  });
});

// Static admin UI
app.use('/public', express.static('public'));

// MAIN admin page already defined above

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌐 Admin dashboard listening on port ${PORT}`);
});

// Start Discord bot
client.login(DISCORD_TOKEN);
