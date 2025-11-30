// index.js

// ---------------------------
// Imports
// ---------------------------
const express = require('express');
const session = require('express-session');
const path = require('path');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

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
  AttachmentBuilder
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
  getAllOpenSessions
} = require('./storage');

const config = require('./config.json');

// ---------------------------
// Discord client
// ---------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

let dutyBoardMessageId = null;

// ---------------------------
// Express app (Admin panel)
// ---------------------------
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessions (used for Discord OAuth)
app.use(
  session({
    secret: process.env.ADMIN_SESSION_SECRET || 'salea-session-secret',
    resave: false,
    saveUninitialized: false
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Serve static files for admin panel (public/admin.html, css, js)
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------
// Passport (Discord OAuth)
// ---------------------------
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

passport.use(
  new DiscordStrategy(
    {
      clientID: process.env.DISCORD_CLIENT_ID || config.clientId,
      clientSecret: process.env.DISCORD_CLIENT_SECRET || 'PUT_CLIENT_SECRET_HERE',
      callbackURL:
        process.env.DISCORD_CALLBACK_URL ||
        process.env.DASHBOARD_CALLBACK_URL ||
        'http://localhost:3000/auth/discord/callback',
      scope: ['identify']
    },
    (accessToken, refreshToken, profile, done) => {
      return done(null, profile);
    }
  )
);

// ---------------------------
// Utility functions
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
  return roleIds.some(id => member.roles.cache.has(id));
}

// On-duty board updater
async function updateDutyBoard(guild) {
  const channelIdRaw = config.channels?.clockStatusChannelId;
  if (!channelIdRaw) {
    console.log('[DutyBoard] No clockStatusChannelId configured.');
    return;
  }

  // Handle if a full Discord URL accidentally got pasted
  const match = channelIdRaw.match(/\d{15,}/);
  const channelId = match ? match[0] : channelIdRaw;

  console.log('[DutyBoard] Using channel ID:', channelId);

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.log('[DutyBoard] Channel not found or not text-based for ID:', channelId);
    return;
  }

  const sessions = getAllOpenSessions();
  if (!sessions || sessions.length === 0) {
    const content = '📋 **On Duty Board**\nNo one is currently clocked in.';
    if (dutyBoardMessageId) {
      const msg = await channel.messages.fetch(dutyBoardMessageId).catch(() => null);
      if (msg) {
        await msg.edit(content).catch(() => {});
        return;
      }
    }
    const newMsg = await channel.send(content);
    dutyBoardMessageId = newMsg.id;
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

  if (dutyBoardMessageId) {
    const msg = await channel.messages.fetch(dutyBoardMessageId).catch(() => null);
    if (msg) {
      await msg.edit(content).catch(() => {});
      return;
    }
  }

  const newMsg = await channel.send(content);
  dutyBoardMessageId = newMsg.id;
}

// ---------------------------
// Admin auth helpers
// ---------------------------
function isAdminSession(req) {
  return req.isAuthenticated && req.isAuthenticated() && req.session && req.session.isAdmin;
}

function requireAdmin(req, res, next) {
  if (isAdminSession(req)) return next();

  // If it's an API request, send JSON
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      error: 'Missing or invalid admin session. Please log in via Discord.'
    });
  }
  // Otherwise, redirect to Discord login
  return res.redirect('/auth/discord');
}

// Discord OAuth routes
app.get('/auth/discord', passport.authenticate('discord'));

app.get(
  '/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/auth-failed' }),
  async (req, res) => {
    try {
      const guild = await client.guilds.fetch(config.guildId);
      const member = await guild.members.fetch(req.user.id).catch(() => null);

      const adminRoleIds =
        (config.roles && config.roles.highCommandRoleIds) ||
        (config.roles && config.roles.staffRoleId ? [config.roles.staffRoleId] : []) ||
        [];

      const isAdmin = member && hasAnyRole(member, adminRoleIds);

      if (!isAdmin) {
        req.logout(() => {});
        return res
          .status(403)
          .send('You do not have the required SALEA roles to access the admin panel.');
      }

      req.session.isAdmin = true;
      res.redirect('/admin');
    } catch (err) {
      console.error('Error during Discord auth callback:', err);
      res.status(500).send('Internal error during Discord auth.');
    }
  }
);

app.get('/auth-failed', (req, res) => {
  res.status(401).send('Discord authentication failed or was denied.');
});

app.get('/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.redirect('/');
    });
  });
});

