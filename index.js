// index.js

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

const express = require('express');
const session = require('express-session');

const {
  addApplication,
  updateApplicationStatus,
  getLatestApplicationForUser,
  addTicket,
  closeTicket,
  listTickets,
  clockIn,
  clockOut,
  getOpenSession,
  getAllOpenSessions,
  getSessionsForUserInRange,
  getSessionsInRange,
  addReport,
  listReports,
  addRoleRequest,
  listRoleRequests,
  addRosterRequest,
  listRosterRequests,
  getSettings,
  saveSettings
} = require('./storage');

const config = require('./config.json');

// --------- Env vars (tokens & IDs) ---------
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

// OAuth for admin panel
const OAUTH_CLIENT_ID = process.env.DISCORD_OAUTH_CLIENT_ID || CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.DISCORD_OAUTH_CLIENT_SECRET || '';
const OAUTH_REDIRECT_URI = process.env.DISCORD_OAUTH_REDIRECT_URI || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';

if (!BOT_TOKEN) {
  console.error('❌ DISCORD_TOKEN is not set. Set it in Render (or your .env).');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('❌ DISCORD_CLIENT_ID is not set (bot client ID).');
}
if (!GUILD_ID) {
  console.error('❌ DISCORD_GUILD_ID is not set (your server ID).');
}

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
// Utility helpers
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

// ---------------------------
// Duty board updater
// ---------------------------

async function updateDutyBoard(guild) {
  const settings = getSettings();
  const clockStatusChannelId =
    settings.logs && settings.logs.clockStatusChannelId
      ? settings.logs.clockStatusChannelId
      : config.channels.clockStatusChannelId;

  if (!clockStatusChannelId) return;

  const channel = await guild.channels.fetch(clockStatusChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[DutyBoard] Channel not found or not text based for ID:', clockStatusChannelId);
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
// Slash command definitions
// ---------------------------

const commands = [
  // /setup-app-panel - HC/Staff only, posts the Apply buttons
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
    ),

  // /setup-ticket-panel - posts ticket buttons
  new SlashCommandBuilder()
    .setName('setup-ticket-panel')
    .setDescription('Post the ticket panel with buttons.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // /setup-report-panel - posts report buttons
  new SlashCommandBuilder()
    .setName('setup-report-panel')
    .setDescription('Post the report panel with buttons.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // /setup-request-panel - posts role & roster request buttons
  new SlashCommandBuilder()
    .setName('setup-request-panel')
    .setDescription('Post the roster & role request panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
].map(cmd => cmd.toJSON());

// ---------------------------
// Slash command registration & ready
// ---------------------------

client.once(Events.ClientReady, async readyClient => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);

  if (CLIENT_ID && GUILD_ID) {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
      console.log('🔁 Refreshing application (slash) commands...');
      await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
      );
      console.log('✅ Slash commands registered.');
    } catch (error) {
      console.error('❌ Error registering commands:', error);
    }
  } else {
    console.warn('⚠️ CLIENT_ID or GUILD_ID missing; slash commands not registered.');
  }

  // Initialize duty board updater
  if (GUILD_ID) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
      await updateDutyBoard(guild).catch(() => {});
      setInterval(() => {
        updateDutyBoard(guild).catch(() => {});
      }, 60_000);
    } else {
      console.warn('⚠️ Guild not found in cache for duty board.');
    }
  }
});

// ---------------------------
// INTERACTION HANDLER
// ---------------------------

