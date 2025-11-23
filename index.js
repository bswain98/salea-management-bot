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

const rawConfig = require('./config.json');

// ---------- ENV SECRETS ----------
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.warn('⚠️ DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID not set. (Required in cloud hosting)');
}

// ---------- ID SANITIZER ----------
function extractId(value) {
  if (!value || typeof value !== 'string') return null;
  const matches = value.match(/\d{15,}/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1];
}

const config = {
  ...rawConfig,
  roles: {
    ...rawConfig.roles,
    onDutyRoleId: extractId(rawConfig.roles?.onDutyRoleId)
  },
  channels: {
    ...rawConfig.channels,
    clockStatusChannelId: extractId(rawConfig.channels?.clockStatusChannelId)
  }
};

console.log('[Config] clockStatusChannelId (raw):', rawConfig.channels?.clockStatusChannelId);
console.log('[Config] clockStatusChannelId (parsed):', config.channels.clockStatusChannelId);
console.log('[Config] onDutyRoleId (raw):', rawConfig.roles?.onDutyRoleId);
console.log('[Config] onDutyRoleId (parsed):', config.roles.onDutyRoleId);

// ---------- DISCORD CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

let dutyBoardMessageId = null;

// ---------- UTILS ----------
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

async function updateDutyBoard(guild) {
  console.log('[DutyBoard] Updating duty board...');

  const channelId = config.channels.clockStatusChannelId;
  console.log('[DutyBoard] Using channelId:', channelId);
  if (!channelId) {
    console.log('[DutyBoard] No valid clockStatusChannelId after parsing');
    return;
  }

  const channel = await guild.channels.fetch(channelId).catch(err => {
    console.error('[DutyBoard] Failed to fetch channel:', err);
    return null;
  });

  if (!channel) {
    console.log('[DutyBoard] Channel not found for ID:', channelId);
    return;
  }

  if (!channel.isTextBased()) {
    console.log('[DutyBoard] Channel is not text-based:', channelId);
    return;
  }

  const sessions = getAllOpenSessions();
  console.log('[DutyBoard] Open sessions count:', sessions ? sessions.length : 'null');

  if (!sessions || sessions.length === 0) {
    const content = '📋 **On Duty Board**\nNo one is currently clocked in.';
    try {
      if (dutyBoardMessageId) {
        const msg = await channel.messages.fetch(dutyBoardMessageId).catch(() => null);
        if (msg) {
          await msg.edit(content);
          console.log('[DutyBoard] Updated existing empty board message');
          return;
        }
      }

      const newMsg = await channel.send(content);
      dutyBoardMessageId = newMsg.id;
      console.log('[DutyBoard] Sent new empty board message, id =', dutyBoardMessageId);
    } catch (err) {
      console.error('[DutyBoard] Error sending/updating empty board message:', err);
    }
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

  const content = '📋 **On Duty Board**\n' + lines.join('\n');

  try {
    if (dutyBoardMessageId) {
      const msg = await channel.messages.fetch(dutyBoardMessageId).catch(() => null);
      if (msg) {
        await msg.edit(content);
        console.log('[DutyBoard] Updated existing board message');
        return;
      }
    }

    const newMsg = await channel.send(content);
    dutyBoardMessageId = newMsg.id;
    console.log('[DutyBoard] Sent new board message, id =', dutyBoardMessageId);
  } catch (err) {
    console.error('[DutyBoard] Error sending/updating board message:', err);
  }
}

// ---------- SLASH COMMANDS ----------
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

  // /ticket
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

  // /clock
  new SlashCommandBuilder()
    .setName('clock')
    .setDescription('Clock in and out of duty.')
    .addSubcommand(sub =>
      sub
        .setName('in')
        .setDescription('Clock in for duty.')
        .addStringOption(opt =>
          opt
            .setName('assignment_primary')
            .setDescription('Primary unit/subdivision.')
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
        .addStringOption(opt =>
          opt
            .setName('assignment_secondary')
            .setDescription('Secondary unit/subdivision (optional).')
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
        .addStringOption(opt =>
          opt
            .setName('assignment_tertiary')
            .setDescription('Tertiary unit/subdivision (optional).')
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

  // /activity
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

  // /report
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Submit an official department report.')
    .addStringOption(opt =>
      opt
        .setName('type')
        .setDescription('Type of report to submit.')
        .setRequired(true)
        .addChoices(
          { name: 'Citation Report', value: 'citation' },
          { name: 'Arrest Report', value: 'arrest' },
          { name: 'Use of Force Report', value: 'uof' },
          { name: 'After Action Report (REAPER)', value: 'reaper_aar' },
          { name: 'CID Incident Log', value: 'cid_incident' },
          { name: 'CID Case Report', value: 'cid_case' },
          { name: 'TU Shift Report', value: 'tu_shift' }
        )
    ),

  // /dutyboard
  new SlashCommandBuilder()
    .setName('dutyboard')
    .setDescription('Manage the duty board.')
    .addSubcommand(sub =>
      sub
        .setName('refresh')
        .setDescription('Force-refresh the on-duty board.')
    )
].map(cmd => cmd.toJSON());

// ---------- REGISTER SLASH COMMANDS ----------
client.once(Events.ClientReady, async readyClient => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);

  if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.warn('⚠️ Missing DISCORD env vars; slash commands may not register in cloud.');
    return;
  }

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
});

// ---------- INTERACTION HANDLER ----------
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

      const panelChannel = rawConfig.applicationPanel?.channelId
        ? await interaction.guild.channels.fetch(rawConfig.applicationPanel.channelId)
        : interaction.channel;

      await panelChannel.send({ embeds: [embed], components: [row, row2] });
      return interaction.reply({
        content: '✅ Application panel posted.',
        ephemeral: true
      });
    }

    // /app
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
            rawConfig.channels.applicationsChannelId
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
            rawConfig.channels.applicationsChannelId
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

    // /ticket
    if (commandName === 'ticket') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'open') {
        const type = interaction.options.getString('type');
        const subject = interaction.options.getString('subject');
        const guild = interaction.guild;

        let categoryId = null;
        if (type === 'general') categoryId = rawConfig.categories.ticketGeneralCategoryId;
        if (type === 'ia') categoryId = rawConfig.categories.ticketIACategoryId;
        if (type === 'training') categoryId = rawConfig.categories.ticketTrainingCategoryId;
        if (type === 'tech') categoryId = rawConfig.categories.ticketTechCategoryId;

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
          rawConfig.categories.ticketGeneralCategoryId,
          rawConfig.categories.ticketIACategoryId,
          rawConfig.categories.ticketTrainingCategoryId,
          rawConfig.categories.ticketTechCategoryId
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
            rawConfig.channels.ticketTranscriptChannelId
          );
          if (logChannel && logChannel.isTextBased()) {
            const embed = new EmbedBuilder()
              .setTitle('Ticket Closed')
              .setColor(0xffa500)
              .addFields(
                { name: 'Channel', value: `#${channel.name} (${channel.id})`, inline: false },
                { name: 'Closed By', value: `<@${interaction.user.id}>`, inline: true },
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
        const primary = interaction.options.getString('assignment_primary');
        const secondary = interaction.options.getString('assignment_secondary');
        const tertiary = interaction.options.getString('assignment_tertiary');

        const open = getOpenSession(interaction.user.id);
        if (open) {
          return interaction.reply({
            content: '⚠️ You are already clocked in.',
            ephemeral: true
          });
        }

        const assignments = [primary, secondary, tertiary]
          .filter(Boolean)
          .filter((v, i, arr) => arr.indexOf(v) === i);

        const session = clockIn(interaction.user.id, assignments);
        if (!session) {
          return interaction.reply({
            content: '⚠️ Could not clock you in (already in session?).',
            ephemeral: true
          });
        }

        const onDutyRoleId = config.roles.onDutyRoleId;
        const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (guildMember && onDutyRoleId) {
          await guildMember.roles.add(onDutyRoleId).catch(() => {});
        }

        await updateDutyBoard(interaction.guild);

        await interaction.reply({
          content: `✅ You are now clocked in as **${assignments.join(', ')}**.`,
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

        const onDutyRoleId = config.roles.onDutyRoleId;
        const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (guildMember && onDutyRoleId) {
          await guildMember.roles.remove(onDutyRoleId).catch(() => {});
        }

        await updateDutyBoard(interaction.guild);

        const duration = session.clockOut - session.clockIn;
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

        let assignmentsText = '';
        if (Array.isArray(open.assignments) && open.assignments.length > 0) {
          assignmentsText = `Assignments: **${open.assignments.join(', ')}**\n`;
        } else if (open.assignment) {
          assignmentsText = `Assignment: **${open.assignment}**\n`;
        }

        await interaction.reply({
          content:
            `⏱️ You are currently clocked in.\n${assignmentsText}` +
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

    // /report
    if (commandName === 'report') {
      const type = interaction.options.getString('type');
      const member = await interaction.guild.members.fetch(interaction.user.id);

      const swornRoles = config.roles.swornRoleIds || [];
      const isSworn = hasAnyRole(member, swornRoles);
      if (!isSworn) {
        return interaction.reply({
          content: '❌ Only sworn personnel may file official reports.',
          ephemeral: true
        });
      }

      let title = 'Report';
      let modalId = `report_${type}`;

      const modal = new ModalBuilder().setCustomId(modalId);

      const rows = [];
      function addField(customId, label, style, required = true) {
        const input = new TextInputBuilder()
          .setCustomId(customId)
          .setLabel(label)
          .setStyle(style)
          .setRequired(required);
        rows.push(new ActionRowBuilder().addComponents(input));
      }

      if (type === 'citation') {
        title = 'Citation Report';
        addField('subject_name', 'Subject Name', TextInputStyle.Short);
        addField('subject_dob', 'Subject DOB', TextInputStyle.Short);
        addField('violations', 'Violations / Statutes', TextInputStyle.Paragraph);
        addField('location', 'Location of Stop / Incident', TextInputStyle.Short);
        addField('narrative', 'Narrative / Details', TextInputStyle.Paragraph);
      } else if (type === 'arrest') {
        title = 'Arrest Report';
        addField('subject_name', 'Subject Name', TextInputStyle.Short);
        addField('subject_dob', 'Subject DOB', TextInputStyle.Short);
        addField('charges', 'Charges Filed', TextInputStyle.Paragraph);
        addField('report_number', 'Report / Case Number', TextInputStyle.Short);
        addField('narrative', 'Narrative / Probable Cause', TextInputStyle.Paragraph);
      } else if (type === 'uof') {
        title = 'Use of Force Report';
        addField('incident_datetime', 'Incident Date & Time', TextInputStyle.Short);
        addField('location', 'Location', TextInputStyle.Short);
        addField('force_used', 'Type(s) of Force Used', TextInputStyle.Paragraph);
        addField('injuries', 'Injuries / Medical (N/A if none)', TextInputStyle.Paragraph);
        addField('summary', 'Incident Summary', TextInputStyle.Paragraph);
      } else if (type === 'reaper_aar') {
        title = 'After Action Report (REAPER)';
        addField('operation_name', 'Operation Name', TextInputStyle.Short);
        addField('operation_datetime', 'Date & Time', TextInputStyle.Short);
        addField('objective', 'Objective(s)', TextInputStyle.Paragraph);
        addField('outcome', 'Outcome / Results', TextInputStyle.Paragraph);
        addField('lessons', 'Lessons Learned / Notes', TextInputStyle.Paragraph);
      } else if (type === 'cid_incident') {
        title = 'CID Incident Log';
        addField('incident_title', 'Incident Title', TextInputStyle.Short);
        addField('case_number', 'Case Number', TextInputStyle.Short);
        addField('involved_units', 'Involved Units / Officers', TextInputStyle.Paragraph);
        addField('summary', 'Summary', TextInputStyle.Paragraph);
        addField('next_steps', 'Next Steps / Follow-up', TextInputStyle.Paragraph);
      } else if (type === 'cid_case') {
        title = 'CID Case Report';
        addField('case_number', 'Case Number', TextInputStyle.Short);
        addField('status', 'Case Status (Open / Closed / etc.)', TextInputStyle.Short);
        addField('suspects', 'Suspect(s)', TextInputStyle.Paragraph);
        addField('evidence', 'Key Evidence', TextInputStyle.Paragraph);
        addField('summary', 'Case Summary', TextInputStyle.Paragraph);
      } else if (type === 'tu_shift') {
        title = 'TU Shift Report';
        addField('shift_date', 'Shift Date', TextInputStyle.Short);
        addField('unit', 'Unit / Call Sign', TextInputStyle.Short);
        addField('activity', 'Stops / Citations / Arrests Summary', TextInputStyle.Paragraph);
        addField('conditions', 'Road / Weather / Traffic Conditions', TextInputStyle.Paragraph);
        addField('notes', 'Additional Notes', TextInputStyle.Paragraph);
      } else {
        return interaction.reply({
          content: '❌ Unknown report type.',
          ephemeral: true
        });
      }

      modal.setTitle(title);
      modal.addComponents(...rows.slice(0, 5));

      await interaction.showModal(modal);
    }

    // /dutyboard
    if (commandName === 'dutyboard') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'refresh') {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const hcRoles = config.roles.highCommandRoleIds || [];
        if (!hasAnyRole(member, hcRoles)) {
          return interaction.reply({
            content: '❌ Only High Command may refresh the duty board.',
            ephemeral: true
          });
        }

        await updateDutyBoard(interaction.guild);
        return interaction.reply({
          content: '✅ Duty board refresh requested. Check the duty channel.',
          ephemeral: true
        });
      }
    }
  }

  // Button interactions (applications)
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

  // Modal submits (applications + reports)
  if (interaction.isModalSubmit()) {
    // Applications
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
          rawConfig.channels.applicationsChannelId
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

    // Reports
    if (interaction.customId.startsWith('report_')) {
      const type = interaction.customId.replace('report_', '');
      const reportChannels = rawConfig.reportChannels || {};

      let logChannelId = null;
      let title = 'Report';
      let color = 0x00aeff;
      const fields = [];

      function pushField(name, value, inline = false) {
        fields.push({ name, value: value || 'N/A', inline });
      }

      if (type === 'citation') {
        logChannelId = reportChannels.citationLogChannelId;
        title = 'Citation Report';
        const subjectName = interaction.fields.getTextInputValue('subject_name');
        const subjectDob = interaction.fields.getTextInputValue('subject_dob');
        const violations = interaction.fields.getTextInputValue('violations');
        const location = interaction.fields.getTextInputValue('location');
        const narrative = interaction.fields.getTextInputValue('narrative');

        pushField('Subject Name', subjectName, true);
        pushField('DOB', subjectDob, true);
        pushField('Location', location, false);
        pushField('Violations / Statutes', violations, false);
        pushField('Narrative', narrative, false);
        color = 0x3498db;
      } else if (type === 'arrest') {
        logChannelId = reportChannels.arrestLogChannelId;
        title = 'Arrest Report';
        const subjectName = interaction.fields.getTextInputValue('subject_name');
        const subjectDob = interaction.fields.getTextInputValue('subject_dob');
        const charges = interaction.fields.getTextInputValue('charges');
        const reportNumber = interaction.fields.getTextInputValue('report_number');
        const narrative = interaction.fields.getTextInputValue('narrative');

        pushField('Subject Name', subjectName, true);
        pushField('DOB', subjectDob, true);
        pushField('Report / Case #', reportNumber, true);
        pushField('Charges', charges, false);
        pushField('Narrative / Probable Cause', narrative, false);
        color = 0xe67e22;
      } else if (type === 'uof') {
        logChannelId = reportChannels.uofLogChannelId;
        title = 'Use of Force Report';
        const dt = interaction.fields.getTextInputValue('incident_datetime');
        const location = interaction.fields.getTextInputValue('location');
        const forceUsed = interaction.fields.getTextInputValue('force_used');
        const injuries = interaction.fields.getTextInputValue('injuries');
        const summary = interaction.fields.getTextInputValue('summary');

        pushField('Date & Time', dt, true);
        pushField('Location', location, true);
        pushField('Force Used', forceUsed, false);
        pushField('Injuries / Medical', injuries, false);
        pushField('Summary', summary, false);
        color = 0xc0392b;
      } else if (type === 'reaper_aar') {
        logChannelId = reportChannels.reaperAARChannelId;
        title = 'After Action Report (REAPER)';
        const opName = interaction.fields.getTextInputValue('operation_name');
        const dt = interaction.fields.getTextInputValue('operation_datetime');
        const objective = interaction.fields.getTextInputValue('objective');
        const outcome = interaction.fields.getTextInputValue('outcome');
        const lessons = interaction.fields.getTextInputValue('lessons');

        pushField('Operation Name', opName, true);
        pushField('Date & Time', dt, true);
        pushField('Objectives', objective, false);
        pushField('Outcome', outcome, false);
        pushField('Lessons Learned / Notes', lessons, false);
        color = 0x9b59b6;
      } else if (type === 'cid_incident') {
        logChannelId = reportChannels.cidIncidentLogChannelId;
        title = 'CID Incident Log';
        const incidentTitle = interaction.fields.getTextInputValue('incident_title');
        const caseNumber = interaction.fields.getTextInputValue('case_number');
        const units = interaction.fields.getTextInputValue('involved_units');
        const summary = interaction.fields.getTextInputValue('summary');
        const nextSteps = interaction.fields.getTextInputValue('next_steps');

        pushField('Incident Title', incidentTitle, true);
        pushField('Case Number', caseNumber, true);
        pushField('Involved Units / Officers', units, false);
        pushField('Summary', summary, false);
        pushField('Next Steps / Follow-up', nextSteps, false);
        color = 0x1abc9c;
      } else if (type === 'cid_case') {
        logChannelId = reportChannels.cidCaseReportChannelId;
        title = 'CID Case Report';
        const caseNumber = interaction.fields.getTextInputValue('case_number');
        const status = interaction.fields.getTextInputValue('status');
        const suspects = interaction.fields.getTextInputValue('suspects');
        const evidence = interaction.fields.getTextInputValue('evidence');
        const summary = interaction.fields.getTextInputValue('summary');

        pushField('Case Number', caseNumber, true);
        pushField('Status', status, true);
        pushField('Suspect(s)', suspects, false);
        pushField('Key Evidence', evidence, false);
        pushField('Case Summary', summary, false);
        color = 0x16a085;
      } else if (type === 'tu_shift') {
        logChannelId = reportChannels.tuShiftReportChannelId;
        title = 'TU Shift Report';
        const shiftDate = interaction.fields.getTextInputValue('shift_date');
        const unit = interaction.fields.getTextInputValue('unit');
        const activity = interaction.fields.getTextInputValue('activity');
        const conditions = interaction.fields.getTextInputValue('conditions');
        const notes = interaction.fields.getTextInputValue('notes');

        pushField('Shift Date', shiftDate, true);
        pushField('Unit / Call Sign', unit, true);
        pushField('Activity Summary', activity, false);
        pushField('Conditions', conditions, false);
        pushField('Additional Notes', notes, false);
        color = 0xf1c40f;
      } else {
        return interaction.reply({
          content: '❌ Unknown report type.',
          ephemeral: true
        });
      }

      if (!logChannelId) {
        return interaction.reply({
          content: '⚠️ No log channel configured for this report type. Please notify High Command.',
          ephemeral: true
        });
      }

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .addFields(...fields)
        .setFooter({ text: `Filed by ${interaction.user.tag} (${interaction.user.id})` })
        .setTimestamp(new Date());

      try {
        const channel = await interaction.client.channels.fetch(logChannelId);
        if (!channel || !channel.isTextBased()) {
          throw new Error('Log channel invalid or not text-based.');
        }

        await channel.send({ embeds: [embed] });

        await interaction.reply({
          content: `✅ Your **${title}** has been logged.`,
          ephemeral: true
        });
      } catch (err) {
        console.error('Error sending report log:', err);
        await interaction.reply({
          content: '❌ Failed to send report to the log channel. Please notify High Command.',
          ephemeral: true
        });
      }
    }
  }
});

// ---------- START DISCORD BOT ----------
if (BOT_TOKEN) {
  client.login(BOT_TOKEN);
} else {
  console.error('❌ DISCORD_TOKEN not set; bot will not log in.');
}

// ---------- ADMIN DASHBOARD (EXPRESS) ----------
const app = express();

const adminUser = process.env.ADMIN_USER || 'admin';
const adminPass = process.env.ADMIN_PASS || 'changeme';

app.use(
  '/admin',
  basicAuth({
    users: { [adminUser]: adminPass },
    challenge: true,
    realm: 'SALEA-Admin'
  })
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('SALEA Management Bot is running.');
});

