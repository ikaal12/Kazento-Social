const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// =================== CONFIG ===================
const TOKEN        = process.env.BOT_TOKEN;
const CLIENT_ID    = process.env.CLIENT_ID;
const GUILD_ID     = process.env.GUILD_ID;
const CH_AFFILIATE = process.env.CH_AFFILIATE;
const CH_ADMIN     = process.env.CH_ADMIN;
const CH_LB        = process.env.CH_LEADERBOARD;
const OWNER_ID     = process.env.OWNER_ID;

const LB_INTERVAL  = 10 * 60 * 1000; // 10 menit

const REQUIRED_ENV = [
  'BOT_TOKEN', 'CLIENT_ID', 'GUILD_ID',
  'CH_AFFILIATE', 'CH_ADMIN', 'CH_LEADERBOARD',
  'OWNER_ID', 'SUPABASE_URL', 'SUPABASE_KEY'
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`❌ Missing env: ${key}`); process.exit(1); }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// =================== ASSETS ===================
const ASSET = {
  kazento: () => new AttachmentBuilder(path.join(__dirname, 'assets', 'Kazento.png'), { name: 'Kazento.png' }),
};

// =================== HELPERS ===================
function dl(n) {
  return `${Number(n || 0).toLocaleString('id-ID')} DL`;
}

async function getUser(id) {
  const { data, error } = await supabase.from('users').select('*').eq('phone', id).maybeSingle();
  if (error) console.error('getUser error:', error.message);
  return data || null;
}

async function getAffiliate(userId) {
  const { data } = await supabase.from('affiliates').select('*').eq('user_id', userId).maybeSingle();
  return data || null;
}

async function getAffiliateByCode(code) {
  const { data } = await supabase.from('affiliates').select('*').eq('invite_code', code).maybeSingle();
  return data || null;
}

async function getReferrals(userId) {
  const { data } = await supabase
    .from('affiliate_referrals')
    .select('*, users!affiliate_referrals_referee_id_fkey(name, phone, total_wager)')
    .eq('referrer_id', userId)
    .order('joined_at', { ascending: false });
  return data || [];
}

// =================== INVITE CACHE ===================
const inviteCache = new Map();

async function loadInviteCache(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.clear();
    for (const [code, invite] of invites) inviteCache.set(code, invite.uses);
    for (const [code, uses] of inviteCache) {
      await supabase.from('invite_snapshots').upsert(
        { invite_code: code, uses, updated_at: new Date().toISOString() },
        { onConflict: 'invite_code' }
      );
    }
    console.log(`✅ Invite cache loaded: ${inviteCache.size} invites`);
  } catch (err) {
    console.error('loadInviteCache error:', err.message);
  }
}

async function findUsedInvite(guild) {
  try {
    const freshInvites = await guild.invites.fetch();

    for (const [code, invite] of freshInvites) {
      const cached = inviteCache.get(code) ?? null;
      if (cached === null) {
        const { data: snap } = await supabase.from('invite_snapshots').select('uses').eq('invite_code', code).maybeSingle();
        const snapUses = snap?.uses ?? 0;
        if (invite.uses > snapUses) {
          inviteCache.set(code, invite.uses);
          await supabase.from('invite_snapshots').upsert({ invite_code: code, uses: invite.uses, updated_at: new Date().toISOString() }, { onConflict: 'invite_code' });
          return code;
        }
      } else if (invite.uses > cached) {
        inviteCache.set(code, invite.uses);
        await supabase.from('invite_snapshots').upsert({ invite_code: code, uses: invite.uses, updated_at: new Date().toISOString() }, { onConflict: 'invite_code' });
        return code;
      }
    }

    // Fallback ke DB snapshot
    const { data: snapshots } = await supabase.from('invite_snapshots').select('*');
    if (snapshots) {
      for (const snap of snapshots) {
        const fresh = freshInvites.get(snap.invite_code);
        if (fresh && fresh.uses > snap.uses) {
          inviteCache.set(snap.invite_code, fresh.uses);
          await supabase.from('invite_snapshots').upsert({ invite_code: snap.invite_code, uses: fresh.uses, updated_at: new Date().toISOString() }, { onConflict: 'invite_code' });
          return snap.invite_code;
        }
      }
    }
    return null;
  } catch (err) {
    console.error('findUsedInvite error:', err.message);
    return null;
  }
}

