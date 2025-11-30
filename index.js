// index.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const jwt = require('jsonwebtoken');
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
  getApplications,
  getApplicationById,
  addTicket,
  closeTicket,
  getTickets,
  getTicketById,
  setTicketDone,
  clockIn,
  clockOut,
  getOpenSession,
  getAllOpenSessions,
  getSessionsForUserInRange,
  getSessionsInRange,
  addReport,
  getReports,
  getReportById,
  setReportDone,
  addRequest,
  getRequests,
  getRequestById,
  setRequestDone,
  setStickyPanel,
  getStickyPanelForChannel
} = require('./storage');

const config = require('./config.json');

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

let dutyBoardMessageId = null;

// ----------------- Utility helpers -----------------
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

function hasAnyRole(member, roleIds) {
  return roleIds.some(id => member.roles.cache.has(id));
}

// ----------------- Duty board -----------------
async function updateDutyBoard(guild) {
  const channelId = config.channels.clockStatusChannelId;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[DutyBoard] Channel not found for ID:', channelId);
    return;
  }

  const sessions = getAllOpenSessions();
  let content;
  if (!sessions || sessions.length === 0) {
    content = '📋 **On Duty Board**\nNo one is currently clocked in.';
  } else {
    const lines = sessions.map(s => {
      const assignments = Array.isArray(s.assignments) ? s.assignments : [];
      const assignmentsText = assignments.length ? assignments.join(', ') : 'Unspecified';
      const startedUnix = Math.floor(s.clockIn / 1000);
      const elapsed = msToHuman(Date.now() - s.clockIn);
      return `• <@${s.userId}> – **${assignmentsText}** – on duty since <t:${startedUnix}:R> (**${elapsed}**)`;
    });
    content = '📋 **On Duty Board**\n' + lines.join('\n');
  }

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

// ----------------- Sticky panels -----------------
async function postApplicationsPanel(channel) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('apply_patrol').setLabel('Apply - Patrol').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('apply_cid').setLabel('Apply - CID').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('apply_srt').setLabel('Apply - SRT').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('apply_traffic').setLabel('Apply - Traffic Unit').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('apply_reaper').setLabel('Apply - REAPER').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('apply_ia').setLabel('Apply - IA').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('apply_dispatch').setLabel('Apply - Dispatch').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('apply_training').setLabel('Apply - Training Staff').setStyle(ButtonStyle.Secondary)
  );

  const embed = new EmbedBuilder()
    .setTitle('SALEA Applications')
    .setDescription('Click the appropriate button below to submit an application.\n\nPlease be honest and detailed in your responses.')
    .setColor(0x00aeff);

  const msg = await channel.send({ embeds: [embed], components: [row1, row2] });

  setStickyPanel(channel.id, 'applications');
  return msg;
}

async function repostStickyPanel(message) {
  const sticky = getStickyPanelForChannel(message.channelId);
  if (!sticky) return;
  const channel = message.channel;
  if (!channel || !channel.isTextBased()) return;

  if (sticky.panelType === 'applications') {
    await postApplicationsPanel(channel);
  }
}

// ----------------- Application decision helpers -----------------
async function processAppApprove(app, approverId) {
  if (!app) throw new Error('Application not found');
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) throw new Error('Guild not found');

  const member = await guild.members.fetch(app.userId).catch(() => null);
  const user = await client.users.fetch(app.userId).catch(() => null);

  const updated = updateApplicationStatus(app.id, 'approved', approverId, app.division);

  if (member) {
    if (config.roles.applicantRoleId && member.roles.cache.has(config.roles.applicantRoleId)) {
      await member.roles.remove(config.roles.applicantRoleId).catch(() => {});
    }
    if (config.roles.cadetRoleId) {
      await member.roles.add(config.roles.cadetRoleId).catch(() => {});
    }
  }

  if (user) {
    try {
      await user.send(
        `✅ Your application to SALEA (**${app.division}**) has been **approved**. ` +
        `Welcome aboard as a Cadet!`
      );
    } catch {}
  }

  const embed = new EmbedBuilder()
    .setTitle('Application Approved')
    .setColor(0x00ff00)
    .addFields(
      { name: 'Applicant', value: `<@${app.userId}> (${app.userId})`, inline: false },
      { name: 'Division', value: app.division || 'N/A', inline: true },
      { name: 'Approved By', value: `<@${approverId}>`, inline: true }
    )
    .setFooter({ text: `Application ID: ${app.id}` })
    .setTimestamp(new Date());

  try {
    const channel = await client.channels.fetch(config.channels.applicationsChannelId);
    if (channel && channel.isTextBased()) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Error logging application approval:', err);
  }

  return updated;
}

