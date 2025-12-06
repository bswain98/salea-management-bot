// index.js

const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');

const {
  addApplication,
  updateApplicationStatus,
  getLatestApplicationForUser,
  addTicket,
  closeTicket,
  clockIn,
  clockOut,
  getOpenSession,
  getSessionsForUserInRange,
  getSessionsInRange,
  getAllOpenSessions,
} = require('./storage');

const {
  loadGuildConfigs,
  getGuildConfig,
  getOrCreateGuildConfig,
  saveGuildConfig,
  setGuildAdminRoles,
  getGuildFeatures,
  setGuildFeatures,
} = require('./guildStorage');

// ---------------------------
// Discord client
// ---------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

let clientReady = false;

// ---------------------------
// Utility: time formatting & ranges
// ---------------------------

function msToHuman(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) return '0m';
  return parts.join(' ');
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

function hasAnyRole(member, roleIds) {
  if (!member || !roleIds || !roleIds.length) return false;
  return roleIds.some(id => member.roles.cache.has(id));
}

function isGuildAdminMember(member, guildId) {
  if (!member || !guildId) return false;
  const cfg = getGuildConfig(guildId);
  const adminRoleIds = cfg.adminRoleIds || [];

  const isHighCommand = member.roles.cache.some(r => r.name === '--High Command--');
  const hasAdminRole = adminRoleIds.some(id => member.roles.cache.has(id));

  return isHighCommand || hasAdminRole || member.permissions.has(PermissionFlagsBits.Administrator);
}

// ---------------------------
// Duty board per guild
// ---------------------------

const dutyBoardMessageCache = new Map(); // guildId -> messageId

async function updateDutyBoard(guild) {
  if (!guild) return;

  const cfg = getGuildConfig(guild.id);
  const channelId = cfg.clockStatusChannelId;
  if (!channelId) {
    return;
  }

  let channel;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch {
    console.warn('[DutyBoard] Channel not found for ID:', channelId);
    return;
  }
  if (!channel || !channel.isTextBased()) return;

  const sessions = getAllOpenSessions().filter(s => s.guildId === guild.id);
  if (!sessions || sessions.length === 0) {
    const content = '📋 **On Duty Board**\nNo one is currently clocked in.';
    const existingId = dutyBoardMessageCache.get(guild.id);
    if (existingId) {
      const msg = await channel.messages.fetch(existingId).catch(() => null);
      if (msg) {
        await msg.edit(content).catch(() => {});
        return;
      }
    }
    const newMsg = await channel.send(content);
    dutyBoardMessageCache.set(guild.id, newMsg.id);
    return;
  }

  const lines = sessions.map(s => {
    const assignments = Array.isArray(s.assignments)
      ? s.assignments
      : s.assignment
      ? [s.assignment]
      : [];
    const assignmentsText = assignments.length > 0 ? assignments.join(', ') : 'Unspecified';
    const startedUnix = Math.floor(s.clockIn / 1000);
    const elapsed = msToHuman(Date.now() - s.clockIn);

    return `• <@${s.userId}> – **${assignmentsText}** – on duty since <t:${startedUnix}:R> (**${elapsed}**)`;
  });

  const header = '📋 **On Duty Board**';
  const content = `${header}\n${lines.join('\n')}`;

  const existingId = dutyBoardMessageCache.get(guild.id);
  if (existingId) {
    const msg = await channel.messages.fetch(existingId).catch(() => null);
    if (msg) {
      await msg.edit(content).catch(() => {});
      return;
    }
  }

  const newMsg = await channel.send(content);
  dutyBoardMessageCache.set(guild.id, newMsg.id);
}