client.on(Events.InteractionCreate, async interaction => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    const settings = getSettings();

    // ----------------- /setup-app-panel -----------------
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

      const panelChannelId =
        (settings.panels && settings.panels.appPanelChannelId) ||
        (config.applicationPanel && config.applicationPanel.channelId) ||
        interaction.channel.id;

      const channel = await interaction.guild.channels.fetch(panelChannelId).catch(() => null);
      const finalChannel = channel && channel.isTextBased() ? channel : interaction.channel;

      await finalChannel.send({ embeds: [embed], components: [row, row2] });

      // Save where we posted the panel
      saveSettings({
        panels: {
          ...(settings.panels || {}),
          appPanelChannelId: finalChannel.id
        }
      });

      return interaction.reply({
        content: `✅ Application panel posted in <#${finalChannel.id}>.`,
        ephemeral: true
      });
    }

    // ----------------- /app approve / deny -----------------
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

        if (config.roles.applicantRoleId && guildMember.roles.cache.has(config.roles.applicantRoleId)) {
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

        const appLogChannelId =
          (settings.logs && settings.logs.applicationsLogChannelId) ||
          (config.channels && config.channels.applicationsChannelId);

        if (appLogChannelId) {
          try {
            const channel = await interaction.client.channels.fetch(appLogChannelId);
            if (channel && channel.isTextBased()) {
              const pingRoles = (settings.pings && settings.pings.applicationPingRoles) || [];
              const pingText = pingRoles.length
                ? pingRoles.map(id => `<@&${id}>`).join(' ')
                : null;
              await channel.send({
                content: pingText || null,
                embeds: [embed]
              });
            }
          } catch (err) {
            console.error('Error logging application approval:', err);
          }
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

        const appLogChannelId =
          (settings.logs && settings.logs.applicationsLogChannelId) ||
          (config.channels && config.channels.applicationsChannelId);

        if (appLogChannelId) {
          try {
            const channel = await interaction.client.channels.fetch(appLogChannelId);
            if (channel && channel.isTextBased()) {
              const pingRoles = (settings.pings && settings.pings.applicationPingRoles) || [];
              const pingText = pingRoles.length
                ? pingRoles.map(id => `<@&${id}>`).join(' ')
                : null;
              await channel.send({
                content: pingText || null,
                embeds: [embed]
              });
            }
          } catch (err) {
            console.error('Error logging application denial:', err);
          }
        }

        return interaction.reply({
          content: `✅ Denied application for ${user}.`,
          ephemeral: true
        });
      }
    }

    // ----------------- /ticket open / close -----------------
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
          id: `${interaction.id}`,
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
        const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        const lines = sorted.map(
          m => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}`
        );

        const transcriptText =
          lines.length > 0 ? lines.join('\n') : 'No messages recorded in this ticket.';

        const buffer = Buffer.from(transcriptText, 'utf8');
        const attachment = new AttachmentBuilder(buffer, { name: `ticket-${channel.id}.txt` });

        const transcriptChannelId =
          (settings.logs && settings.logs.ticketTranscriptChannelId) ||
          (config.channels && config.channels.ticketTranscriptChannelId);

        if (transcriptChannelId) {
          try {
            const logChannel = await interaction.client.channels.fetch(transcriptChannelId);
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

              const pingRoles = (settings.pings && settings.pings.ticketPingRoles) || [];
              const pingText = pingRoles.length
                ? pingRoles.map(id => `<@&${id}>`).join(' ')
                : null;

              await logChannel.send({
                content: pingText || null,
                embeds: [embed],
                files: [attachment]
              });
            }
          } catch (err) {
            console.error('Error sending ticket transcript:', err);
          }
        }

        await interaction.reply('✅ Closing this ticket in 5 seconds...');
        setTimeout(() => {
          channel.delete('Ticket closed by staff.').catch(console.error);
        }, 5000);
      }
    }

    // ----------------- /clock -----------------
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

      const onDutyRoleId = config.roles.onDutyRoleId || null;

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

        if (onDutyRoleId && !member.roles.cache.has(onDutyRoleId)) {
          await member.roles.add(onDutyRoleId).catch(() => {});
        }

        const guild = interaction.guild;
        await updateDutyBoard(guild).catch(() => {});

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

        if (onDutyRoleId && member.roles.cache.has(onDutyRoleId)) {
          await member.roles.remove(onDutyRoleId).catch(() => {});
        }

        const guild = interaction.guild;
        await updateDutyBoard(guild).catch(() => {});

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
        const assignments = Array.isArray(open.assignments) ? open.assignments : [];
        const unitText = assignments.length ? `Assignments: **${assignments.join(', ')}**\n` : '';
        await interaction.reply({
          content:
            `⏱️ You are currently clocked in.\n${unitText}` +
            `Started: <t:${Math.floor(open.clockIn / 1000)}:R>\n` +
            `Elapsed: **${msToHuman(duration)}**`,
          ephemeral: true
        });
      }
    }

    // ----------------- /activity -----------------
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
          totals[s.userId] += (s.clockOut - s.clockIn);
        }

        const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10);

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

    // ----------------- /setup-ticket-panel -----------------
    if (commandName === 'setup-ticket-panel') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const settingsNow = getSettings();

      if (
        !member.permissions.has(PermissionFlagsBits.ManageChannels) &&
        !hasAnyRole(member, config.roles.highCommandRoleIds || [])
      ) {
        return interaction.reply({
          content: '❌ You do not have permission to use this.',
          ephemeral: true
        });
      }

      const ticketEmbed = new EmbedBuilder()
        .setTitle('SALEA Support Tickets')
        .setDescription(
          'Click one of the buttons below to open a ticket.\n\n' +
          'Please provide as much detail as possible so staff can assist you.'
        )
        .setColor(0x00aeff);

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_btn_general')
          .setLabel('General Support')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('ticket_btn_ia')
          .setLabel('IA / Complaint')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('ticket_btn_training')
          .setLabel('Training / Ride-Along')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('ticket_btn_tech')
          .setLabel('Tech Issue')
          .setStyle(ButtonStyle.Secondary)
      );

      const panelChannelId =
        (settingsNow.panels && settingsNow.panels.ticketPanelChannelId) ||
        interaction.channel.id;

      const channel = await interaction.guild.channels.fetch(panelChannelId).catch(() => null);
      const finalChannel = channel && channel.isTextBased() ? channel : interaction.channel;

      await finalChannel.send({
        embeds: [ticketEmbed],
        components: [row1]
      });

      saveSettings({
        panels: {
          ...(settingsNow.panels || {}),
          ticketPanelChannelId: finalChannel.id
        }
      });

      return interaction.reply({
        content: `✅ Ticket panel posted in <#${finalChannel.id}>.`,
        ephemeral: true
      });
    }

    // ----------------- /setup-report-panel -----------------
    if (commandName === 'setup-report-panel') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const settingsNow = getSettings();

      if (
        !member.permissions.has(PermissionFlagsBits.ManageChannels) &&
        !hasAnyRole(member, config.roles.highCommandRoleIds || [])
      ) {
        return interaction.reply({
          content: '❌ You do not have permission to use this.',
          ephemeral: true
        });
      }

      const reportEmbed = new EmbedBuilder()
        .setTitle('SALEA Reports')
        .setDescription(
          'Click a button below to file a report. A form will pop up asking for details.\n\n' +
          'Reports will be logged in the appropriate department channels.'
        )
        .setColor(0xfbbf24);

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('report_btn_citation')
          .setLabel('Citation Report')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('report_btn_arrest')
          .setLabel('Arrest Report')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('report_btn_uof')
          .setLabel('Use of Force')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('report_btn_reaper_aar')
          .setLabel('REAPER AAR')
          .setStyle(ButtonStyle.Success)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('report_btn_cid_incident')
          .setLabel('CID Incident Log')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('report_btn_cid_case')
          .setLabel('CID Case Report')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('report_btn_tu_shift')
          .setLabel('TU Shift Report')
          .setStyle(ButtonStyle.Secondary)
      );

      const panelChannelId =
        (settingsNow.panels && settingsNow.panels.reportPanelChannelId) ||
        interaction.channel.id;

      const channel = await interaction.guild.channels.fetch(panelChannelId).catch(() => null);
      const finalChannel = channel && channel.isTextBased() ? channel : interaction.channel;

      await finalChannel.send({
        embeds: [reportEmbed],
        components: [row1, row2]
      });

      saveSettings({
        panels: {
          ...(settingsNow.panels || {}),
          reportPanelChannelId: finalChannel.id
        }
      });

      return interaction.reply({
        content: `✅ Report panel posted in <#${finalChannel.id}>.`,
        ephemeral: true
      });
    }

    // ----------------- /setup-request-panel -----------------
    if (commandName === 'setup-request-panel') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const settingsNow = getSettings();

      if (
        !member.permissions.has(PermissionFlagsBits.ManageChannels) &&
        !hasAnyRole(member, config.roles.highCommandRoleIds || [])
      ) {
        return interaction.reply({
          content: '❌ You do not have permission to use this.',
          ephemeral: true
        });
      }

      const embed = new EmbedBuilder()
        .setTitle('SALEA Roster & Role Requests')
        .setDescription(
          'Use the buttons below to submit a request.\n\n' +
          '**Role Request** – ask for roles to be added/changed.\n' +
          '**Roster Request** – request roster updates for members.\n\n' +
          'All requests will be logged for Command to review and check off.'
        )
        .setColor(0x3b82f6);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('request_btn_role')
          .setLabel('Role Request')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('request_btn_roster')
          .setLabel('Roster Request')
          .setStyle(ButtonStyle.Secondary)
      );

      const panelChannelId =
        (settingsNow.panels && settingsNow.panels.requestPanelChannelId) ||
        interaction.channel.id;

      const channel = await interaction.guild.channels.fetch(panelChannelId).catch(() => null);
      const finalChannel = channel && channel.isTextBased() ? channel : interaction.channel;

      await finalChannel.send({
        embeds: [embed],
        components: [row]
      });

      saveSettings({
        panels: {
          ...(settingsNow.panels || {}),
          requestPanelChannelId: finalChannel.id
        }
      });

      return interaction.reply({
        content: `✅ Request panel posted in <#${finalChannel.id}>.`,
        ephemeral: true
      });
    }
  }

  // -----------------------------------
  // Button interactions (applications, tickets, reports, requests)
  // -----------------------------------
  if (interaction.isButton()) {
    const id = interaction.customId;
    const settings = getSettings();

    // ----- Application buttons -----
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
      return;
    }

    // ----- Ticket buttons -----
    if (id.startsWith('ticket_btn_')) {
      let type = 'general';
      let subjectPrefix = '';

      if (id === 'ticket_btn_general') {
        type = 'general';
        subjectPrefix = 'General Support';
      } else if (id === 'ticket_btn_ia') {
        type = 'ia';
        subjectPrefix = 'IA / Complaint';
      } else if (id === 'ticket_btn_training') {
        type = 'training';
        subjectPrefix = 'Training / Ride-Along';
      } else if (id === 'ticket_btn_tech') {
        type = 'tech';
        subjectPrefix = 'Tech Issue';
      }

      const subject = `${subjectPrefix} - by ${interaction.user.tag}`;
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
        id: `${interaction.id}`,
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

      return;
    }

    // ----- Report buttons -----
    if (id.startsWith('report_btn_')) {
      let typeKey = id.replace('report_btn_', '');
      let title = 'Report';
      let shortLabel = 'Report Details';

      if (typeKey === 'citation') {
        title = 'Citation Report';
        shortLabel = 'Citation Details';
      } else if (typeKey === 'arrest') {
        title = 'Arrest Report';
        shortLabel = 'Arrest Details';
      } else if (typeKey === 'uof') {
        title = 'Use of Force Report';
        shortLabel = 'Incident Details';
      } else if (typeKey === 'reaper_aar') {
        title = 'REAPER After Action Report';
        shortLabel = 'AAR Summary';
      } else if (typeKey === 'cid_incident') {
        title = 'CID Incident Log';
        shortLabel = 'Incident Details';
      } else if (typeKey === 'cid_case') {
        title = 'CID Case Report';
        shortLabel = 'Case Summary';
      } else if (typeKey === 'tu_shift') {
        title = 'Traffic Unit Shift Report';
        shortLabel = 'Shift Summary';
      }

      const modal = new ModalBuilder()
        .setCustomId(`report_modal_${typeKey}`)
        .setTitle(title);

      const q1_subject = new TextInputBuilder()
        .setCustomId('rep_subject')
        .setLabel('Short title / subject')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const q2_details = new TextInputBuilder()
        .setCustomId('rep_details')
        .setLabel(shortLabel)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      const q3_involved = new TextInputBuilder()
        .setCustomId('rep_involved')
        .setLabel('Involved units / persons (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

      const row1 = new ActionRowBuilder().addComponents(q1_subject);
      const row2 = new ActionRowBuilder().addComponents(q2_details);
      const row3 = new ActionRowBuilder().addComponents(q3_involved);

      modal.addComponents(row1, row2, row3);

      await interaction.showModal(modal);
      return;
    }

    // ----- Role Request button -----
    if (id === 'request_btn_role') {
      const modal = new ModalBuilder()
        .setCustomId('role_request_modal')
        .setTitle('Role Request');

      const nameInput = new TextInputBuilder()
        .setCustomId('role_name')
        .setLabel('Name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const rolesInput = new TextInputBuilder()
        .setCustomId('role_roles_needed')
        .setLabel('Roles needed')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      const approvedInput = new TextInputBuilder()
        .setCustomId('role_approved_by')
        .setLabel('Approved by (if applicable)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const row1 = new ActionRowBuilder().addComponents(nameInput);
      const row2 = new ActionRowBuilder().addComponents(rolesInput);
      const row3 = new ActionRowBuilder().addComponents(approvedInput);

      modal.addComponents(row1, row2, row3);

      await interaction.showModal(modal);
      return;
    }

    // ----- Roster Request button -----
    if (id === 'request_btn_roster') {
      const modal = new ModalBuilder()
        .setCustomId('roster_request_modal')
        .setTitle('Roster Request');

      const templateInput = new TextInputBuilder()
        .setCustomId('rost_template')
        .setLabel('Template (e.g. Patrol, CID, SRT)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const nameInput = new TextInputBuilder()
        .setCustomId('rost_name')
        .setLabel('Name (In-Game First and Last)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const discordIdInput = new TextInputBuilder()
        .setCustomId('rost_discord_id')
        .setLabel('Discord ID')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const tzInput = new TextInputBuilder()
        .setCustomId('rost_time_zone')
        .setLabel('Time Zone')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const requestInput = new TextInputBuilder()
        .setCustomId('rost_request')
        .setLabel('Roster Request (details)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      const row1 = new ActionRowBuilder().addComponents(templateInput);
      const row2 = new ActionRowBuilder().addComponents(nameInput);
      const row3 = new ActionRowBuilder().addComponents(discordIdInput);
      const row4 = new ActionRowBuilder().addComponents(tzInput);
      const row5 = new ActionRowBuilder().addComponents(requestInput);

      modal.addComponents(row1, row2, row3, row4, row5);

      await interaction.showModal(modal);
      return;
    }
  }

  // -----------------------------------
  // Modal submit for applications, reports, and requests
  // -----------------------------------
  if (interaction.isModalSubmit()) {
    const settings = getSettings();

    // ----- Application modals -----
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

      const app = addApplication({
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
        .setFooter({ text: `Application ID: ${app.id}` })
        .setTimestamp(new Date(app.createdAt));

      const appLogChannelId =
        (settings.logs && settings.logs.applicationsLogChannelId) ||
        (config.channels && config.channels.applicationsChannelId);

      if (appLogChannelId) {
        try {
          const channel = await interaction.client.channels.fetch(
            appLogChannelId
          );
          if (channel && channel.isTextBased()) {
            const pingRoles = (settings.pings && settings.pings.applicationPingRoles) || [];
            const pingText = pingRoles.length
              ? pingRoles.map(id => `<@&${id}>`).join(' ')
              : null;
            await channel.send({ content: pingText || null, embeds: [embed] });
          }
        } catch (err) {
          console.error('Error sending application log:', err);
        }
      }

      await interaction.reply({
        content: `✅ Your application to **${divisionName}** has been submitted. A member of HR/High Command will review it.`,
        ephemeral: true
      });
      return;
    }

    // ----- Report modals -----
    if (interaction.customId.startsWith('report_modal_')) {
      const typeKey = interaction.customId.replace('report_modal_', '');
      const subject = interaction.fields.getTextInputValue('rep_subject');
      const details = interaction.fields.getTextInputValue('rep_details');
      const involved = interaction.fields.getTextInputValue('rep_involved') || 'N/A';

      const user = interaction.user;
      const guild = interaction.guild;

      const rcCfg = config.reportChannels || {};
      const logsSettings = (settings.logs && settings.logs.reports) || {};

      let channelId = null;
      let reportTitle = 'Report';

      if (typeKey === 'citation') {
        channelId = logsSettings.citationLogChannelId || rcCfg.citationLogChannelId;
        reportTitle = 'Citation Report';
      } else if (typeKey === 'arrest') {
        channelId = logsSettings.arrestLogChannelId || rcCfg.arrestLogChannelId;
        reportTitle = 'Arrest Report';
      } else if (typeKey === 'uof') {
        channelId = logsSettings.uofLogChannelId || rcCfg.uofLogChannelId;
        reportTitle = 'Use of Force Report';
      } else if (typeKey === 'reaper_aar') {
        channelId = logsSettings.reaperAARChannelId || rcCfg.reaperAARChannelId;
        reportTitle = 'REAPER After Action Report';
      } else if (typeKey === 'cid_incident') {
        channelId = logsSettings.cidIncidentLogChannelId || rcCfg.cidIncidentLogChannelId;
        reportTitle = 'CID Incident Log';
      } else if (typeKey === 'cid_case') {
        channelId = logsSettings.cidCaseReportChannelId || rcCfg.cidCaseReportChannelId;
        reportTitle = 'CID Case Report';
      } else if (typeKey === 'tu_shift') {
        channelId = logsSettings.tuShiftReportChannelId || rcCfg.tuShiftReportChannelId;
        reportTitle = 'TU Shift Report';
      }

      const reportData = addReport({
        id: `${interaction.id}`,
        type: typeKey,
        userId: user.id,
        subject,
        details,
        involved,
        createdAt: Date.now()
      });

      if (!channelId) {
        console.warn(`No report log channel configured for report type '${typeKey}'`);
        return interaction.reply({
          content: '⚠️ This report type is not configured yet. Please contact High Command.',
          ephemeral: true
        });
      }

      const embed = new EmbedBuilder()
        .setTitle(reportTitle)
        .setColor(0xf97316)
        .addFields(
          { name: 'Filed By', value: `<@${user.id}> (${user.id})`, inline: false },
          { name: 'Subject', value: subject || 'N/A', inline: false },
          { name: 'Details', value: details || 'N/A', inline: false },
          { name: 'Involved', value: involved, inline: false }
        )
        .setFooter({ text: `Report ID: ${reportData.id}` })
        .setTimestamp(new Date(reportData.createdAt));

      try {
        const logChannel = await guild.channels.fetch(channelId);
        if (logChannel && logChannel.isTextBased()) {
          const pingRoles = (settings.pings && settings.pings.reportPingRoles) || [];
          const pingText = pingRoles.length
            ? pingRoles.map(id => `<@&${id}>`).join(' ')
            : null;

          await logChannel.send({
            content: pingText || null,
            embeds: [embed]
          });
        } else {
          console.warn(`Report log channel not text-based or not found: ${channelId}`);
        }
      } catch (err) {
        console.error('Error sending report embed:', err);
      }

      return interaction.reply({
        content: `✅ Your **${reportTitle}** has been submitted.`,
        ephemeral: true
      });
    }

    // ----- Role Request modal -----
    if (interaction.customId === 'role_request_modal') {
      const name = interaction.fields.getTextInputValue('role_name');
      const rolesNeeded = interaction.fields.getTextInputValue('role_roles_needed');
      const approvedBy = interaction.fields.getTextInputValue('role_approved_by') || 'N/A';

      const reqData = addRoleRequest({
        id: `${interaction.id}`,
        userId: interaction.user.id,
        name,
        rolesNeeded,
        approvedBy,
        createdAt: Date.now()
      });

      const embed = new EmbedBuilder()
        .setTitle('Role Request')
        .setColor(0x22c55e)
        .addFields(
          { name: 'Requested By', value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: false },
          { name: 'Name', value: name || 'N/A', inline: false },
          { name: 'Roles needed', value: rolesNeeded || 'N/A', inline: false },
          { name: 'Approved by', value: approvedBy, inline: false }
        )
        .setFooter({ text: `Request ID: ${reqData.id}` })
        .setTimestamp(new Date(reqData.createdAt));

      const requestsLogChannelId =
        (settings.logs && settings.logs.requestsLogChannelId) || interaction.channel.id;

      try {
        const logChannel = await interaction.guild.channels.fetch(requestsLogChannelId);
        const finalChannel = logChannel && logChannel.isTextBased()
          ? logChannel
          : interaction.channel;

        const pingRoles = (settings.pings && settings.pings.requestPingRoles) || [];
        const pingText = pingRoles.length
          ? pingRoles.map(id => `<@&${id}>`).join(' ')
          : null;

        await finalChannel.send({
          content: pingText || null,
          embeds: [embed]
        });
      } catch (err) {
        console.error('Error sending role request embed:', err);
      }

      return interaction.reply({
        content: '✅ Your role request has been submitted.',
        ephemeral: true
      });
    }

    // ----- Roster Request modal -----
    if (interaction.customId === 'roster_request_modal') {
      const template = interaction.fields.getTextInputValue('rost_template');
      const name = interaction.fields.getTextInputValue('rost_name');
      const discordId = interaction.fields.getTextInputValue('rost_discord_id');
      const timeZone = interaction.fields.getTextInputValue('rost_time_zone');
      const requestText = interaction.fields.getTextInputValue('rost_request');

      const reqData = addRosterRequest({
        id: `${interaction.id}`,
        userId: interaction.user.id,
        template,
        name,
        discordId,
        timeZone,
        requestText,
        createdAt: Date.now()
      });

      const embed = new EmbedBuilder()
        .setTitle('Roster Request')
        .setColor(0x6366f1)
        .addFields(
          { name: 'Requested By', value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: false },
          { name: 'Template', value: template || 'N/A', inline: true },
          { name: 'Name (In-Game)', value: name || 'N/A', inline: true },
          { name: 'Discord ID', value: discordId || 'N/A', inline: false },
          { name: 'Time Zone', value: timeZone || 'N/A', inline: false },
          { name: 'Roster Request', value: requestText || 'N/A', inline: false }
        )
        .setFooter({ text: `Request ID: ${reqData.id}` })
        .setTimestamp(new Date(reqData.createdAt));

      const requestsLogChannelId =
        (settings.logs && settings.logs.requestsLogChannelId) || interaction.channel.id;

      try {
        const logChannel = await interaction.guild.channels.fetch(requestsLogChannelId);
        const finalChannel = logChannel && logChannel.isTextBased()
          ? logChannel
          : interaction.channel;

        const pingRoles = (settings.pings && settings.pings.requestPingRoles) || [];
        const pingText = pingRoles.length
          ? pingRoles.map(id => `<@&${id}>`).join(' ')
          : null;

        await finalChannel.send({
          content: pingText || null,
          embeds: [embed]
        });
      } catch (err) {
        console.error('Error sending roster request embed:', err);
      }

      return interaction.reply({
        content: '✅ Your roster request has been submitted.',
        ephemeral: true
      });
    }
  }
});

// ---------------------------
// Admin dashboard (Express + Discord OAuth)
// ---------------------------

const app = express();
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false
  })
);

// --------- OAuth helpers ---------

function buildDiscordOAuthUrl() {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds'
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

// --------- Discord admin guard ---------

async function discordAdminGuard(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/discord');
  }

  const settings = getSettings();
  const adminRoleIds = settings.adminRoleIds || [];

  if (!GUILD_ID) {
    return res.status(500).send('GUILD_ID not configured.');
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(req.session.user.id).catch(() => null);

    if (!member) {
      return res.status(403).send('You are not a member of this guild.');
    }

    if (adminRoleIds.length === 0) {
      // If no admin roles configured yet, allow any guild member with ManageGuild as "bootstrap"
      if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return next();
      }
      return res.status(403).send('Admin roles not configured; only server managers can access.');
    }

    const hasAdminRole = adminRoleIds.some(id => member.roles.cache.has(id));
    if (!hasAdminRole) {
      return res.status(403).send('You do not have access to this panel.');
    }

    next();
  } catch (err) {
    console.error('Error in admin guard:', err);
    return res.status(500).send('Internal error in admin guard.');
  }
}