async function processAppDeny(app, approverId, reason) {
  if (!app) throw new Error('Application not found');
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) throw new Error('Guild not found');

  const user = await client.users.fetch(app.userId).catch(() => null);

  const updated = updateApplicationStatus(app.id, 'denied', approverId, reason);

  if (user) {
    try {
      await user.send(
        `❌ Your application to SALEA (**${app.division}**) has been **denied**.\n` +
        `Reason: ${reason || 'No reason provided.'}`
      );
    } catch {}
  }

  const embed = new EmbedBuilder()
    .setTitle('Application Denied')
    .setColor(0xff0000)
    .addFields(
      { name: 'Applicant', value: `<@${app.userId}> (${app.userId})`, inline: false },
      { name: 'Division', value: app.division || 'N/A', inline: true },
      { name: 'Denied By', value: `<@${approverId}>`, inline: true },
      { name: 'Reason', value: reason || 'No reason provided', inline: false }
    )
    .setFooter({ text: `Application ID: ${app.id}` })
    .setTimestamp(new Date());

  try {
    const channel = await client.channels.fetch(config.channels.applicationsChannelId);
    if (channel && channel.isTextBased()) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Error logging application denial:', err);
  }

  return updated;
}

// ----------------- Slash command definitions -----------------
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
          opt.setName('user').setDescription('Applicant to approve.').setRequired(true)
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
              { name: 'REAPER', value: 'Reaper' },
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
          opt.setName('user').setDescription('Applicant to deny.').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('reason').setDescription('Reason for denial.').setRequired(true)
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
          opt.setName('subject').setDescription('Short description of your issue.').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('close').setDescription('Close this ticket channel (with transcript).')
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
            .setName('assignments')
            .setDescription('Comma-separated assignments (e.g. Patrol, Supervisor).')
            .setRequired(true)
        )
    )
    .addSubcommand(sub => sub.setName('out').setDescription('Clock out of duty.'))
    .addSubcommand(sub => sub.setName('status').setDescription('Check your current clock-in status.')),

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
          opt.setName('user').setDescription('User to check.').setRequired(true)
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
        )
    )
].map(c => c.toJSON());

// ----------------- Slash registration -----------------
client.once(Events.ClientReady, async readyClient => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('🔁 Refreshing application (slash) commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Error registering commands:', err);
  }

  const guild = readyClient.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (guild) {
    await updateDutyBoard(guild);
  }
});