// =================== AFFILIATE EMBEDS ===================
function affiliatePanelEmbed() {
  return new EmbedBuilder()
    .setTitle('💸 KAZENTO AFFILIATE')
    .setColor(0x9B59B6)
    .setThumbnail('attachment://Kazento.png')
    .setDescription(
      '## Mau Cuan Gampang?\n\n' +
      'Daftarin diri lu sebagai **Affiliate Kazento** dan dapetin **komisi 0.5%** dari setiap bet yang dilakuin sama orang yang join pake link lu.\n\n' +
      '> Makin banyak yang join & bet, makin tebal kantong lu.'
    )
    .addFields(
      { name: '💰 Komisi',  value: '**0.5%** dari total wager referral', inline: true },
      { name: '📊 Tracking', value: 'Real-time via Supabase',            inline: true },
      { name: '💸 Withdraw', value: 'Claim manual ke admin',             inline: true },
    )
    .setFooter({ text: 'Kazento Affiliate System' })
    .setTimestamp();
}

function affiliatePanelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('aff_create').setLabel('Buat Affiliate Link').setStyle(ButtonStyle.Success).setEmoji('🔗'),
      new ButtonBuilder().setCustomId('aff_stats').setLabel('My Stats').setStyle(ButtonStyle.Primary).setEmoji('📊'),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('aff_referrals').setLabel('My Referrals').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
      new ButtonBuilder().setCustomId('aff_claim').setLabel('Claim Komisi').setStyle(ButtonStyle.Danger).setEmoji('💸'),
    ),
  ];
}

async function sendOrUpdateAffPanel(channel) {
  const opts = { embeds: [affiliatePanelEmbed()], files: [ASSET.kazento()], components: affiliatePanelRow() };
  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    const existing = messages.find(m => m.author.id === channel.client.user.id && m.embeds?.[0]?.title?.includes('KAZENTO AFFILIATE'));
    if (existing) { await existing.edit(opts); console.log('✅ Panel affiliate diupdate'); return; }
  } catch { }
  await channel.send(opts);
  console.log('✅ Panel affiliate dikirim');
}

function statsEmbed(user, affiliate, referrals) {
  const unclaimed    = Number(affiliate.total_commission) - Number(affiliate.claimed_commission);
  const totalWagered = referrals.reduce((a, r) => a + Number(r.total_wagered), 0);
  return new EmbedBuilder()
    .setTitle('📊 Affiliate Stats')
    .setColor(0x9B59B6)
    .setThumbnail('attachment://Kazento.png')
    .addFields(
      { name: '👤 User',             value: `<@${user.phone}>`,            inline: true },
      { name: '🔗 Kode',             value: `\`${affiliate.invite_code}\``, inline: true },
      { name: '\u200B',              value: '\u200B',                       inline: true },
      { name: '👥 Total Referral',   value: `${referrals.length} orang`,    inline: true },
      { name: '🎰 Total Wager Aff.', value: `${totalWagered.toFixed(2)} DL`, inline: true },
      { name: '\u200B',              value: '\u200B',                       inline: true },
      { name: '💰 Total Komisi',     value: `${Number(affiliate.total_commission).toFixed(2)} DL`,  inline: true },
      { name: '✅ Sudah Claimed',     value: `${Number(affiliate.claimed_commission).toFixed(2)} DL`, inline: true },
      { name: '💸 Bisa Di-claim',    value: `**${unclaimed.toFixed(2)} DL**`, inline: true },
    )
    .setFooter({ text: 'Update real-time via Supabase Realtime' })
    .setTimestamp();
}

function referralsEmbed(referrals) {
  const embed = new EmbedBuilder().setTitle('👥 My Referrals').setColor(0x9B59B6).setThumbnail('attachment://Kazento.png');
  if (!referrals.length) { embed.setDescription('_Belum ada yang join pake link lu. Gih share linknya._'); return embed; }
  const list = referrals.slice(0, 10).map((r, i) => {
    const name  = r.users?.name || r.referee_id;
    const wager = Number(r.total_wagered).toFixed(2);
    return `\`${String(i + 1).padStart(2, '0')}\` **${name}** — ${wager} DL wager`;
  }).join('\n');
  embed.setDescription(list);
  if (referrals.length > 10) embed.setFooter({ text: `+${referrals.length - 10} lainnya tidak ditampilkan` });
  return embed;
}