// --------- OAuth routes ---------

app.get('/auth/discord', (req, res) => {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !OAUTH_REDIRECT_URI) {
    return res.status(500).send('OAuth not configured. Set DISCORD_OAUTH_CLIENT_ID, DISCORD_OAUTH_CLIENT_SECRET, DISCORD_OAUTH_REDIRECT_URI.');
  }
  const url = buildDiscordOAuthUrl();
  res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing code.');
  }
  try {
    const params = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: OAUTH_REDIRECT_URI
    });

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      body: params,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      console.error('OAuth token error:', txt);
      return res.status(500).send('OAuth token exchange failed.');
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!userRes.ok) {
      const txt = await userRes.text();
      console.error('OAuth user info error:', txt);
      return res.status(500).send('OAuth user info failed.');
    }

    const userData = await userRes.json();

    req.session.user = {
      id: userData.id,
      username: userData.username,
      discriminator: userData.discriminator
    };

    res.redirect('/admin');
  } catch (err) {
    console.error('Error in OAuth callback:', err);
    res.status(500).send('OAuth callback error.');
  }
});

// --------- Admin API: meta + settings + data ---------

app.get('/admin/api/meta', discordAdminGuard, async (req, res) => {
  try {
    if (!GUILD_ID) {
      return res.status(500).json({ error: 'GUILD_ID not configured.' });
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const channelsCollection = await guild.channels.fetch();
    const rolesCollection = await guild.roles.fetch();

    const channels = channelsCollection
      .filter(ch => ch && (ch.type === ChannelType.GuildText))
      .map(ch => ({
        id: ch.id,
        name: `#${ch.name}`
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const roles = rolesCollection
      .filter(r => r && !r.managed)
      .map(r => ({
        id: r.id,
        name: r.name
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const settings = getSettings();

    const tickets = listTickets();
    const reports = listReports();
    const roleRequests = listRoleRequests();
    const rosterRequests = listRosterRequests();

    res.json({
      guild: {
        id: guild.id,
        name: guild.name
      },
      user: req.session.user,
      channels,
      roles,
      settings,
      data: {
        tickets,
        reports,
        roleRequests,
        rosterRequests
      }
    });
  } catch (err) {
    console.error('Error in /admin/api/meta:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/admin/api/settings', discordAdminGuard, (req, res) => {
  try {
    const incoming = req.body || {};
    const saved = saveSettings(incoming);
    res.json({ ok: true, settings: saved });
  } catch (err) {
    console.error('Error in /admin/api/settings:', err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

// --------- Admin UI ---------

app.get('/admin', discordAdminGuard, (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>SALEA Admin Panel</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #020617; color: #e5e7eb; margin: 0; }
    header { background: #0f172a; padding: 16px 24px; border-bottom: 1px solid #1f2937; display: flex; justify-content: space-between; align-items: center; }
    h1 { font-size: 20px; margin: 0; color: #fbbf24; }
    main { padding: 20px; display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1.2fr); gap: 16px; }
    .card { background: #020617; border-radius: 12px; padding: 16px; border: 1px solid #1f2937; margin-bottom: 12px; }
    h2 { margin: 0 0 8px 0; font-size: 16px; color: #93c5fd; }
    label { display: block; margin-top: 8px; font-size: 13px; color: #9ca3af; }
    select, button { margin-top: 4px; background: #020617; color: #e5e7eb; border-radius: 6px; border: 1px solid #374151; padding: 6px 8px; font-size: 13px; width: 100%; }
    button { cursor: pointer; background: #fbbf24; color: #111827; border-color: #f59e0b; font-weight: 600; }
    button:hover { background: #f59e0b; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
    th, td { border-bottom: 1px solid #1f2937; padding: 4px 6px; text-align: left; }
    th { color: #9ca3af; text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; }
    code { background: #111827; padding: 2px 4px; border-radius: 4px; }
    .pill { display: inline-block; padding: 2px 6px; border-radius: 999px; font-size: 11px; background: #111827; color: #e5e7eb; }
    .pill.report { background: #7c3aed; }
    .pill.ticket { background: #2563eb; }
    .pill.request { background: #059669; }
    .section-title { font-size: 13px; font-weight: 600; margin-top: 8px; color: #e5e7eb; }
    .flex-row { display: flex; gap: 8px; }
    .flex-1 { flex: 1; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>SALEA Admin Panel</h1>
      <div id="guildInfo" style="font-size:12px;color:#9ca3af;"></div>
    </div>
    <div id="userInfo" style="font-size:12px;color:#9ca3af;"></div>
  </header>

  <main>
    <section>
      <div class="card">
        <h2>Routing Configuration</h2>
        <div class="section-title">Panels</div>
        <label>Applications Panel Channel
          <select id="panel_app"></select>
        </label>
        <label>Tickets Panel Channel
          <select id="panel_ticket"></select>
        </label>
        <label>Reports Panel Channel
          <select id="panel_report"></select>
        </label>
        <label>Requests Panel Channel
          <select id="panel_request"></select>
        </label>

        <div class="section-title" style="margin-top:12px;">Logs</div>
        <label>Applications Log Channel
          <select id="log_applications"></select>
        </label>
        <label>Ticket Transcript Channel
          <select id="log_tickets"></select>
        </label>
        <label>Requests Log Channel
          <select id="log_requests"></select>
        </label>

        <div class="flex-row">
          <div class="flex-1">
            <label>Citation Log Channel
              <select id="log_rep_citation"></select>
            </label>
          </div>
          <div class="flex-1">
            <label>Arrest Log Channel
              <select id="log_rep_arrest"></select>
            </label>
          </div>
        </div>
        <div class="flex-row">
          <div class="flex-1">
            <label>Use of Force Log Channel
              <select id="log_rep_uof"></select>
            </label>
          </div>
          <div class="flex-1">
            <label>REAPER AAR Log Channel
              <select id="log_rep_reaper"></select>
            </label>
          </div>
        </div>
        <div class="flex-row">
          <div class="flex-1">
            <label>CID Incident Log Channel
              <select id="log_rep_cid_incident"></select>
            </label>
          </div>
          <div class="flex-1">
            <label>CID Case Report Channel
              <select id="log_rep_cid_case"></select>
            </label>
          </div>
        </div>
        <label>TU Shift Report Channel
          <select id="log_rep_tu_shift"></select>
        </label>
      </div>

      <div class="card">
        <h2>Pings & Admin Roles</h2>
        <label>Roles to ping on Applications
          <select id="ping_applications" multiple size="4"></select>
        </label>
        <label>Roles to ping on Tickets
          <select id="ping_tickets" multiple size="4"></select>
        </label>
        <label>Roles to ping on Reports
          <select id="ping_reports" multiple size="4"></select>
        </label>
        <label>Roles to ping on Requests
          <select id="ping_requests" multiple size="4"></select>
        </label>
        <label>Admin Roles (can access this panel)
          <select id="admin_roles" multiple size="6"></select>
        </label>

        <button id="saveBtn" style="margin-top:12px;">Save Settings</button>
        <div id="saveStatus" style="font-size:12px;color:#a3e635;margin-top:6px;"></div>
      </div>
    </section>

    <section>
      <div class="card">
        <h2>Tickets</h2>
        <div id="ticketsTable"></div>
      </div>
      <div class="card">
        <h2>Reports</h2>
        <div id="reportsTable"></div>
      </div>
      <div class="card">
        <h2>Requests</h2>
        <div id="requestsTable"></div>
      </div>
    </section>
  </main>

  <script>
    async function fetchMeta() {
      const res = await fetch('/admin/api/meta');
      if (!res.ok) {
        throw new Error('Failed to load meta');
      }
      return await res.json();
    }

    function fillSelect(select, items, allowEmpty, currentValue) {
      select.innerHTML = '';
      if (allowEmpty) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '-- none --';
        select.appendChild(opt);
      }
      items.forEach(it => {
        const opt = document.createElement('option');
        opt.value = it.id;
        opt.textContent = it.name;
        if (currentValue && it.id === currentValue) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
    }

    function setMultiSelect(select, ids) {
      const set = new Set(ids || []);
      for (const opt of select.options) {
        opt.selected = set.has(opt.value);
      }
    }

    function getMultiSelect(select) {
      const values = [];
      for (const opt of select.options) {
        if (opt.selected && opt.value) {
          values.push(opt.value);
        }
      }
      return values;
    }

    function renderTickets(container, tickets) {
      if (!tickets || tickets.length === 0) {
        container.innerHTML = '<p style="font-size:12px;color:#9ca3af;">No tickets recorded yet.</p>';
        return;
      }
      const rows = tickets
        .slice()
        .sort((a,b) => b.createdAt - a.createdAt)
        .slice(0, 25)
        .map(t => {
          const created = new Date(t.createdAt).toLocaleString();
          const closed = t.closedAt ? new Date(t.closedAt).toLocaleString() : 'Open';
          return \`<tr>
            <td><span class="pill ticket">\${t.type}</span></td>
            <td><code>\${t.userId}</code></td>
            <td>\${t.subject || ''}</td>
            <td>\${created}</td>
            <td>\${closed}</td>
          </tr>\`;
        }).join('');
      container.innerHTML = \`
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>User</th>
              <th>Subject</th>
              <th>Created</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>\${rows}</tbody>
        </table>
      \`;
    }

    function renderReports(container, reports) {
      if (!reports || reports.length === 0) {
        container.innerHTML = '<p style="font-size:12px;color:#9ca3af;">No reports recorded yet.</p>';
        return;
      }
      const rows = reports
        .slice()
        .sort((a,b) => b.createdAt - a.createdAt)
        .slice(0, 25)
        .map(r => {
          const created = new Date(r.createdAt).toLocaleString();
          return \`<tr>
            <td><span class="pill report">\${r.type}</span></td>
            <td><code>\${r.userId}</code></td>
            <td>\${r.subject || ''}</td>
            <td>\${created}</td>
          </tr>\`;
        }).join('');
      container.innerHTML = \`
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>User</th>
              <th>Subject</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>\${rows}</tbody>
        </table>
      \`;
    }

    function renderRequests(container, roleRequests, rosterRequests) {
      const items = [];
      (roleRequests || []).forEach(r => {
        items.push({
          kind: 'role',
          id: r.id,
          userId: r.userId,
          title: r.name || '',
          extra: r.rolesNeeded || '',
          createdAt: r.createdAt
        });
      });
      (rosterRequests || []).forEach(r => {
        items.push({
          kind: 'roster',
          id: r.id,
          userId: r.userId,
          title: r.name || '',
          extra: r.requestText || '',
          createdAt: r.createdAt
        });
      });
      if (items.length === 0) {
        container.innerHTML = '<p style="font-size:12px;color:#9ca3af;">No requests recorded yet.</p>';
        return;
      }
      items.sort((a,b) => b.createdAt - a.createdAt);
      const rows = items.slice(0,25).map(it => {
        const created = new Date(it.createdAt).toLocaleString();
        const pillClass = it.kind === 'role' ? 'request' : 'request';
        const pillLabel = it.kind === 'role' ? 'Role' : 'Roster';
        return \`<tr>
          <td><span class="pill \${pillClass}">\${pillLabel}</span></td>
          <td><code>\${it.userId}</code></td>
          <td>\${it.title}</td>
          <td>\${it.extra}</td>
          <td>\${created}</td>
        </tr>\`;
      }).join('');
      container.innerHTML = \`
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>User</th>
              <th>Title</th>
              <th>Details</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>\${rows}</tbody>
        </table>
      \`;
    }

    async function init() {
      try {
        const meta = await fetchMeta();

        const channels = meta.channels || [];
        const roles = meta.roles || [];
        const settings = meta.settings || {};
        const logs = settings.logs || {};
        const panels = settings.panels || {};
        const pings = settings.pings || {};

        document.getElementById('guildInfo').textContent =
          meta.guild ? \`\${meta.guild.name} (\${meta.guild.id})\` : '';
        document.getElementById('userInfo').textContent =
          meta.user ? \`Logged in as \${meta.user.username}#\${meta.user.discriminator}\` : '';

        fillSelect(document.getElementById('panel_app'), channels, true, panels.appPanelChannelId);
        fillSelect(document.getElementById('panel_ticket'), channels, true, panels.ticketPanelChannelId);
        fillSelect(document.getElementById('panel_report'), channels, true, panels.reportPanelChannelId);
        fillSelect(document.getElementById('panel_request'), channels, true, panels.requestPanelChannelId);

        fillSelect(document.getElementById('log_applications'), channels, true, logs.applicationsLogChannelId);
        fillSelect(document.getElementById('log_tickets'), channels, true, logs.ticketTranscriptChannelId);
        fillSelect(document.getElementById('log_requests'), channels, true, logs.requestsLogChannelId);

        const repLogs = logs.reports || {};
        fillSelect(document.getElementById('log_rep_citation'), channels, true, repLogs.citationLogChannelId);
        fillSelect(document.getElementById('log_rep_arrest'), channels, true, repLogs.arrestLogChannelId);
        fillSelect(document.getElementById('log_rep_uof'), channels, true, repLogs.uofLogChannelId);
        fillSelect(document.getElementById('log_rep_reaper'), channels, true, repLogs.reaperAARChannelId);
        fillSelect(document.getElementById('log_rep_cid_incident'), channels, true, repLogs.cidIncidentLogChannelId);
        fillSelect(document.getElementById('log_rep_cid_case'), channels, true, repLogs.cidCaseReportChannelId);
        fillSelect(document.getElementById('log_rep_tu_shift'), channels, true, repLogs.tuShiftReportChannelId);

        fillSelect(document.getElementById('ping_applications'), roles, false, null);
        fillSelect(document.getElementById('ping_tickets'), roles, false, null);
        fillSelect(document.getElementById('ping_reports'), roles, false, null);
        fillSelect(document.getElementById('ping_requests'), roles, false, null);
        fillSelect(document.getElementById('admin_roles'), roles, false, null);

        setMultiSelect(document.getElementById('ping_applications'), pings.applicationPingRoles || []);
        setMultiSelect(document.getElementById('ping_tickets'), pings.ticketPingRoles || []);
        setMultiSelect(document.getElementById('ping_reports'), pings.reportPingRoles || []);
        setMultiSelect(document.getElementById('ping_requests'), pings.requestPingRoles || []);
        setMultiSelect(document.getElementById('admin_roles'), settings.adminRoleIds || []);

        renderTickets(document.getElementById('ticketsTable'), meta.data.tickets);
        renderReports(document.getElementById('reportsTable'), meta.data.reports);
        renderRequests(
          document.getElementById('requestsTable'),
          meta.data.roleRequests,
          meta.data.rosterRequests
        );

        document.getElementById('saveBtn').addEventListener('click', async () => {
          const payload = {
            panels: {
              appPanelChannelId: document.getElementById('panel_app').value || null,
              ticketPanelChannelId: document.getElementById('panel_ticket').value || null,
              reportPanelChannelId: document.getElementById('panel_report').value || null,
              requestPanelChannelId: document.getElementById('panel_request').value || null
            },
            logs: {
              applicationsLogChannelId: document.getElementById('log_applications').value || null,
              ticketTranscriptChannelId: document.getElementById('log_tickets').value || null,
              requestsLogChannelId: document.getElementById('log_requests').value || null,
              reports: {
                citationLogChannelId: document.getElementById('log_rep_citation').value || null,
                arrestLogChannelId: document.getElementById('log_rep_arrest').value || null,
                uofLogChannelId: document.getElementById('log_rep_uof').value || null,
                reaperAARChannelId: document.getElementById('log_rep_reaper').value || null,
                cidIncidentLogChannelId: document.getElementById('log_rep_cid_incident').value || null,
                cidCaseReportChannelId: document.getElementById('log_rep_cid_case').value || null,
                tuShiftReportChannelId: document.getElementById('log_rep_tu_shift').value || null
              }
            },
            pings: {
              applicationPingRoles: getMultiSelect(document.getElementById('ping_applications')),
              ticketPingRoles: getMultiSelect(document.getElementById('ping_tickets')),
              reportPingRoles: getMultiSelect(document.getElementById('ping_reports')),
              requestPingRoles: getMultiSelect(document.getElementById('ping_requests'))
            },
            adminRoleIds: getMultiSelect(document.getElementById('admin_roles'))
          };

          const res = await fetch('/admin/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const statusEl = document.getElementById('saveStatus');
          if (res.ok) {
            statusEl.textContent = 'Settings saved.';
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
          } else {
            statusEl.textContent = 'Failed to save settings.';
          }
        });
      } catch (err) {
        console.error('Error in admin init:', err);
        document.body.innerHTML = '<p style="color:white;padding:20px;">Failed to load admin panel.</p>';
      }
    }

    init();
  </script>
</body>
</html>
  `;
  res.status(200).send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Admin dashboard listening on port ${PORT}`);
});

// ---------------------------
// Start the bot
// ---------------------------

client.login(BOT_TOKEN);