// ----------------- Interaction handler -----------------
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
        return interaction.reply({ content: '❌ You do not have permission to use this.', ephemeral: true });
      }

      const channel = config.applicationPanel.channelId
        ? await interaction.guild.channels.fetch(config.applicationPanel.channelId)
        : interaction.channel;

      await postApplicationsPanel(channel);
      return interaction.reply({ content: '✅ Application panel posted.', ephemeral: true });
    }

    // /app
    if (commandName === 'app') {
      const sub = interaction.options.getSubcommand();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasAnyRole(member, config.roles.highCommandRoleIds || [])) {
        return interaction.reply({ content: '❌ Only High Command may manage applications.', ephemeral: true });
      }

      if (sub === 'approve') {
        const user = interaction.options.getUser('user');
        const division = interaction.options.getString('division');

        const latestApp = getLatestApplicationForUser(user.id);
        if (!latestApp) {
          return interaction.reply({
            content: '⚠️ No application found for that user.',
            ephemeral: true
          });
        }

        // override division in the record
        latestApp.division = division;
        await processAppApprove(latestApp, interaction.user.id);

        return interaction.reply({
          content: `✅ Approved application for ${user} into **${division}**.`,
          ephemeral: true
        });
      }

      if (sub === 'deny') {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');

        const latestApp = getLatestApplicationForUser(user.id);
        if (!latestApp) {
          return interaction.reply({
            content: '⚠️ No application found for that user.',
            ephemeral: true
          });
        }

        await processAppDeny(latestApp, interaction.user.id, reason);

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
          id: `ticket_${ticketChannel.id}`,
          channelId: ticketChannel.id,
          userId: interaction.user.id,
          type,
          subject,
          createdAt: Date.now(),
          closedAt: null,
          done: false
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
        const attachment = new AttachmentBuilder(buffer, {
          name: `ticket-${channel.id}.txt`
        });

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
        const rawAssignments = interaction.options.getString('assignments');
        const assignments = rawAssignments
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);

        const open = getOpenSession(interaction.user.id);
        if (open) {
          return interaction.reply({
            content: '⚠️ You are already clocked in.',
            ephemeral: true
          });
        }

        const session = clockIn(interaction.user.id, assignments);
        if (!session) {
          return interaction.reply({
            content: '⚠️ Could not clock you in (already in session?).',
            ephemeral: true
          });
        }

        if (config.roles.onDutyRoleId) {
          await member.roles.add(config.roles.onDutyRoleId).catch(() => {});
        }

        await interaction.reply({
          content: `✅ You are now clocked in as **${assignments.join(', ')}**.`,
          ephemeral: true
        });

        await updateDutyBoard(interaction.guild);
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
          await member.roles.remove(config.roles.onDutyRoleId).catch(() => {});
        }

        await interaction.reply({
          content: `✅ You are now clocked out. Session duration: **${msToHuman(
            duration
          )}**.`,
          ephemeral: true
        });

        await updateDutyBoard(interaction.guild);
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
        const unitsText = open.assignments && open.assignments.length
          ? `Assignments: **${open.assignments.join(', ')}**\n`
          : '';
        await interaction.reply({
          content:
            `⏱️ You are currently clocked in.\n${unitsText}` +
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
        const totalMs = sessions.reduce((sum, s) => sum + (s.clockOut - s.clockIn), 0);

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
        const totalMs = sessions.reduce((sum, s) => sum + (s.clockOut - s.clockIn), 0);

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
        const assignmentFilter = interaction.options.getString('assignment') || null;
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const hcRoles = config.roles.highCommandRoleIds || [];
        if (!hasAnyRole(member, hcRoles)) {
          return interaction.reply({
            content: '❌ Only High Command may view top activity.',
            ephemeral: true
          });
        }

        const from = getRangeStart(range);
        const sessions = getSessionsInRange(from, assignmentFilter);
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

        const lines = sorted.map(([userId, ms], i) => `${i + 1}. <@${userId}> – **${msToHuman(ms)}**`);
        const header = assignmentFilter
          ? `Top duty time (${range}) for assignment **${assignmentFilter}**:`
          : `Top duty time (${range}):`;

        return interaction.reply({
          content: `📊 ${header}\n` + lines.join('\n'),
          ephemeral: true
        });
      }
    }
  }

  // Button interactions
  if (interaction.isButton()) {
    const id = interaction.customId;

    // application apply buttons
    if (id.startsWith('apply_')) {
      const divisionKey = id.replace('apply_', '');
      let divisionName = 'Unknown';
      if (divisionKey === 'patrol') divisionName = 'Patrol';
      if (divisionKey === 'cid') divisionName = 'CID';
      if (divisionKey === 'srt') divisionName = 'SRT';
      if (divisionKey === 'traffic') divisionName = 'Traffic Unit';
      if (divisionKey === 'reaper') divisionName = 'REAPER';
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

      modal.addComponents(
        new ActionRowBuilder().addComponents(q1),
        new ActionRowBuilder().addComponents(q2),
        new ActionRowBuilder().addComponents(q3),
        new ActionRowBuilder().addComponents(q4)
      );

      return interaction.showModal(modal);
    }

    // application decision buttons (in Discord log channel)
    if (id.startsWith('app_decision_approve_') || id.startsWith('app_decision_deny_')) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const isHC = hasAnyRole(member, config.roles.highCommandRoleIds || []);
      if (!isHC) {
        return interaction.reply({
          content: '❌ Only High Command may decide applications.',
          ephemeral: true
        });
      }

      if (id.startsWith('app_decision_approve_')) {
        const appId = id.replace('app_decision_approve_', '');
        const appRecord = getApplicationById(appId);
        if (!appRecord) {
          return interaction.reply({ content: '⚠️ Application not found.', ephemeral: true });
        }

        await processAppApprove(appRecord, interaction.user.id);
        return interaction.reply({
          content: `✅ Application **${appId}** approved.`,
          ephemeral: true
        });
      }

      if (id.startsWith('app_decision_deny_')) {
        const appId = id.replace('app_decision_deny_', '');
        const appRecord = getApplicationById(appId);
        if (!appRecord) {
          return interaction.reply({ content: '⚠️ Application not found.', ephemeral: true });
        }

        const modal = new ModalBuilder()
          .setCustomId(`app_deny_modal_${appId}`)
          .setTitle('Deny Application');

        const reasonInput = new TextInputBuilder()
          .setCustomId('deny_reason')
          .setLabel('Reason for denial')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

        return interaction.showModal(modal);
      }
    }
  }

  // Modal submit – applications (apply + deny reason)
  if (interaction.isModalSubmit()) {
    // application submission
    if (interaction.customId.startsWith('app_modal_')) {
      const divisionKey = interaction.customId.replace('app_modal_', '');
      let divisionName = 'Unknown';
      if (divisionKey === 'patrol') divisionName = 'Patrol';
      if (divisionKey === 'cid') divisionName = 'CID';
      if (divisionKey === 'srt') divisionName = 'SRT';
      if (divisionKey === 'traffic') divisionName = 'Traffic Unit';
      if (divisionKey === 'reaper') divisionName = 'REAPER';
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
        answers: { name, age, experience: exp, availability },
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
          { name: 'Division', value: divisionName, inline: true },
          { name: 'Name', value: name, inline: false },
          { name: 'Age', value: age, inline: true },
          { name: 'Experience', value: exp || 'N/A', inline: false },
          { name: 'Availability', value: availability || 'N/A', inline: false }
        )
        .setFooter({ text: `Application ID: ${app.id}` })
        .setTimestamp(new Date(app.createdAt));

      const decisionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`app_decision_approve_${app.id}`)
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`app_decision_deny_${app.id}`)
          .setLabel('Deny')
          .setStyle(ButtonStyle.Danger)
      );

      try {
        const channel = await interaction.client.channels.fetch(config.channels.applicationsChannelId);
        if (channel && channel.isTextBased()) {
          const content = config.roles.hrRoleId
            ? `<@&${config.roles.hrRoleId}> New application received.`
            : 'New application received.';
          await channel.send({ content, embeds: [embed], components: [decisionRow] });
        }
      } catch (err) {
        console.error('Error sending application log:', err);
      }

      await interaction.reply({
        content: `✅ Your application to **${divisionName}** has been submitted. A member of HR/High Command will review it.`,
        ephemeral: true
      });
    }

    // application denial modal (from Discord buttons)
    if (interaction.customId.startsWith('app_deny_modal_')) {
      const appId = interaction.customId.replace('app_deny_modal_', '');
      const reason = interaction.fields.getTextInputValue('deny_reason');

      const appRecord = getApplicationById(appId);
      if (!appRecord) {
        return interaction.reply({
          content: '⚠️ Application not found.',
          ephemeral: true
        });
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);
      const isHC = hasAnyRole(member, config.roles.highCommandRoleIds || []);
      if (!isHC) {
        return interaction.reply({
          content: '❌ Only High Command may decide applications.',
          ephemeral: true
        });
      }

      await processAppDeny(appRecord, interaction.user.id, reason);

      return interaction.reply({
        content: `✅ Application **${appId}** denied.`,
        ephemeral: true
      });
    }
  }
});