// =================== LEADERBOARD ===================
const MEDALS = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
const ROLE_COLORS = {
  'Sultan Arab': 0xFFD700, 'Rich': 0xE74C3C, 'Ruby': 0xC0392B,
  'Emerald': 0x2ECC71, 'Diamond': 0x3498DB, 'Gold': 0xF39C12,
  'Silver': 0x95A5A6, 'Bronze': 0xCD7F32, 'Unrank': 0x9B59B6,
};

let lbMessageId = null;

async function fetchLeaderboard() {
  const { data, error } = await supabase
    .from('users')
    .select('phone, name, total_wager, role')
    .order('total_wager', { ascending: false })
    .limit(10);
  if (error) { console.error('fetchLeaderboard error:', error.message); return []; }
  return data || [];
}

function buildLbEmbed(data) {
  const topRole = data[0]?.role ?? 'Unrank';
  const color   = ROLE_COLORS[topRole] ?? 0x9B59B6;
  const updatedAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';

  const embed = new EmbedBuilder()
    .setTitle('🏆 KAZENTO LEADERBOARD')
    .setColor(color)
    .setThumbnail('attachment://Kazento.png')
    .setFooter({ text: `Update tiap 10 menit • Last update: ${updatedAt}` })
    .setTimestamp();

  if (!data.length) { embed.setDescription('_Belum ada data. Main dulu sana._'); return embed; }

  const rows = data.map((u, i) => {
    const medal = MEDALS[i] ?? `**${i + 1}.**`;
    const name  = u.name || `User ${u.phone.slice(-4)}`;
    const wager = Number(u.total_wager || 0).toLocaleString('id-ID');
    const role  = u.role || 'Unrank';
    return `${medal} **${name}**\n┗ ${wager} DL wager • \`${role}\``;
  }).join('\n\n');

  const totalWager = data.reduce((a, u) => a + Number(u.total_wager || 0), 0);
  embed.setDescription(rows).addFields(
    { name: '👥 Pemain Aktif', value: `${data.length} orang`, inline: true },
    { name: '🎰 Total Wager',  value: `${totalWager.toLocaleString('id-ID')} DL`, inline: true },
  );
  return embed;
}

async function updateLbPanel(channel) {
  const data  = await fetchLeaderboard();
  const embed = buildLbEmbed(data);
  const files = [ASSET.kazento()];

  if (lbMessageId) {
    try {
      const msg = await channel.messages.fetch(lbMessageId);
      await msg.edit({ embeds: [embed], files });
      console.log('✅ Leaderboard diupdate');
      return;
    } catch { lbMessageId = null; }
  }

  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    const existing = messages.find(m => m.author.id === channel.client.user.id && m.embeds?.[0]?.title?.includes('KAZENTO LEADERBOARD'));
    if (existing) {
      lbMessageId = existing.id;
      await existing.edit({ embeds: [embed], files });
      console.log('✅ Leaderboard diupdate (recovered)');
      return;
    }
  } catch { }

  const sent = await channel.send({ embeds: [embed], files });
  lbMessageId = sent.id;
  console.log('✅ Leaderboard panel dikirim');
}

// =================== SUPABASE REALTIME ===================
function startRealtimeListener() {
  supabase
    .channel('game_history_affiliate')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_history' }, async (payload) => {
      try {
        const { phone: bettorId, bet } = payload.new;
        if (!bettorId || !bet) return;

        const { data: bettor } = await supabase.from('users').select('referred_by').eq('phone', bettorId).maybeSingle();
        if (!bettor?.referred_by) return;

        const referrerId  = bettor.referred_by;
        const commission  = Number(bet) * 0.005;

        // Update total_wagered referral
        const { data: refRow } = await supabase.from('affiliate_referrals').select('total_wagered').eq('referrer_id', referrerId).eq('referee_id', bettorId).maybeSingle();
        if (refRow) {
          await supabase.from('affiliate_referrals').update({ total_wagered: Number(refRow.total_wagered) + Number(bet) }).eq('referrer_id', referrerId).eq('referee_id', bettorId);
        }

        // Update komisi referrer
        const { data: aff } = await supabase.from('affiliates').select('total_commission').eq('user_id', referrerId).maybeSingle();
        if (aff) {
          await supabase.from('affiliates').update({ total_commission: Number(aff.total_commission) + commission }).eq('user_id', referrerId);
        }
      } catch (err) {
        console.error('Realtime commission error:', err.message);
      }
    })
    .subscribe((status) => console.log('📡 Supabase Realtime:', status));
}