// Admin panel route (protected)
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Small helper for the front-end to know who is logged in
app.get('/api/me', (req, res) => {
  if (!isAdminSession(req)) {
    return res.status(401).json({ authenticated: false });
  }

  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      discriminator: req.user.discriminator
    }
  });
});

// ---------------------------
// Start HTTP server
// ---------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Admin dashboard listening on port ${PORT}`);
});

// ---------------------------
// Slash command definitions
// ---------------------------
const commands = [
  // /setup-app-panel
  new SlashCommandBuilder()
    .setName('setup-app-panel')
    .setDescription('Post the application panel with apply buttons.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // /app approve / deny
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

  // /ticket open / close
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

  // /clock in / out / status
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

  // /activity self/member/top
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
    )
].map(cmd => cmd.toJSON());

// ---------------------------
// Slash command registration
// ---------------------------
client.once(Events.ClientReady, async readyClient => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(config.token);

  try {
    console.log('🔁 Refreshing application (slash) commands...');
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );
    console.log('✅ Slash commands registered.');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }

  // Sync duty board on startup
  try {
    const guild = await client.guilds.fetch(config.guildId);
    await updateDutyBoard(guild);
  } catch (err) {
    console.error('[DutyBoard] Failed to update on ready:', err);
  }
});

// ---------------------------
// Interaction handler
// ---------------------------
client.on(Events.InteractionCreate, async interaction => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // /setup-app-panel
    if (commandName === 'setup-app-panel') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (
        !member.permissions.has(PermissionFlagsBits.ManageGuild) &&
        !hasAnyRole(member, config.roles.highCommandRoleIds || [])
      ) {
        return interaction.reply({
          content: '❌ You do not have permission to use this.',
          ephemeral: true
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

      const panelChannel = config.applicationPanel?.channelId
        ? await interaction.guild.channels.fetch(config.applicationPanel.channelId)
        : interaction.channel;

      await panelChannel.send({ embeds: [embed], components: [row, row2] });
      return interaction.reply({
        content: '✅ Application panel posted.',
        ephemeral: true
      });
    }

    // /app approve / deny
    if (commandName === 'app') {
      const sub = interaction.options.getSubcommand();
      const member = await interaction.guild.members.fetch(interaction.user.id);

      if (!hasAnyRole(member, config.roles.highCommandRoleIds || [])) {
        return interaction.reply({
          content: '❌ Only High Command may manage applications.',
          ephemeral: true
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

        // Role changes
        if (
          config.roles.applicantRoleId &&
          guildMember.roles.cache.has(config.roles.applicantRoleId)
        ) {
          await guildMember.roles.remove(config.roles.applicantRoleId).catch(() => {});
        }
        if (config.roles.cadetRoleId) {
          await guildMember.roles.add(config.roles.cadetRoleId).catch(() => {});
        }

        try {
          await user.send(
            `✅ Your application to SALEA (**${division}**) has been **approved**. ` +
            `Welcome aboard as a Cadet!`
          );
        } catch {
          // ignore DM failures
        }

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
          const channel = await interaction.client.channels.fetch(
            config.channels.applicationsChannelId
          );
          if (channel && channel.isTextBased()) {
            await channel.send({ embeds: [embed] });
          }
        } catch (err) {
          console.error('Error logging application approval:', err);
        }

        return interaction.reply({
          content: `✅ Approved application for ${user} into **${division}**.`,
          ephemeral: true
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
        } catch {
          // ignore DM failures
        }

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
          const channel = await interaction.client.channels.fetch(
            config.channels.applicationsChannelId
          );
          if (channel && channel.isTextBased()) {
            await channel.send({ embeds: [embed] });
          }
        } catch (err) {
          console.error('Error logging application denial:', err);
        }

        return interaction.reply({
          content: `✅ Denied application for ${user}.`,
          ephemeral: true
        });
      }
    }

    // /ticket open / close
    if (commandName === 'ticket') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'open') {
        const type = interaction.options.getString('type');
        const subject = interaction.options.getString('subject');
        const guild = interaction.guild;

        let categoryId = null;
        if (type === 'general') categoryId = config.categories.ticketGeneralCategoryId;
        if (type === 'ia') categoryId = config.categories.ticketIACategoryId;
        if (type === 'training') categoryId = config.categories.ticketTrainingCategoryId;
        if (type === 'tech') categoryId = config.categories.ticketTechCategoryId;

        const parent = categoryId ? guild.channels.cache.get(categoryId) : null;

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

        if (config.roles.staffRoleId) {
          overwrites.push({
            id: config.roles.staffRoleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageMessages
            ]
          });
        }
        if (type === 'ia' && config.roles.iaRoleId) {
          overwrites.push({
            id: config.roles.iaRoleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
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
          topic: `Ticket for ${interaction.user.tag} | Type: ${type} | Subject: ${subject}`
        });

        addTicket({
          channelId: ticketChannel.id,
          userId: interaction.user.id,
          type,
          subject,
          createdAt: Date.now(),
          closedAt: null
        });

        await interaction.reply({
          content: `✅ Ticket created: ${ticketChannel}`,
          ephemeral: true
        });

        await ticketChannel.send(
          `👋 Hello ${interaction.user}, a staff member will be with you shortly.\n` +
          `**Type:** ${type}\n**Subject:** ${subject}`
        );
      }

      if (sub === 'close') {
        const channel = interaction.channel;

        const validCategories = [
          config.categories.ticketGeneralCategoryId,
          config.categories.ticketIACategoryId,
          config.categories.ticketTrainingCategoryId,
          config.categories.ticketTechCategoryId
        ].filter(Boolean);

        if (!validCategories.includes(channel.parentId)) {
          return interaction.reply({
            content: '❌ This command can only be used inside a ticket channel.',
            ephemeral: true
          });
        }

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const isStaff =
          member &&
          (member.permissions.has(PermissionFlagsBits.ManageChannels) ||
            (config.roles.staffRoleId && member.roles.cache.has(config.roles.staffRoleId)));

        if (!isStaff) {
          return interaction.reply({
            content: '❌ Only staff can close tickets.',
            ephemeral: true
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
        const attachment = new AttachmentBuilder(buffer, { name: `ticket-${channel.id}.txt` });

        try {
          const logChannel = await interaction.client.channels.fetch(
            config.channels.ticketTranscriptChannelId
          );
          if (logChannel && logChannel.isTextBased()) {
            const embed = new EmbedBuilder()
              .setTitle('Ticket Closed')
              .setColor(0xffa500)
              .addFields(
                { name: 'Channel', value: `#${channel.name} (${channel.id})`, inline: false },
                {
                  name: 'Closed By',
                  value: `<@${interaction.user.id}>`,
                  inline: true
                },
                {
                  name: 'Original User',
                  value: ticket ? `<@${ticket.userId}>` : 'Unknown',
                  inline: true
                }
              )
              .setTimestamp(new Date());

            await logChannel.send({ embeds: [embed], files: [attachment] });
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
      const sub = interaction.options.getSubcommand();
      const member = await interaction.guild.members.fetch(interaction.user.id);

      const swornRoles = config.roles.swornRoleIds || [];
      const isSworn = hasAnyRole(member, swornRoles);
      if (!isSworn) {
        return interaction.reply({
          content: '❌ Only sworn personnel may use the duty clock.',
          ephemeral: true
        });
      }

      if (sub === 'in') {
        const assignment = interaction.options.getString('assignment');

        const open = getOpenSession(interaction.user.id);
        if (open) {
          return interaction.reply({
            content: '⚠️ You are already clocked in.',
            ephemeral: true
          });
        }

        const session = clockIn(interaction.user.id, assignment);
        if (!session) {
          return interaction.reply({
            content: '⚠️ Could not clock you in (already in session?).',
            ephemeral: true
          });
        }

        // Add on-duty role if configured
        if (config.roles.onDutyRoleId) {
          try {
            await member.roles.add(config.roles.onDutyRoleId);
          } catch (err) {
            console.error('Error adding on-duty role:', err);
          }
        }

        // Update duty board
        await updateDutyBoard(interaction.guild);

        await interaction.reply({
          content: `✅ You are now clocked in as **${assignment}**.`,
          ephemeral: true
        });
      }

      if (sub === 'out') {
        const session = clockOut(interaction.user.id);
        if (!session) {
          return interaction.reply({
            content: '⚠️ You do not have an active clock-in session.',
            ephemeral: true
          });
        }

        const duration = session.clockOut - session.clockIn;

        if (config.roles.onDutyRoleId) {
          try {
            await member.roles.remove(config.roles.onDutyRoleId);
          } catch (err) {
            console.error('Error removing on-duty role:', err);
          }
        }

        await updateDutyBoard(interaction.guild);

        await interaction.reply({
          content: `✅ You are now clocked out. Session duration: **${msToHuman(duration)}**.`,
          ephemeral: true
        });
      }

      if (sub === 'status') {
        const open = getOpenSession(interaction.user.id);
        if (!open) {
          return interaction.reply({
            content: 'ℹ️ You are currently **not** clocked in.',
            ephemeral: true
          });
        }

        const duration = Date.now() - open.clockIn;
        const unitText = open.assignment ? `Assignment: **${open.assignment}**\n` : '';
        await interaction.reply({
          content:
            `⏱️ You are currently clocked in.\n${unitText}` +
            `Started: <t:${Math.floor(open.clockIn / 1000)}:R>\n` +
            `Elapsed: **${msToHuman(duration)}**`,
          ephemeral: true
        });
      }
    }

    // /activity
    if (commandName === 'activity') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'self') {
        const range = interaction.options.getString('range');
        const from = getRangeStart(range);
        const sessions = getSessionsForUserInRange(interaction.user.id, from);
        const totalMs = sessions.reduce(
          (sum, s) => sum + (s.clockOut - s.clockIn),
          0
        );

        return interaction.reply({
          content:
            `📊 Activity for <@${interaction.user.id}> (${range}):\n` +
            `Total duty time: **${msToHuman(totalMs)}**\n` +
            `Completed sessions: **${sessions.length}**`,
          ephemeral: true
        });
      }

      if (sub === 'member') {
        const range = interaction.options.getString('range');
        const user = interaction.options.getUser('user');

        const member = await interaction.guild.members.fetch(interaction.user.id);
        const hcRoles = config.roles.highCommandRoleIds || [];
        if (!hasAnyRole(member, hcRoles)) {
          return interaction.reply({
            content: '❌ Only High Command may view other members\' activity.',
            ephemeral: true
          });
        }

        const from = getRangeStart(range);
        const sessions = getSessionsForUserInRange(user.id, from);
        const totalMs = sessions.reduce(
          (sum, s) => sum + (s.clockOut - s.clockIn),
          0
        );

        return interaction.reply({
          content:
            `📊 Activity for <@${user.id}> (${range}):\n` +
            `Total duty time: **${msToHuman(totalMs)}**\n` +
            `Completed sessions: **${sessions.length}**`,
          ephemeral: true
        });
      }

      if (sub === 'top') {
        const range = interaction.options.getString('range');
        const assignment = interaction.options.getString('assignment') || null;

        const member = await interaction.guild.members.fetch(interaction.user.id);
        const hcRoles = config.roles.highCommandRoleIds || [];
        if (!hasAnyRole(member, hcRoles)) {
          return interaction.reply({
            content: '❌ Only High Command may view top activity.',
            ephemeral: true
          });
        }

        const from = getRangeStart(range);
        const sessions = getSessionsInRange(from, assignment);

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
            ephemeral: true
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
          ephemeral: true
        });
      }
    }
  }

  // Button interactions for application panel
  if (interaction.isButton()) {
    const id = interaction.customId;
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
        userId: interaction.user.id,
        division: divisionName,
        answers: {
          name,
          age,
          experience: exp,
          availability
        },
        status: 'pending',
        createdAt: Date.now(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null
      });

      if (config.roles.applicantRoleId) {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (member && !member.roles.cache.has(config.roles.applicantRoleId)) {
          await member.roles.add(config.roles.applicantRoleId).catch(() => {});
        }
      }

      const embed = new EmbedBuilder()
        .setTitle(`New Application - ${divisionName}`)
        .setColor(0x00ae86)
        .addFields(
          { name: 'Applicant', value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: false },
          { name: 'Name', value: name, inline: false },
          { name: 'Age', value: age, inline: true },
          { name: 'Experience', value: exp || 'N/A', inline: false },
          { name: 'Availability', value: availability || 'N/A', inline: false }
        )
        .setFooter({ text: `Application ID: ${appRecord.id}` })
        .setTimestamp(new Date(appRecord.createdAt));

      try {
        const channel = await interaction.client.channels.fetch(
          config.channels.applicationsChannelId
        );
        if (channel && channel.isTextBased()) {
          const content = config.roles.hrRoleId
            ? `<@&${config.roles.hrRoleId}> New application received.`
            : 'New application received.';
          await channel.send({ content, embeds: [embed] });
        }
      } catch (err) {
        console.error('Error sending application log:', err);
      }

      await interaction.reply({
        content: `✅ Your application to **${divisionName}** has been submitted. A member of HR/High Command will review it.`,
        ephemeral: true
      });
    }
  }
});

// ---------------------------
// Start the bot
// ---------------------------
client.login(config.token);