// ----------------- Sticky handling on message -----------------
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  const sticky = getStickyPanelForChannel(message.channelId);
  if (!sticky) return;
  await repostStickyPanel(message);
});

// ----------------- Admin API / dashboard -----------------
const app = express();
app.use(express.json());
app.use(
  session({
    secret: process.env.ADMIN_SESSION_SECRET || 'salea-session-secret',
    resave: false,
    saveUninitialized: false
  })
);

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'salea-admin-secret';

function discordAdminGuard(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    req.adminUser = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// serve admin UI
app.use('/admin', express.static(path.join(__dirname, 'public')));

// Meta: guild/channels/roles
app.get('/admin/api/meta', discordAdminGuard, async (req, res) => {
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return res.status(500).json({ error: 'Guild not found' });

  await guild.channels.fetch();
  await guild.roles.fetch();

  const channels = guild.channels.cache
    .filter(ch => ch.type === ChannelType.GuildText)
    .map(ch => ({ id: ch.id, name: ch.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const roles = guild.roles.cache
    .filter(r => !r.managed)
    .map(r => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    guild: { id: guild.id, name: guild.name },
    channels,
    roles
  });
});

// Applications list/detail/approve/deny
app.get('/admin/api/apps', discordAdminGuard, (req, res) => {
  res.json(getApplications());
});

app.get('/admin/api/apps/:id', discordAdminGuard, (req, res) => {
  const appRec = getApplicationById(req.params.id);
  if (!appRec) return res.status(404).json({ error: 'Not found' });
  res.json(appRec);
});

app.post('/admin/api/apps/:id/approve', discordAdminGuard, async (req, res) => {
  try {
    const appRec = getApplicationById(req.params.id);
    if (!appRec) return res.status(404).json({ error: 'Not found' });
    const updated = await processAppApprove(appRec, req.adminUser.id || 'admin-panel');
    res.json(updated);
  } catch (e) {
    console.error('Admin approve error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/admin/api/apps/:id/deny', discordAdminGuard, async (req, res) => {
  try {
    const appRec = getApplicationById(req.params.id);
    if (!appRec) return res.status(404).json({ error: 'Not found' });
    const reason = req.body.reason || 'Denied via admin panel';
    const updated = await processAppDeny(appRec, req.adminUser.id || 'admin-panel', reason);
    res.json(updated);
  } catch (e) {
    console.error('Admin deny error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Tickets list/detail/done
app.get('/admin/api/tickets', discordAdminGuard, (req, res) => {
  res.json(getTickets());
});

app.get('/admin/api/tickets/:id', discordAdminGuard, (req, res) => {
  const t = getTicketById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});

app.post('/admin/api/tickets/:id/done', discordAdminGuard, (req, res) => {
  const done = !!req.body.done;
  const t = setTicketDone(req.params.id, done);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});

// Reports list/detail/done
app.get('/admin/api/reports', discordAdminGuard, (req, res) => {
  res.json(getReports());
});

app.get('/admin/api/reports/:id', discordAdminGuard, (req, res) => {
  const r = getReportById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

app.post('/admin/api/reports/:id/done', discordAdminGuard, (req, res) => {
  const done = !!req.body.done;
  const r = setReportDone(req.params.id, done);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// Requests list/detail/done
app.get('/admin/api/requests', discordAdminGuard, (req, res) => {
  res.json(getRequests());
});

app.get('/admin/api/requests/:id', discordAdminGuard, (req, res) => {
  const r = getRequestById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

app.post('/admin/api/requests/:id/done', discordAdminGuard, (req, res) => {
  const done = !!req.body.done;
  const r = setRequestDone(req.params.id, done);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// Start web server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Admin dashboard listening on port ${PORT}`);
});

// Start bot
client.login(process.env.DISCORD_TOKEN);