// =================== SLASH COMMANDS ===================
const commands = [
  new SlashCommandBuilder().setName('affpanel').setDescription('[ADMIN] Kirim/update panel affiliate'),
  new SlashCommandBuilder().setName('lbpanel').setDescription('[ADMIN] Kirim/update panel leaderboard'),
];

// =================== CLIENT ===================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
  ]
});

client.once('ready', async () => {
  console.log('✅ Bot nyala: ' + client.user.tag);

  // Register commands
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
  console.log('✅ Commands registered');

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) await loadInviteCache(guild);

  // Kirim panel affiliate
  try {
    const affCh = await client.channels.fetch(CH_AFFILIATE);
    if (affCh) await sendOrUpdateAffPanel(affCh);
  } catch (err) { console.error('Gagal kirim panel affiliate:', err.message); }

  // Kirim panel leaderboard + start interval
  let lbChannel;
  try {
    lbChannel = await client.channels.fetch(CH_LB);
    if (lbChannel) await updateLbPanel(lbChannel);
  } catch (err) { console.error('Gagal kirim panel leaderboard:', err.message); }

  setInterval(async () => {
    try {
      if (lbChannel) await updateLbPanel(lbChannel);
    } catch (err) { console.error('LB interval error:', err.message); }
  }, LB_INTERVAL);

  // Start Realtime
  startRealtimeListener();
});

// =================== INVITE EVENTS ===================
client.on('inviteCreate', async (invite) => {
  inviteCache.set(invite.code, invite.uses ?? 0);
  await supabase.from('invite_snapshots').upsert({ invite_code: invite.code, uses: 0, updated_at: new Date().toISOString() }, { onConflict: 'invite_code' });
});

client.on('inviteDelete', async (invite) => {
  inviteCache.delete(invite.code);
  await supabase.from('invite_snapshots').delete().eq('invite_code', invite.code);
});

client.on('guildMemberAdd', async (member) => {
  try {
    if (member.guild.id !== GUILD_ID) return;

    const usedCode = await findUsedInvite(member.guild);
    if (!usedCode) { console.log(`⚠️ Tidak bisa track invite: ${member.user.tag}`); return; }

    const affiliate = await getAffiliateByCode(usedCode);
    if (!affiliate) return;

    const referrerId = affiliate.user_id;
    const refereeId  = member.user.id;
    if (referrerId === refereeId) return;

    const { data: existing } = await supabase.from('affiliate_referrals').select('referee_id').eq('referee_id', refereeId).maybeSingle();
    if (existing) return;

    await supabase.from('affiliate_referrals').insert({ referrer_id: referrerId, referee_id: refereeId, total_wagered: 0, joined_at: new Date().toISOString() });

    // Set referred_by kalau user udah ada di DB
    const { data: refUser } = await supabase.from('users').select('phone').eq('phone', refereeId).maybeSingle();
    if (refUser) await supabase.from('users').update({ referred_by: referrerId }).eq('phone', refereeId);

    console.log(`✅ Referral tracked: ${member.user.tag} → ${referrerId}`);

    // DM notif ke referrer
    try {
      const referrerUser = await client.users.fetch(referrerId);
      await referrerUser.send({
        embeds: [new EmbedBuilder().setTitle('🎉 Referral Baru!').setColor(0x2ECC71)
          .setDescription(`**${member.user.username}** baru join pake link affiliate lu!\nSetiap bet mereka → lu dapet **0.5% komisi** otomatis.`)
          .setTimestamp()]
      });
    } catch { }
  } catch (err) {
    console.error('guildMemberAdd error:', err.message);
  }
});