// ---------------------------
// Slash command definitions
// ---------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('setup-app-panel')
    .setDescription('Post the application panel with apply buttons.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('app')
    .setDescription('Application management.')
    .addSubcommand(sub =>
      sub
        .setName('approve')
        .setDescription('Approve the latest application for a user.')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('Applicant to approve.')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('division')
            .setDescription('Division they are being accepted into.')
            .setRequired(true)
            .addChoices(
              { name: 'Patrol', value: 'Patrol' },
              { name: 'CID', value: 'CID' },
              { name: 'SRT', value: 'SRT' },
              { name: 'Traffic Unit', value: 'Traffic Unit' },
              { name: 'Reaper', value: 'Reaper' },
              { name: 'IA', value: 'IA' },
              { name: 'Dispatch', value: 'Dispatch' },
              { name: 'Training Staff', value: 'Training' }
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('deny')
        .setDescription('Deny the latest application for a user.')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('Applicant to deny.')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('reason')
            .setDescription('Reason for denial.')
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket system.')
    .addSubcommand(sub =>
      sub
        .setName('open')
        .setDescription('Open a support ticket.')
        .addStringOption(opt =>
          opt
            .setName('type')
            .setDescription('Type of ticket.')
            .setRequired(true)
            .addChoices(
              { name: 'General', value: 'general' },
              { name: 'IA / Complaint', value: 'ia' },
              { name: 'Training / Ride-Along', value: 'training' },
              { name: 'Tech Issue', value: 'tech' }
            )
        )
        .addStringOption(opt =>
          opt
            .setName('subject')
            .setDescription('Short description of your issue.')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('close')
        .setDescription('Close this ticket channel (with transcript).')
    ),

  new SlashCommandBuilder()
    .setName('clock')
    .setDescription('Clock in and out of duty.')
    .addSubcommand(sub =>
      sub
        .setName('in')
        .setDescription('Clock in for duty.')
        .addStringOption(opt =>
          opt
            .setName('assignment')
            .setDescription('Select your unit or subdivision.')
            .setRequired(true)
            .addChoices(
              { name: 'Patrol', value: 'Patrol' },
              { name: 'High Command', value: 'High Command' },
              { name: 'Command', value: 'Command' },
              { name: 'Traffic Unit', value: 'Traffic Unit' },
              { name: 'Reaper', value: 'Reaper' },
              { name: 'CID', value: 'CID' },
              { name: 'IA', value: 'IA' },
              { name: 'Supervisor', value: 'Supervisor' }
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('out')
        .setDescription('Clock out of duty.')
    )
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Check your current clock-in status.')
    ),

  new SlashCommandBuilder()
    .setName('activity')
    .setDescription('View duty activity.')
    .addSubcommand(sub =>
      sub
        .setName('self')
        .setDescription('View your own duty time.')
        .addStringOption(opt =>
          opt
            .setName('range')
            .setDescription('Time range.')
            .setRequired(true)
            .addChoices(
              { name: 'Today', value: 'today' },
              { name: 'This Week', value: 'week' },
              { name: 'This Month', value: 'month' }
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('member')
        .setDescription('View duty time for another member.')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('User to check.')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('range')
            .setDescription('Time range.')
            .setRequired(true)
            .addChoices(
              { name: 'Today', value: 'today' },
              { name: 'This Week', value: 'week' },
              { name: 'This Month', value: 'month' }
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('top')
        .setDescription('Top duty time performers.')
        .addStringOption(opt =>
          opt
            .setName('range')
            .setDescription('Time range.')
            .setRequired(true)
            .addChoices(
              { name: 'Today', value: 'today' },
              { name: 'This Week', value: 'week' },
              { name: 'This Month', value: 'month' }
            )
        )
        .addStringOption(opt =>
          opt
            .setName('assignment')
            .setDescription('Filter by assignment (optional).')
            .setRequired(false)
            .addChoices(
              { name: 'Patrol', value: 'Patrol' },
              { name: 'High Command', value: 'High Command' },
              { name: 'Command', value: 'Command' },
              { name: 'Traffic Unit', value: 'Traffic Unit' },
              { name: 'Reaper', value: 'Reaper' },
              { name: 'CID', value: 'CID' },
              { name: 'IA', value: 'IA' },
              { name: 'Supervisor', value: 'Supervisor' }
            )
        )
    ),
].map(cmd => cmd.toJSON());

// ---------------------------
// Express / Admin setup
// ---------------------------

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.ADMIN_SESSION_SECRET || 'salea-secret',
    resave: false,
    saveUninitialized: false,
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Passport serialization
passport.serializeUser((user, done) => {
  done(null, {
    id: user.id,
    username: user.username,
    discriminator: user.discriminator,
    avatar: user.avatar,
  });
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// OAuth2 Strategy for Discord
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_CALLBACK_URL =
  process.env.DISCORD_CALLBACK_URL ||
  'http://localhost:3000/auth/discord/callback';

passport.use(
  'discord',
  new OAuth2Strategy(
    {
      authorizationURL: 'https://discord.com/api/oauth2/authorize',
      tokenURL: 'https://discord.com/api/oauth2/token',
      clientID: DISCORD_CLIENT_ID,
      clientSecret: DISCORD_CLIENT_SECRET,
      callbackURL: DISCORD_CALLBACK_URL,
      scope: ['identify'],
    },
    async (accessToken, refreshToken, params, profile, done) => {
      try {
        const resp = await fetch('https://discord.com/api/users/@me', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        if (!resp.ok) {
          return done(new Error('Failed to fetch Discord user profile'));
        }
        const user = await resp.json();
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);

// Simple auth guard
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

// Static admin UI
app.use(express.static(path.join(__dirname, 'public')));

// Admin home -> admin.html
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// OAuth routes
app.get(
  '/auth/discord',
  passport.authenticate('discord', { prompt: 'consent' })
);

app.get(
  '/auth/discord/callback',
  passport.authenticate('discord', {
    failureRedirect: '/admin',
  }),
  (req, res) => {
    res.redirect('/admin');
  }
);

app.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.redirect('/admin');
    });
  });
});

// ---------------------------
// Admin API
// ---------------------------

app.get('/api/me', ensureAuthenticated, async (req, res) => {
  try {
    if (!clientReady) {
      return res.status(503).json({ error: 'Bot not ready' });
    }

    const userId = req.user.id;
    const session = req.session || {};
    const activeGuildId = session.activeGuildId || null;

    const adminGuilds = [];
    const promises = [];

    for (const [guildId, guild] of client.guilds.cache) {
      promises.push(
        guild.members
          .fetch(userId)
          .then(member => {
            if (isGuildAdminMember(member, guildId)) {
              const cfg = getGuildConfig(guildId);
              adminGuilds.push({
                id: guildId,
                name: guild.name,
                adminRoleIds: cfg.adminRoleIds || [],
              });
            }
          })
          .catch(() => {})
      );
    }

    await Promise.all(promises);

    if (!session.activeGuildId && adminGuilds.length > 0) {
      session.activeGuildId = adminGuilds[0].id;
    }

    res.json({
      user: req.user,
      adminGuilds,
      activeGuildId: session.activeGuildId || null,
    });
  } catch (err) {
    console.error('/api/me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/guilds', ensureAuthenticated, async (req, res) => {
  try {
    if (!clientReady) {
      return res.status(503).json({ error: 'Bot not ready' });
    }
    const userId = req.user.id;
    const session = req.session || {};
    const activeGuildId = session.activeGuildId || null;

    const result = [];
    const adminGuilds = [];

    for (const [guildId, guild] of client.guilds.cache) {
      let member = null;
      try {
        member = await guild.members.fetch(userId);
      } catch {
        // not in guild
      }
      const cfg = getGuildConfig(guildId);
      const isAdmin = member ? isGuildAdminMember(member, guildId) : false;
      if (isAdmin) {
        adminGuilds.push(guildId);
      }

      result.push({
        id: guildId,
        name: guild.name,
        isAdminGuild: isAdmin,
        adminRoleIds: cfg.adminRoleIds || [],
        roles: member
          ? guild.roles.cache
              .filter(r => r.editable || r.name === '--High Command--')
              .map(r => ({ id: r.id, name: r.name }))
          : guild.roles.cache.map(r => ({ id: r.id, name: r.name })),
      });
    }

    if (!session.activeGuildId && adminGuilds.length > 0) {
      session.activeGuildId = adminGuilds[0];
    }

    res.json(
      result.filter(g => adminGuilds.includes(g.id))
    );
  } catch (err) {
    console.error('/api/guilds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/select-guild', ensureAuthenticated, (req, res) => {
  const { guildId } = req.body || {};
  if (!guildId) {
    return res.status(400).json({ error: 'guildId required' });
  }
  const session = req.session || {};
  session.activeGuildId = guildId;
  res.json({ ok: true, activeGuildId: guildId });
});

app.get('/api/guilds/:guildId/admin-roles', ensureAuthenticated, (req, res) => {
  try {
    const { guildId } = req.params;
    const cfg = getGuildConfig(guildId);
    res.json({ adminRoleIds: cfg.adminRoleIds || [] });
  } catch (err) {
    console.error('GET admin-roles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/guilds/:guildId/admin-roles', ensureAuthenticated, (req, res) => {
  try {
    const { guildId } = req.params;
    const { roleIds } = req.body || {};
    const cfg = setGuildAdminRoles(guildId, Array.isArray(roleIds) ? roleIds : []);
    res.json({ adminRoleIds: cfg.adminRoleIds || [] });
  } catch (err) {
    console.error('POST admin-roles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Features
app.get('/api/guilds/:guildId/features', ensureAuthenticated, (req, res) => {
  try {
    const { guildId } = req.params;
    const features = getGuildFeatures(guildId);
    res.json(features);
  } catch (err) {
    console.error('GET features error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/guilds/:guildId/features', ensureAuthenticated, (req, res) => {
  try {
    const { guildId } = req.params;
    const update = req.body || {};
    const features = setGuildFeatures(guildId, update);
    res.json(features);
  } catch (err) {
    console.error('POST features error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start admin server
app.listen(PORT, () => {
  console.log(`🌐 Admin dashboard listening on port ${PORT}`);
  console.log(`🌐 Using Discord OAuth callback URL: ${DISCORD_CALLBACK_URL}`);
});

// ---------------------------
// Discord client events
// ---------------------------

client.once(Events.ClientReady, async readyClient => {
  clientReady = true;
  console.log(`✅ Logged in as ${readyClient.user.tag}`);

  // Register commands globally for all guilds the bot is in
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('🔁 Refreshing application (slash) commands...');
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered.');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }

  // Try to update duty board for each guild on ready
  for (const [, guild] of client.guilds.cache) {
    try {
      await updateDutyBoard(guild);
    } catch (err) {
      console.error('[DutyBoard] Failed to update on ready:', err);
    }
  }
});

// Setup Wizard on guild join
client.on('guildCreate', async guild => {
  console.log(`[SetupWizard] Joined new guild: ${guild.name} (${guild.id})`);

  // Ensure config exists
  const cfg = getOrCreateGuildConfig(guild.id);
  const features = cfg.features || getGuildFeatures(guild.id);
  if (features.autoPanels === false) {
    return;
  }

  let targetChannel = guild.systemChannel || null;
  if (!targetChannel) {
    targetChannel = guild.channels.cache
      .filter(ch => ch.isTextBased() && ch.viewable && ch.type === ChannelType.GuildText)
      .sort((a, b) => a.position - b.position)
      .first();
  }

  if (!targetChannel) {
    console.warn(`[SetupWizard] No suitable channel found for guild ${guild.id}`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('SALEA Bot Setup Wizard')
    .setDescription(
      'Thanks for adding the SALEA Management Bot.\n\n' +
      'Use the buttons below to quickly set up core panels for this guild:\n' +
      '• **Application Panel** – for recruits to apply\n' +
      '• **Ticket Panel** – for support / IA / training tickets\n' +
      '• **Admin Dashboard** – configure channels, pings, & features'
    )
    .setColor(0x2563eb);

  const adminUrl =
    process.env.ADMIN_BASE_URL ||
    'https://salea-management-bot.onrender.com/admin';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup_create_app_panel')
      .setLabel('Create Application Panel')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('setup_create_ticket_panel')
      .setLabel('Create Ticket Info')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('setup_open_admin')
      .setLabel('Open Admin Dashboard')
      .setStyle(ButtonStyle.Link)
      .setURL(adminUrl)
  );

  try {
    await targetChannel.send({ embeds: [embed], components: [row] });
    console.log(`[SetupWizard] Posted setup panel in #${targetChannel.name} (${targetChannel.id})`);
  } catch (err) {
    console.error('[SetupWizard] Failed to send setup wizard message:', err);
  }
});

// Interactions
client.on(Events.InteractionCreate, async interaction => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      const guildId = interaction.guildId;
      const features = guildId ? getGuildFeatures(guildId) : null;

      // /setup-app-panel
      if (commandName === 'setup-app-panel') {
        if (features && features.applications === false) {
          return interaction.reply({
            content: '❌ Applications are currently disabled on this server.',
            ephemeral: true,
          });
        }

        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!isGuildAdminMember(member, guildId)) {
          return interaction.reply({
            content: '❌ You do not have permission to use this.',
            ephemeral: true,
          });
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('apply_patrol')
            .setLabel('Apply - Patrol')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('apply_cid')
            .setLabel('Apply - CID')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('apply_srt')
            .setLabel('Apply - SRT')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('apply_traffic')
            .setLabel('Apply - Traffic Unit')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('apply_reaper')
            .setLabel('Apply - Reaper')
            .setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('apply_ia')
            .setLabel('Apply - IA')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('apply_dispatch')
            .setLabel('Apply - Dispatch')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('apply_training')
            .setLabel('Apply - Training Staff')
            .setStyle(ButtonStyle.Secondary)
        );

        const embed = new EmbedBuilder()
          .setTitle('SALEA Applications')
          .setDescription(
            'Click the appropriate button below to submit an application.\n\n' +
            'Please be honest and detailed in your responses.'
          )
          .setColor(0x00aeff);

        await interaction.channel.send({ embeds: [embed], components: [row, row2] });

        const cfg = getGuildConfig(guildId);
        cfg.appPanelChannelId = interaction.channel.id;
        saveGuildConfig(cfg);

        return interaction.reply({
          content: '✅ Application panel posted.',
          ephemeral: true,
        });
      }

      // /app
      if (commandName === 'app') {
        if (features && features.applications === false) {
          return interaction.reply({
            content: '❌ Applications are currently disabled on this server.',
            ephemeral: true,
          });
        }

        const sub = interaction.options.getSubcommand();
        const member = await interaction.guild.members.fetch(interaction.user.id);

        if (!isGuildAdminMember(member, guildId)) {
          return interaction.reply({
            content: '❌ Only High Command / Admin may manage applications.',
            ephemeral: true,
          });
        }

        if (sub === 'approve') {
          const user = interaction.options.getUser('user');
          const division = interaction.options.getString('division');
          const guildMember = await interaction.guild.members.fetch(user.id);

          const latestApp = getLatestApplicationForUser(user.id);
          const appRecord = latestApp
            ? updateApplicationStatus(latestApp.id, 'approved', interaction.user.id, division)
            : null;

          const cfg = getGuildConfig(guildId);
          const applicantRoleId = cfg.applicantRoleId || null;
          const cadetRoleId = cfg.cadetRoleId || (cfg.roles?.cadetRoleId ?? null);

          if (applicantRoleId && guildMember.roles.cache.has(applicantRoleId)) {
            await guildMember.roles.remove(applicantRoleId).catch(() => {});
          }
          if (cadetRoleId) {
            await guildMember.roles.add(cadetRoleId).catch(() => {});
          }

          try {
            await user.send(
              `✅ Your application to SALEA (**${division}**) has been **approved**. ` +
              `Welcome aboard as a Cadet!`
            );
          } catch {}

          const embed = new EmbedBuilder()
            .setTitle('Application Approved')
            .setColor(0x00ff00)
            .addFields(
              { name: 'Applicant', value: `<@${user.id}> (${user.id})`, inline: false },
              { name: 'Division', value: division, inline: true },
              { name: 'Approved By', value: `<@${interaction.user.id}>`, inline: true }
            )
            .setTimestamp(new Date());

          if (appRecord) {
            embed.setFooter({ text: `Application ID: ${appRecord.id}` });
          }

          try {
            const logChannelId = cfg.applicationsChannelId || cfg.channels?.applicationsChannelId;
            if (logChannelId) {
              const channel = await interaction.client.channels.fetch(logChannelId);
              if (channel && channel.isTextBased()) {
                await channel.send({ embeds: [embed] });
              }
            }
          } catch (err) {
            console.error('Error logging application approval:', err);
          }

          return interaction.reply({
            content: `✅ Approved application for ${user} into **${division}**.`,
            ephemeral: true,
          });
        }

        if (sub === 'deny') {
          const user = interaction.options.getUser('user');
          const reason = interaction.options.getString('reason');

          const latestApp = getLatestApplicationForUser(user.id);
          const appRecord = latestApp
            ? updateApplicationStatus(latestApp.id, 'denied', interaction.user.id, reason)
            : null;

          try {
            await user.send(
              `❌ Your application to SALEA has been **denied**.\n` +
              `Reason: ${reason}`
            );
          } catch {}

          const embed = new EmbedBuilder()
            .setTitle('Application Denied')
            .setColor(0xff0000)
            .addFields(
              { name: 'Applicant', value: `<@${user.id}> (${user.id})`, inline: false },
              { name: 'Denied By', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Reason', value: reason, inline: false }
            )
            .setTimestamp(new Date());

          if (appRecord) {
            embed.setFooter({ text: `Application ID: ${appRecord.id}` });
          }

          try {
            const cfg = getGuildConfig(guildId);
            const logChannelId = cfg.applicationsChannelId || cfg.channels?.applicationsChannelId;
            if (logChannelId) {
              const channel = await interaction.client.channels.fetch(logChannelId);
              if (channel && channel.isTextBased()) {
                await channel.send({ embeds: [embed] });
              }
            }
          } catch (err) {
            console.error('Error logging application denial:', err);
          }

          return interaction.reply({
            content: `✅ Denied application for ${user}.`,
            ephemeral: true,
          });
        }
      }

      // /ticket
      if (commandName === 'ticket') {
        if (features && features.tickets === false) {
          return interaction.reply({
            content: '❌ Tickets are currently disabled on this server.',
            ephemeral: true,
          });
        }

        const sub = interaction.options.getSubcommand();

        if (sub === 'open') {
          const type = interaction.options.getString('type');
          const subject = interaction.options.getString('subject');
          const guild = interaction.guild;

          const cfg = getGuildConfig(guildId);

          let categoryId = null;
          if (type === 'general') categoryId = cfg.ticketGeneralCategoryId || cfg.categories?.ticketGeneralCategoryId;
          if (type === 'ia') categoryId = cfg.ticketIACategoryId || cfg.categories?.ticketIACategoryId;
          if (type === 'training') categoryId = cfg.ticketTrainingCategoryId || cfg.categories?.ticketTrainingCategoryId;
          if (type === 'tech') categoryId = cfg.ticketTechCategoryId || cfg.categories?.ticketTechCategoryId;

          const parent = categoryId ? guild.channels.cache.get(categoryId) : null;

          const overwrites = [
            {
              id: guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ];

          const staffRoleId = cfg.staffRoleId || cfg.roles?.staffRoleId;
          const iaRoleId = cfg.iaRoleId || cfg.roles?.iaRoleId;

          if (staffRoleId) {
            overwrites.push({
              id: staffRoleId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages,
              ],
            });
          }
          if (type === 'ia' && iaRoleId) {
            overwrites.push({
              id: iaRoleId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            });
          }

          const baseName =
            type === 'ia'
              ? 'ia'
              : type === 'training'
              ? 'training'
              : type === 'tech'
              ? 'tech'
              : 'ticket';

          const channelName = `${baseName}-${interaction.user.username.toLowerCase()}`.replace(
            /[^a-z0-9\-]/g,
            ''
          );

          const ticketChannel = await guild.channels.create({
            name: channelName || 'ticket',
            type: ChannelType.GuildText,
            parent: parent || undefined,
            permissionOverwrites: overwrites,
            topic: `Ticket for ${interaction.user.tag} | Type: ${type} | Subject: ${subject}`,
          });

          addTicket({
            guildId,
            channelId: ticketChannel.id,
            userId: interaction.user.id,
            type,
            subject,
            createdAt: Date.now(),
            closedAt: null,
          });

          await interaction.reply({
            content: `✅ Ticket created: ${ticketChannel}`,
            ephemeral: true,
          });

          await ticketChannel.send(
            `👋 Hello ${interaction.user}, a staff member will be with you shortly.\n` +
              `**Type:** ${type}\n**Subject:** ${subject}`
          );
        }

        if (sub === 'close') {
          const channel = interaction.channel;
          const cfg = getGuildConfig(guildId);

          const validCategories = [
            cfg.ticketGeneralCategoryId || cfg.categories?.ticketGeneralCategoryId,
            cfg.ticketIACategoryId || cfg.categories?.ticketIACategoryId,
            cfg.ticketTrainingCategoryId || cfg.categories?.ticketTrainingCategoryId,
            cfg.ticketTechCategoryId || cfg.categories?.ticketTechCategoryId,
          ].filter(Boolean);

          if (!validCategories.includes(channel.parentId)) {
            return interaction.reply({
              content: '❌ This command can only be used inside a ticket channel.',
              ephemeral: true,
            });
          }

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const staffRoleId = cfg.staffRoleId || cfg.roles?.staffRoleId;
          const isStaff =
            member &&
            (member.permissions.has(PermissionFlagsBits.ManageChannels) ||
              (staffRoleId && member.roles.cache.has(staffRoleId)) ||
              isGuildAdminMember(member, guildId));

          if (!isStaff) {
            return interaction.reply({
              content: '❌ Only staff can close tickets.',
              ephemeral: true,
            });
          }

          const ticket = closeTicket(channel.id);

          const messages = await channel.messages.fetch({ limit: 100 });
          const sorted = [...messages.values()].sort(
            (a, b) => a.createdTimestamp - b.createdTimestamp
          );
          const lines = sorted.map(
            m => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}`
          );

          const transcriptText =
            lines.length > 0 ? lines.join('\n') : 'No messages recorded in this ticket.';
          const buffer = Buffer.from(transcriptText, 'utf8');
          const attachment = new AttachmentBuilder(buffer, {
            name: `ticket-${channel.id}.txt`,
          });

          try {
            const logChannelId =
              cfg.ticketTranscriptChannelId || cfg.channels?.ticketTranscriptChannelId;
            if (logChannelId) {
              const logChannel = await interaction.client.channels.fetch(logChannelId);
              if (logChannel && logChannel.isTextBased()) {
                const embed = new EmbedBuilder()
                  .setTitle('Ticket Closed')
                  .setColor(0xffa500)
                  .addFields(
                    { name: 'Channel', value: `#${channel.name} (${channel.id})`, inline: false },
                    {
                      name: 'Closed By',
                      value: `<@${interaction.user.id}>`,
                      inline: true,
                    },
                    {
                      name: 'Original User',
                      value: ticket ? `<@${ticket.userId}>` : 'Unknown',
                      inline: true,
                    }
                  )
                  .setTimestamp(new Date());

                await logChannel.send({ embeds: [embed], files: [attachment] });
              }
            }
          } catch (err) {
            console.error('Error sending ticket transcript:', err);
          }

          await interaction.reply('✅ Closing this ticket in 5 seconds...');
          setTimeout(() => {
            channel.delete('Ticket closed by staff.').catch(console.error);
          }, 5000);
        }
      }

      // /clock
      if (commandName === 'clock') {
        if (features && features.clock === false) {
          return interaction.reply({
            content: '❌ Duty clock is currently disabled on this server.',
            ephemeral: true,
          });
        }

        const sub = interaction.options.getSubcommand();
        const member = await interaction.guild.members.fetch(interaction.user.id);

        const cfg = getGuildConfig(guildId);
        const swornRoles = cfg.swornRoleIds || cfg.roles?.swornRoleIds || [];
        const isSworn = hasAnyRole(member, swornRoles);
        if (!isSworn) {
          return interaction.reply({
            content: '❌ Only sworn personnel may use the duty clock.',
            ephemeral: true,
          });
        }

        if (sub === 'in') {
          const assignment = interaction.options.getString('assignment');

          const open = getOpenSession(interaction.user.id, guildId);
          if (open) {
            return interaction.reply({
              content: '⚠️ You are already clocked in.',
              ephemeral: true,
            });
          }

          const session = clockIn(interaction.user.id, assignment, guildId);
          if (!session) {
            return interaction.reply({
              content: '⚠️ Could not clock you in (already in session?).',
              ephemeral: true,
            });
          }

          await interaction.reply({
            content: `✅ You are now clocked in as **${assignment}**.`,
            ephemeral: true,
          });

          await updateDutyBoard(interaction.guild);
        }

        if (sub === 'out') {
          const session = clockOut(interaction.user.id, guildId);
          if (!session) {
            return interaction.reply({
              content: '⚠️ You do not have an active clock-in session.',
              ephemeral: true,
            });
          }

          const duration = session.clockOut - session.clockIn;
          await interaction.reply({
            content: `✅ You are now clocked out. Session duration: **${msToHuman(
              duration
            )}**.`,
            ephemeral: true,
          });

          await updateDutyBoard(interaction.guild);
        }

        if (sub === 'status') {
          const open = getOpenSession(interaction.user.id, guildId);
          if (!open) {
            return interaction.reply({
              content: 'ℹ️ You are currently **not** clocked in.',
              ephemeral: true,
            });
          }

          const duration = Date.now() - open.clockIn;
          const unitText = open.assignment ? `Assignment: **${open.assignment}**\n` : '';
          await interaction.reply({
            content:
              `⏱️ You are currently clocked in.\n${unitText}` +
              `Started: <t:${Math.floor(open.clockIn / 1000)}:R>\n` +
              `Elapsed: **${msToHuman(duration)}**`,
            ephemeral: true,
          });
        }
      }

      // /activity
      if (commandName === 'activity') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'self') {
          const range = interaction.options.getString('range');
          const from = getRangeStart(range);
          const sessions = getSessionsForUserInRange(interaction.user.id, guildId, from);
          const totalMs = sessions.reduce(
            (sum, s) => sum + (s.clockOut - s.clockIn),
            0
          );

          return interaction.reply({
            content:
              `📊 Activity for <@${interaction.user.id}> (${range}):\n` +
              `Total duty time: **${msToHuman(totalMs)}**\n` +
              `Completed sessions: **${sessions.length}**`,
            ephemeral: true,
          });
        }

        if (sub === 'member') {
          const range = interaction.options.getString('range');
          const user = interaction.options.getUser('user');

          const member = await interaction.guild.members.fetch(interaction.user.id);
          if (!isGuildAdminMember(member, guildId)) {
            return interaction.reply({
              content: '❌ Only High Command may view other members\' activity.',
              ephemeral: true,
            });
          }

          const from = getRangeStart(range);
          const sessions = getSessionsForUserInRange(user.id, guildId, from);
          const totalMs = sessions.reduce(
            (sum, s) => sum + (s.clockOut - s.clockIn),
            0
          );

          return interaction.reply({
            content:
              `📊 Activity for <@${user.id}> (${range}):\n` +
              `Total duty time: **${msToHuman(totalMs)}**\n` +
              `Completed sessions: **${sessions.length}**`,
            ephemeral: true,
          });
        }

        if (sub === 'top') {
          const range = interaction.options.getString('range');
          const assignment = interaction.options.getString('assignment') || null;

          const member = await interaction.guild.members.fetch(interaction.user.id);
          if (!isGuildAdminMember(member, guildId)) {
            return interaction.reply({
              content: '❌ Only High Command may view top activity.',
              ephemeral: true,
            });
          }

          const from = getRangeStart(range);
          const sessions = getSessionsInRange(guildId, from, assignment);

          const totals = {};
          for (const s of sessions) {
            if (!totals[s.userId]) totals[s.userId] = 0;
            totals[s.userId] += s.clockOut - s.clockIn;
          }

          const sorted = Object.entries(totals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

          if (sorted.length === 0) {
            return interaction.reply({
              content: 'ℹ️ No duty sessions found for that range.',
              ephemeral: true,
            });
          }

          const lines = await Promise.all(
            sorted.map(async ([userId, ms], idx) => {
              return `${idx + 1}. <@${userId}> – **${msToHuman(ms)}**`;
            })
          );

          const header = assignment
            ? `Top duty time (${range}) for assignment **${assignment}**:`
            : `Top duty time (${range}):`;

          return interaction.reply({
            content: `📊 ${header}\n` + lines.join('\n'),
            ephemeral: true,
          });
        }
      }
    }

    // Button interactions (Setup Wizard + Apply buttons)
    if (interaction.isButton()) {
      const id = interaction.customId;

      // Setup Wizard buttons
      if (id === 'setup_create_app_panel') {
        const guildId = interaction.guildId;
        const cfg = getGuildConfig(guildId);
        const features = cfg.features || getGuildFeatures(guildId);
        if (features.applications === false) {
          return interaction.reply({
            content: '❌ Applications are currently disabled on this server.',
            ephemeral: true,
          });
        }

        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!isGuildAdminMember(member, guildId)) {
          return interaction.reply({
            content: '❌ Only High Command / Admin can run the setup wizard.',
            ephemeral: true,
          });
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('apply_patrol')
            .setLabel('Apply - Patrol')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('apply_cid')
            .setLabel('Apply - CID')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('apply_srt')
            .setLabel('Apply - SRT')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('apply_traffic')
            .setLabel('Apply - Traffic Unit')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('apply_reaper')
            .setLabel('Apply - Reaper')
            .setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('apply_ia')
            .setLabel('Apply - IA')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('apply_dispatch')
            .setLabel('Apply - Dispatch')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('apply_training')
            .setLabel('Apply - Training Staff')
            .setStyle(ButtonStyle.Secondary)
        );

        const embed = new EmbedBuilder()
          .setTitle('SALEA Applications')
          .setDescription(
            'Click the appropriate button below to submit an application.\n\n' +
            'Please be honest and detailed in your responses.'
          )
          .setColor(0x00aeff);

        await interaction.channel.send({ embeds: [embed], components: [row, row2] });

        cfg.appPanelChannelId = interaction.channel.id;
        saveGuildConfig(cfg);

        return interaction.reply({
          content: '✅ Application panel created in this channel.',
          ephemeral: true,
        });
      }

      if (id === 'setup_create_ticket_panel') {
        const guildId = interaction.guildId;
        const cfg = getGuildConfig(guildId);
        const features = cfg.features || getGuildFeatures(guildId);
        if (features.tickets === false) {
          return interaction.reply({
            content: '❌ Tickets are currently disabled on this server.',
            ephemeral: true,
          });
        }

        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!isGuildAdminMember(member, guildId)) {
          return interaction.reply({
            content: '❌ Only High Command / Admin can run the setup wizard.',
            ephemeral: true,
          });
        }

        const embed = new EmbedBuilder()
          .setTitle('SALEA Tickets')
          .setDescription(
            'Use the following slash command to open tickets:\n' +
              '• `/ticket open type: General subject: ...`\n' +
              '• `/ticket open type: IA subject: ...`\n' +
              '• `/ticket open type: Training subject: ...`\n' +
              '• `/ticket open type: Tech subject: ...`\n\n' +
              'Staff can close tickets with `/ticket close` inside the ticket channel.'
          )
          .setColor(0xfacc15);

        await interaction.channel.send({ embeds: [embed] });

        cfg.ticketInfoChannelId = interaction.channel.id;
        saveGuildConfig(cfg);

        return interaction.reply({
          content: '✅ Ticket info panel posted in this channel.',
          ephemeral: true,
        });
      }

      // Apply buttons
      if (id.startsWith('apply_')) {
        const divisionKey = id.replace('apply_', '');
        let divisionName = 'Unknown';
        if (divisionKey === 'patrol') divisionName = 'Patrol';
        if (divisionKey === 'cid') divisionName = 'CID';
        if (divisionKey === 'srt') divisionName = 'SRT';
        if (divisionKey === 'traffic') divisionName = 'Traffic Unit';
        if (divisionKey === 'reaper') divisionName = 'Reaper';
        if (divisionKey === 'ia') divisionName = 'IA';
        if (divisionKey === 'dispatch') divisionName = 'Dispatch';
        if (divisionKey === 'training') divisionName = 'Training Staff';

        const modal = new ModalBuilder()
          .setCustomId(`app_modal_${divisionKey}`)
          .setTitle(`Apply - ${divisionName}`);

        const q1 = new TextInputBuilder()
          .setCustomId('q1_name')
          .setLabel('Your name (in-game & Discord)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const q2 = new TextInputBuilder()
          .setCustomId('q2_age')
          .setLabel('Your age (OOC)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const q3 = new TextInputBuilder()
          .setCustomId('q3_experience')
          .setLabel('LEO / RP experience')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        const q4 = new TextInputBuilder()
          .setCustomId('q4_availability')
          .setLabel('Availability / time zone')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        const row1 = new ActionRowBuilder().addComponents(q1);
        const row2 = new ActionRowBuilder().addComponents(q2);
        const row3 = new ActionRowBuilder().addComponents(q3);
        const row4 = new ActionRowBuilder().addComponents(q4);

        modal.addComponents(row1, row2, row3, row4);

        await interaction.showModal(modal);
      }
    }

    // Modal submit for applications
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('app_modal_')) {
        const divisionKey = interaction.customId.replace('app_modal_', '');
        let divisionName = 'Unknown';
        if (divisionKey === 'patrol') divisionName = 'Patrol';
        if (divisionKey === 'cid') divisionName = 'CID';
        if (divisionKey === 'srt') divisionName = 'SRT';
        if (divisionKey === 'traffic') divisionName = 'Traffic Unit';
        if (divisionKey === 'reaper') divisionName = 'Reaper';
        if (divisionKey === 'ia') divisionName = 'IA';
        if (divisionKey === 'dispatch') divisionName = 'Dispatch';
        if (divisionKey === 'training') divisionName = 'Training Staff';

        const name = interaction.fields.getTextInputValue('q1_name');
        const age = interaction.fields.getTextInputValue('q2_age');
        const exp = interaction.fields.getTextInputValue('q3_experience');
        const availability = interaction.fields.getTextInputValue('q4_availability');

        const appRecord = addApplication({
          id: `${interaction.user.id}-${Date.now()}`,
          guildId: interaction.guildId,
          userId: interaction.user.id,
          division: divisionName,
          answers: {
            name,
            age,
            experience: exp,
            availability,
          },
          status: 'pending',
          createdAt: Date.now(),
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
        });

        const cfg = getGuildConfig(interaction.guildId);
        const applicantRoleId = cfg.applicantRoleId || cfg.roles?.applicantRoleId;
        if (applicantRoleId) {
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (member && !member.roles.cache.has(applicantRoleId)) {
            await member.roles.add(applicantRoleId).catch(() => {});
          }
        }

        const embed = new EmbedBuilder()
          .setTitle(`New Application - ${divisionName}`)
          .setColor(0x00ae86)
          .addFields(
            {
              name: 'Applicant',
              value: `<@${interaction.user.id}> (${interaction.user.id})`,
              inline: false,
            },
            { name: 'Name', value: name, inline: false },
            { name: 'Age', value: age, inline: true },
            { name: 'Experience', value: exp || 'N/A', inline: false },
            { name: 'Availability', value: availability || 'N/A', inline: false }
          )
          .setFooter({ text: `Application ID: ${appRecord.id}` })
          .setTimestamp(new Date(appRecord.createdAt));

        try {
          const logChannelId =
            cfg.applicationsChannelId || cfg.channels?.applicationsChannelId;
          if (logChannelId) {
            const channel = await interaction.client.channels.fetch(logChannelId);
            if (channel && channel.isTextBased()) {
              const content = cfg.hrRoleId || cfg.roles?.hrRoleId
                ? `<@&${cfg.hrRoleId || cfg.roles?.hrRoleId}> New application received.`
                : 'New application received.';
              await channel.send({ content, embeds: [embed] });
            }
          }
        } catch (err) {
          console.error('Error sending application log:', err);
        }

        await interaction.reply({
          content: `✅ Your application to **${divisionName}** has been submitted. A member of HR/High Command will review it.`,
          ephemeral: true,
        });
      }
    }
  } catch (err) {
    console.error('Interaction handler error:', err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: '⚠️ An error occurred while processing this interaction.',
          ephemeral: true,
        });
      } catch {}
    }
  }
});

// ---------------------------
// Start the bot
// ---------------------------

client.login(process.env.DISCORD_TOKEN);