app.get('/admin', (req, res) => {
  try {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const openSessions = getAllOpenSessions() || [];
    const recentSessions = getSessionsInRange(weekAgo, null) || [];

    const html = `
      <html>
      <head>
        <title>SALEA Admin Dashboard</title>
        <style>
          body { font-family: Arial, sans-serif; background: #0b1622; color: #f5f5f5; padding: 20px; }
          h1 { color: #f1c40f; }
          h2 { color: #3498db; }
          .card { background: #111827; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
          table { width: 100%; border-collapse: collapse; margin-top: 8px; }
          th, td { padding: 8px; border-bottom: 1px solid #1f2937; }
          th { text-align: left; color: #9ca3af; font-weight: 600; }
          .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #1f2937; font-size: 12px; margin-right: 4px; }
        </style>
      </head>
      <body>
        <h1>SALEA Admin Dashboard</h1>

        <div class="card">
          <h2>On Duty Right Now</h2>
          <p>Total on duty: <strong>${openSessions.length}</strong></p>
          <table>
            <tr>
              <th>User ID</th>
              <th>Assignments</th>
              <th>Clock In</th>
              <th>Elapsed</th>
            </tr>
            ${openSessions
              .map(s => {
                const assignments = Array.isArray(s.assignments)
                  ? s.assignments.join(', ')
                  : (s.assignment || 'Unspecified');
                const started = new Date(s.clockIn).toLocaleString();
                const elapsed = msToHuman(now - s.clockIn);
                return `
                  <tr>
                    <td>${s.userId}</td>
                    <td>${assignments}</td>
                    <td>${started}</td>
                    <td>${elapsed}</td>
                  </tr>
                `;
              })
              .join('')}
          </table>
        </div>

        <div class="card">
          <h2>Duty Sessions (Last 7 Days)</h2>
          <p>Total completed sessions: <strong>${recentSessions.length}</strong></p>
        </div>

        <div class="card">
          <h2>Config Snapshot</h2>
          <p><span class="tag">Guild ID</span> ${GUILD_ID || 'not set'}</p>
          <p><span class="tag">Applications Log Channel</span> ${rawConfig.channels.applicationsChannelId || 'n/a'}</p>
          <p><span class="tag">Activity Log Channel</span> ${rawConfig.channels.activityLogChannelId || 'n/a'}</p>
        </div>

      </body>
      </html>
    `;

    res.send(html);
  } catch (err) {
    console.error('Error rendering admin dashboard:', err);
    res.status(500).send('Dashboard error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Admin dashboard listening on port ${PORT}`);
});