// =================== INTERACTIONS ===================
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.guild) {
      if (interaction.isRepliable()) await interaction.reply({ content: '❌ Hanya bisa di server.', flags: 64 });
      return;
    }

    const uid = interaction.user.id;

    // =================== SLASH COMMANDS ===================
    if (interaction.isChatInputCommand()) {
      const cmd     = interaction.commandName;
      const dbUser  = await getUser(uid);
      const isAdmin = dbUser?.is_admin || dbUser?.is_owner || uid === OWNER_ID;
      if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });

      if (cmd === 'affpanel') {
        try {
          const ch = await client.channels.fetch(CH_AFFILIATE);
          await sendOrUpdateAffPanel(ch);
          return interaction.reply({ content: '✅ Panel affiliate dikirim/diupdate.', flags: 64 });
        } catch (err) {
          return interaction.reply({ content: `❌ Gagal: ${err.message}`, flags: 64 });
        }
      }

      if (cmd === 'lbpanel') {
        try {
          const ch = await client.channels.fetch(CH_LB);
          await updateLbPanel(ch);
          return interaction.reply({ content: '✅ Panel leaderboard dikirim/diupdate.', flags: 64 });
        } catch (err) {
          return interaction.reply({ content: `❌ Gagal: ${err.message}`, flags: 64 });
        }
      }
    }

    // =================== BUTTONS ===================
    if (interaction.isButton()) {
      const cid = interaction.customId;

      // ===== BUAT AFFILIATE LINK =====
      if (cid === 'aff_create') {
        const existing = await getAffiliate(uid);
        if (existing) {
          return interaction.reply({
            embeds: [new EmbedBuilder().setTitle('🔗 Affiliate Link Lu').setColor(0x9B59B6).setThumbnail('attachment://Kazento.png')
              .setDescription(`Lu udah punya affiliate link:\n\n**https://discord.gg/${existing.invite_code}**\n\nShare link ini ke orang lain dan dapetin komisi **0.5%** dari setiap bet mereka.`)
              .setFooter({ text: 'Kode: ' + existing.invite_code })],
            files: [ASSET.kazento()], flags: 64
          });
        }

        try {
          const affCh  = await client.channels.fetch(CH_AFFILIATE);
          const guild  = interaction.guild;
          const invite = await guild.invites.create(affCh, { maxAge: 0, maxUses: 0, unique: true, reason: `Affiliate link untuk ${interaction.user.tag}` });

          await supabase.from('affiliates').insert({ user_id: uid, invite_code: invite.code, total_commission: 0, claimed_commission: 0, created_at: new Date().toISOString() });
          inviteCache.set(invite.code, 0);
          await supabase.from('invite_snapshots').upsert({ invite_code: invite.code, uses: 0, updated_at: new Date().toISOString() }, { onConflict: 'invite_code' });

          return interaction.reply({
            embeds: [new EmbedBuilder().setTitle('✅ Affiliate Link Dibuat!').setColor(0x2ECC71).setThumbnail('attachment://Kazento.png')
              .setDescription(`Link affiliate lu udah jadi:\n\n**https://discord.gg/${invite.code}**\n\nShare ini ke calon member. Setiap mereka bet → lu dapet **0.5% komisi** otomatis.`)
              .addFields({ name: '💰 Komisi', value: '0.5% per bet', inline: true }, { name: '💸 Cara Claim', value: 'Tombol "Claim Komisi"', inline: true })
              .setFooter({ text: 'Kode: ' + invite.code })],
            files: [ASSET.kazento()], flags: 64
          });
        } catch (err) {
          console.error('aff_create error:', err.message);
          return interaction.reply({ content: `❌ Gagal buat invite: ${err.message}`, flags: 64 });
        }
      }

      // ===== MY STATS =====
      if (cid === 'aff_stats') {
        const affiliate = await getAffiliate(uid);
        if (!affiliate) return interaction.reply({ content: '❌ Lu belum daftar affiliate. Klik **Buat Affiliate Link** dulu.', flags: 64 });
        const dbUser    = await getUser(uid);
        const referrals = await getReferrals(uid);
        return interaction.reply({ embeds: [statsEmbed(dbUser, affiliate, referrals)], files: [ASSET.kazento()], flags: 64 });
      }

      // ===== MY REFERRALS =====
      if (cid === 'aff_referrals') {
        const affiliate = await getAffiliate(uid);
        if (!affiliate) return interaction.reply({ content: '❌ Lu belum daftar affiliate. Klik **Buat Affiliate Link** dulu.', flags: 64 });
        const referrals = await getReferrals(uid);
        return interaction.reply({ embeds: [referralsEmbed(referrals)], files: [ASSET.kazento()], flags: 64 });
      }

      // ===== CLAIM KOMISI =====
      if (cid === 'aff_claim') {
        const affiliate = await getAffiliate(uid);
        if (!affiliate) return interaction.reply({ content: '❌ Lu belum daftar affiliate. Klik **Buat Affiliate Link** dulu.', flags: 64 });

        const unclaimed = Number(affiliate.total_commission) - Number(affiliate.claimed_commission);
        if (unclaimed < 1) return interaction.reply({ content: `❌ Komisi yang bisa di-claim cuma **${unclaimed.toFixed(2)} DL**. Minimal claim **1 DL**.`, flags: 64 });

        const { data: pendingClaim } = await supabase.from('affiliate_claims').select('id').eq('user_id', uid).eq('status', 'pending').maybeSingle();
        if (pendingClaim) return interaction.reply({ content: '❌ Lu masih punya claim yang lagi diproses admin. Tunggu dulu.', flags: 64 });

        await supabase.from('affiliate_claims').insert({ user_id: uid, amount: unclaimed, status: 'pending', created_at: new Date().toISOString() });

        try {
          const adminCh = await client.channels.fetch(CH_ADMIN);
          await adminCh.send({
            embeds: [new EmbedBuilder().setTitle('💸 Claim Komisi Affiliate').setColor(0xF39C12)
              .addFields(
                { name: '👤 User',   value: `<@${uid}>`, inline: true },
                { name: '💰 Amount', value: `${unclaimed.toFixed(2)} DL`, inline: true },
                { name: '📅 Waktu',  value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
              ).setTimestamp()],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`aff_approve_${uid}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`aff_reject_${uid}`).setLabel('❌ Reject').setStyle(ButtonStyle.Danger),
            )]
          });
        } catch (err) { console.error('Gagal notif admin:', err.message); }

        return interaction.reply({
          embeds: [new EmbedBuilder().setTitle('✅ Claim Dikirim!').setColor(0x2ECC71).setThumbnail('attachment://Kazento.png')
            .setDescription(`Request claim **${unclaimed.toFixed(2)} DL** udah dikirim ke admin.\nSabar nunggu diproses ya.`).setTimestamp()],
          files: [ASSET.kazento()], flags: 64
        });
      }

      // ===== ADMIN: APPROVE =====
      if (cid.startsWith('aff_approve_')) {
        const dbUser  = await getUser(uid);
        const isAdmin = dbUser?.is_admin || dbUser?.is_owner || uid === OWNER_ID;
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });

        const targetId = cid.replace('aff_approve_', '');
        const { data: claim } = await supabase.from('affiliate_claims').select('*').eq('user_id', targetId).eq('status', 'pending').maybeSingle();
        if (!claim) return interaction.reply({ content: '❌ Claim tidak ditemukan atau sudah diproses.', flags: 64 });

        const aff = await getAffiliate(targetId);
        if (aff) {
          await supabase.from('affiliates').update({ claimed_commission: Number(aff.claimed_commission) + Number(claim.amount) }).eq('user_id', targetId);
        }
        await supabase.from('affiliate_claims').update({ status: 'approved', processed_at: new Date().toISOString(), processed_by: uid }).eq('user_id', targetId).eq('status', 'pending');

        try {
          const targetUser = await client.users.fetch(targetId);
          await targetUser.send({ embeds: [new EmbedBuilder().setTitle('✅ Claim Diapprove!').setColor(0x2ECC71).setDescription(`Komisi **${Number(claim.amount).toFixed(2)} DL** lu udah diapprove admin. Cek balance lu.`).setTimestamp()] });
        } catch { }

        return interaction.update({
          components: [],
          embeds: [new EmbedBuilder().setTitle('✅ Claim Approved').setColor(0x2ECC71).setDescription(`Claim <@${targetId}> sebesar **${Number(claim.amount).toFixed(2)} DL** diapprove oleh <@${uid}>.`).setTimestamp()]
        });
      }

      // ===== ADMIN: REJECT =====
      if (cid.startsWith('aff_reject_')) {
        const dbUser  = await getUser(uid);
        const isAdmin = dbUser?.is_admin || dbUser?.is_owner || uid === OWNER_ID;
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });

        const targetId = cid.replace('aff_reject_', '');
        await supabase.from('affiliate_claims').update({ status: 'rejected', processed_at: new Date().toISOString(), processed_by: uid }).eq('user_id', targetId).eq('status', 'pending');

        try {
          const targetUser = await client.users.fetch(targetId);
          await targetUser.send({ embeds: [new EmbedBuilder().setTitle('❌ Claim Direject').setColor(0xE74C3C).setDescription('Claim komisi lu direject admin. Hubungi admin kalau ada pertanyaan.').setTimestamp()] });
        } catch { }

        return interaction.update({
          components: [],
          embeds: [new EmbedBuilder().setTitle('❌ Claim Rejected').setColor(0xE74C3C).setDescription(`Claim <@${targetId}> direject oleh <@${uid}>.`).setTimestamp()]
        });
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Terjadi kesalahan, coba lagi.', flags: 64 });
    } catch { }
  }
});

client.login(TOKEN);
