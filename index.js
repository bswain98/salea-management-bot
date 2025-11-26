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
const basicAuth = require('express-basic-auth');

const {
  addApplication,
  updateApplicationStatus,
  getLatestApplicationForUser,
  addTicket,
  closeTicket,
  clockIn,
  clockOut,
  getOpenSession,
  getAllOpenSessions,
  getSessionsForUserInRange,
  getSessionsInRange
} = require('./storage');

const config = require('./config.json');

// --------- Env vars (tokens & IDs) ---------
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!BOT_TOKEN) {
  console.error('❌ DISCORD_TOKEN is not set. Set it in Render (or your .env).');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('❌ DISCORD_CLIENT_ID is not set.');
}
if (!GUILD_ID) {
  console.error('❌ DISCORD_GUILD_ID is not set.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// In-memory message ID for duty board
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
  const channelId = config.channels.clockStatusChannelId;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[DutyBoard] Channel not found or not text based for ID:', channelId);
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

      const channel = config.applicationPanel.channelId
        ? await interaction.guild.channels.fetch(config.applicationPanel.channelId)
        : interaction.channel;

      await channel.send({ embeds: [embed], components: [row, row2] });
      return interaction.reply({
        content: '✅ Application panel posted.',
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

        const onDutyRoleId2 = config.roles.onDutyRoleId || null;
        if (onDutyRoleId2 && member.roles.cache.has(onDutyRoleId2)) {
          await member.roles.remove(onDutyRoleId2).catch(() => {});
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

      await interaction.channel.send({
        embeds: [ticketEmbed],
        components: [row1]
      });

      return interaction.reply({
        content: '✅ Ticket panel posted.',
        ephemeral: true
      });
    }

    // ----------------- /setup-report-panel -----------------
    if (commandName === 'setup-report-panel') {
      const member = await interaction.guild.members.fetch(interaction.user.id);

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

      await interaction.channel.send({
        embeds: [reportEmbed],
        components: [row1, row2]
      });

      return interaction.reply({
        content: '✅ Report panel posted.',
        ephemeral: true
      });
    }

    // ----------------- /setup-request-panel -----------------
    if (commandName === 'setup-request-panel') {
      const member = await interaction.guild.members.fetch(interaction.user.id);

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
          'All requests will be logged in this channel so Command can review and check them off.'
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

      await interaction.channel.send({
        embeds: [embed],
        components: [row]
      });

      return interaction.reply({
        content: '✅ Request panel posted.',
        ephemeral: true
      });
    }
  }

  // -----------------------------------
  // Button interactions (applications, tickets, reports, requests)
  // -----------------------------------
  if (interaction.isButton()) {
    const id = interaction.customId;

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

      const rc = config.reportChannels || {};
      let channelId = null;
      let reportTitle = 'Report';

      if (typeKey === 'citation') {
        channelId = rc.citationLogChannelId;
        reportTitle = 'Citation Report';
      } else if (typeKey === 'arrest') {
        channelId = rc.arrestLogChannelId;
        reportTitle = 'Arrest Report';
      } else if (typeKey === 'uof') {
        channelId = rc.uofLogChannelId;
        reportTitle = 'Use of Force Report';
      } else if (typeKey === 'reaper_aar') {
        channelId = rc.reaperAARChannelId;
        reportTitle = 'REAPER After Action Report';
      } else if (typeKey === 'cid_incident') {
        channelId = rc.cidIncidentLogChannelId;
        reportTitle = 'CID Incident Log';
      } else if (typeKey === 'cid_case') {
        channelId = rc.cidCaseReportChannelId;
        reportTitle = 'CID Case Report';
      } else if (typeKey === 'tu_shift') {
        channelId = rc.tuShiftReportChannelId;
        reportTitle = 'TU Shift Report';
      }

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
        .setTimestamp(new Date());

      try {
        const logChannel = await guild.channels.fetch(channelId);
        if (logChannel && logChannel.isTextBased()) {
          await logChannel.send({ embeds: [embed] });
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

      const embed = new EmbedBuilder()
        .setTitle('Role Request')
        .setColor(0x22c55e)
        .addFields(
          { name: 'Requested By', value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: false },
          { name: 'Name', value: name || 'N/A', inline: false },
          { name: 'Roles needed', value: rolesNeeded || 'N/A', inline: false },
          { name: 'Approved by', value: approvedBy, inline: false }
        )
        .setTimestamp(new Date());

      await interaction.channel.send({ embeds: [embed] });

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
        .setTimestamp(new Date());

      await interaction.channel.send({ embeds: [embed] });

      return interaction.reply({
        content: '✅ Your roster request has been submitted.',
        ephemeral: true
      });
    }
  }
});

// ---------------------------
// Admin dashboard (Express)
// ---------------------------

const app = express();

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password';

app.use(
  '/admin',
  basicAuth({
    users: { [ADMIN_USER]: ADMIN_PASS },
    challenge: true
  })
);

app.get('/admin', (req, res) => {
  try {
    const cfg = config || {};
    const roles = cfg.roles || {};
    const channels = cfg.channels || {};

    const openSessions = getAllOpenSessions ? getAllOpenSessions() : [];

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentSessions = getSessionsInRange ? getSessionsInRange(sevenDaysAgo, null) : [];
    const totalMs = recentSessions.reduce((acc, s) => acc + (s.clockOut - s.clockIn), 0);

    const formatMs = ms => {
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const parts = [];
      if (h) parts.push(`${h}h`);
      if (m) parts.push(`${m}m`);
      return parts.length ? parts.join(' ') : '0m';
    };

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>SALEA Admin Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e5e7eb; padding: 20px; }
    h1 { color: #fbbf24; }
    h2 { margin-top: 24px; color: #93c5fd; }
    .card { background: #020617; border-radius: 12px; padding: 16px; margin-top: 12px; border: 1px solid #1f2937; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border-bottom: 1px solid #1f2937; padding: 6px 8px; text-align: left; font-size: 14px; }
    th { color: #9ca3af; text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; }
    code { background: #111827; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>SALEA Admin Dashboard</h1>
  <p>Logged in as <strong>${req.auth?.user || 'unknown'}</strong></p>

  <div class="card">
    <h2>Duty Overview (last 7 days)</h2>
    <p>Total completed sessions: <strong>${recentSessions.length}</strong></p>
    <p>Total duty time: <strong>${formatMs(totalMs)}</strong></p>
  </div>

  <div class="card">
    <h2>On Duty Now</h2>
    ${
      openSessions.length === 0
        ? '<p>No one is currently clocked in.</p>'
        : `
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Assignments</th>
              <th>Started</th>
              <th>Elapsed</th>
            </tr>
          </thead>
          <tbody>
            ${openSessions
              .map(s => {
                const assignments = Array.isArray(s.assignments)
                  ? s.assignments
                  : [];
                const started = new Date(s.clockIn);
                const elapsed = formatMs(Date.now() - s.clockIn);
                return `
                  <tr>
                    <td><code>${s.userId}</code></td>
                    <td>${assignments.join(', ') || 'Unspecified'}</td>
                    <td>${started.toISOString()}</td>
                    <td>${elapsed}</td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      `
    }
  </div>

  <div class="card">
    <h2>Config Snapshot</h2>
    <p><strong>Roles object keys:</strong> ${Object.keys(roles).join(', ') || 'none'}</p>
    <p><strong>Channels object keys:</strong> ${Object.keys(channels).join(', ') || 'none'}</p>
  </div>
</body>
</html>
    `;

    res.status(200).send(html);
  } catch (err) {
    console.error('Error in /admin handler:', err);
    res.status(500).send('Internal server error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Admin dashboard listening on port ${PORT}`);
});

// ---------------------------
// Start the bot
// ---------------------------

client.login(BOT_TOKEN);
