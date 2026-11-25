require("dotenv").config();
require("dotenv").config({ path: ".env.local" });

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { Pool } = require("pg");

const QUANTITY_PATTERN = /^[0-9]{1,9}$/;
const POINT_SCALE = 10;
const WORLD_LOCKS_PER_DIAMOND_LOCK = 100;
const DIAMOND_LOCKS_PER_BLUE_GEM_LOCK = 100;
const WORLD_LOCKS_PER_BLUE_GEM_LOCK = WORLD_LOCKS_PER_DIAMOND_LOCK * DIAMOND_LOCKS_PER_BLUE_GEM_LOCK;
const PAGE_SIZE = 10;
const REWARD_TIERS = new Map([
  [50, "10 World Locks"],
  [100, "25 World Locks"],
  [150, "50 World Locks"],
  [200, "1 Diamond Lock"],
  [300, "2 Diamond Locks"],
]);
const DEFAULT_REWARD_TIERS = Object.fromEntries(REWARD_TIERS);
const DEFAULT_DATA = () => ({
  total_sold: 0,
  total_stock: 0,
  inventory_cost_basis_php_cents: 0,
  inventory_writeoffs_php_cents: 0,
  inventory_events: [],
  sales_ledger: {},
  commission_claims: {},
  accounting_started_at: null,
  vouch_count: 0,
  vouch_channel_id: null,
  vouches: {},
  points_tenths: {},
  redemptions: {},
  tickets: {},
  ticket_stats: {},
  midman_tickets: {},
  midman_sequence: 0,
  ticket_sequence: 0,
  reward_tiers: { ...DEFAULT_REWARD_TIERS },
  payment_details: {},
  rates: {
    diamond_lock_php_cents: null,
    world_lock_php_cents: null,
    blue_gem_lock_php_cents: null,
    staff_commission_per_diamond_lock_php_cents: null,
  },
});
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const config = {};
let data = DEFAULT_DATA();
let mutationQueue = Promise.resolve();
const pendingTicketStatEdits = new Map();
const ACTIVE_TICKET_STATUSES = new Set([
  "creating", "open", "claimed", "payment_sent", "payment_received", "completed", "success", "closing",
]);
const MIDMAN_TRANSITIONS = {
  open: ["claimed", "closed"],
  claimed: ["payment_sent", "closed"],
  payment_sent: ["payment_received", "closed"],
  payment_received: ["completed", "closed"],
  completed: ["success", "closed"],
  success: ["closed"],
  closed: [],
};
const TRANSCRIPT_MAX_MESSAGES = 10000;
const TRANSCRIPT_MAX_BYTES = 7 * 1024 * 1024;

const commands = [
  new SlashCommandBuilder().setName("help").setDescription("Show available bot commands."),
  new SlashCommandBuilder().setName("setup_vouch").setDescription("Post the vouch submission panel in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("setup_ticket").setDescription("Post the purchase ticket panel in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("setup_midman").setDescription("Post the midman service panel in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("ticket").setDescription("View ticket claims and handled quantity.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option => option.setName("target").setDescription("The member whose ticket stats to view.")),
  new SlashCommandBuilder().setName("ticketstat").setDescription("Edit ticket stats for a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option => option.setName("member").setDescription("The member whose ticket stats to edit.").setRequired(true)),
  new SlashCommandBuilder().setName("points").setDescription("View your reward point balance."),
  new SlashCommandBuilder().setName("managepoints").setDescription("Add or remove a member's reward points.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName("action").setDescription("Add or remove points.")
      .setRequired(true)
      .addChoices({ name: "Add", value: "add" }, { name: "Remove", value: "remove" }))
    .addUserOption(option => option.setName("target").setDescription("The member whose points to change.").setRequired(true))
    .addStringOption(option => option.setName("amount").setDescription("The number of points to award.").setRequired(true)),
  new SlashCommandBuilder().setName("commission").setDescription("Claim your accrued staff commission.")
    .addStringOption(option => option.setName("action").setDescription("Claim your accrued commission.")
      .setRequired(true)
      .addChoices({ name: "Claim", value: "claim" })),
  new SlashCommandBuilder().setName("changerewards").setDescription("Change the available reward tiers.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("changerate").setDescription("Set payment rates and staff commission.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("setstatus").setDescription("Set the shop status voice channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName("option").setDescription("Set the shop status.")
      .setRequired(true)
      .addChoices({ name: "Open", value: "open" }, { name: "Close", value: "close" })),
  new SlashCommandBuilder().setName("payment").setDescription("Send payment details for a payment method.")
    .addStringOption(option => option.setName("payment_method").setDescription("Choose a payment method.")
      .setRequired(true)
      .addChoices(
        { name: "Gcash", value: "gcash" },
        { name: "Binance", value: "binance" },
        { name: "Paypal", value: "paypal" },
        { name: "Wise", value: "wise" },
      )),
  new SlashCommandBuilder().setName("setpayment").setDescription("Set the details for a payment method.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName("payment_method").setDescription("Choose a payment method.")
      .setRequired(true)
      .addChoices(
        { name: "Gcash", value: "gcash" },
        { name: "Binance", value: "binance" },
        { name: "Paypal", value: "paypal" },
        { name: "Wise", value: "wise" },
      )),
  new SlashCommandBuilder().setName("received").setDescription("Notify the buyer and seller that payment was received."),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Show the points leaderboard."),
  new SlashCommandBuilder().setName("rewards").setDescription("Show the available rewards."),
  new SlashCommandBuilder().setName("redeem").setDescription("Choose and request an affordable reward."),
  new SlashCommandBuilder().setName("sales").setDescription("Record a manual sale using a form.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("stock").setDescription("View or update available stock.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName("action").setDescription("Choose a stock operation.")
      .addChoices(
        { name: "Restock (add purchased inventory)", value: "restock" },
        { name: "Set / reconcile inventory", value: "set" },
        { name: "Remove / write off inventory", value: "remove" },
      )),
  new SlashCommandBuilder().setName("profit").setDescription("View inventory cost, revenue, commission, and profit.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("sold").setDescription("Adjust the total quantity sold.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName("action").setDescription("Choose whether to add or remove from total sold.")
      .addChoices({ name: "Add", value: "add" }, { name: "Remove", value: "remove" }).setRequired(true))
    .addStringOption(option => option.setName("amount").setDescription("The quantity to add or remove.").setRequired(true)),
].map(command => command.toJSON());

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`The ${name} environment variable must be set.`);
  return value;
}
function salesEntryModal() {
  return new ModalBuilder()
    .setCustomId("sales:submit")
    .setTitle("Record a sale")
    .setLabelComponents(
      modalLabel("Buyer name", textInput("buyer_name", "Buyer name", TextInputStyle.Short, true, "Name or Discord username").setMaxLength(100)),
      modalLabel("Quantity", textInput("quantity", "Quantity", TextInputStyle.Short, true, "Enter a whole number").setMaxLength(9)),
      modalLabel("Lock type", quantityTypeSelect("quantity_type")),
    );
}

function optionalId(name) {
  const value = process.env[name];
  if (value === undefined || value === "") return null;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must contain a numeric Discord ID.`);
  return value;
}

function loadConfig() {
  for (const name of ["STAFF_CHANNEL_ID", "PUBLIC_VOUCH_CHANNEL_ID", "REVIEWER_ROLE_ID", "VOUCH_ROLE_ID"]) {
    config[name] = requiredEnv(name);
    if (!/^\d+$/.test(config[name])) throw new Error(`${name} must contain a numeric Discord ID.`);
  }
  for (const name of [
    "STAFF_ROLE_ID", "COUNTER_VOICE_CHANNEL_ID", "TOTAL_VOUCH_VOICE_CHANNEL_ID",
    "TOTAL_STOCK_VOICE_CHANNEL_ID", "RATE_VOICE_CHANNEL_ID", "STATUS_VOICE_CHANNEL_ID",
  ]) config[name] = optionalId(name);
  requiredEnv("DISCORD_TOKEN");
  requiredEnv("DATABASE_URL");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function saveData(next) {
  await pool.query(
    "INSERT INTO vouch_bot_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
    [JSON.stringify(next)],
  );
}

async function mutate(fn) {
  const previous = mutationQueue;
  let release;
  mutationQueue = new Promise(resolve => { release = resolve; });
  await previous;
  let connection;
  let transactionOpen = false;
  try {
    connection = await pool.connect();
    await connection.query("BEGIN");
    transactionOpen = true;
    const rowResult = await connection.query("SELECT data FROM vouch_bot_state WHERE id = 1 FOR UPDATE");
    if (!rowResult.rowCount) throw new Error("The bot state row is missing from PostgreSQL.");
    const next = { ...DEFAULT_DATA(), ...rowResult.rows[0].data };
    const value = await fn(next);
    await connection.query(
      "UPDATE vouch_bot_state SET data = $1::jsonb WHERE id = 1",
      [JSON.stringify(next)],
    );
    await connection.query("COMMIT");
    transactionOpen = false;
    data = next;
    return value;
  } catch (error) {
    if (transactionOpen) {
      try {
        await connection.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Could not roll back a bot state transaction", rollbackError);
      }
    }
    throw error;
  } finally {
    if (connection) connection.release();
    release();
  }
}

async function loadData() {
  await pool.query(`CREATE TABLE IF NOT EXISTS vouch_bot_state (
    id SMALLINT PRIMARY KEY CHECK (id = 1), data JSONB NOT NULL
  )`);
  const result = await pool.query("SELECT data FROM vouch_bot_state WHERE id = 1");
  let inventoryCostBasisWasMissing = false;
  if (result.rowCount) {
    inventoryCostBasisWasMissing = !Object.hasOwn(result.rows[0].data, "inventory_cost_basis_php_cents");
    data = { ...DEFAULT_DATA(), ...result.rows[0].data };
    if (!data.reward_tiers || Array.isArray(data.reward_tiers) || typeof data.reward_tiers !== "object") {
      data.reward_tiers = { ...DEFAULT_REWARD_TIERS };
    }
    if (!data.payment_details || Array.isArray(data.payment_details) || typeof data.payment_details !== "object") {
      data.payment_details = {};
    }
    if (!data.rates || Array.isArray(data.rates) || typeof data.rates !== "object") {
      data.rates = { ...DEFAULT_DATA().rates };
    } else {
      data.rates = { ...DEFAULT_DATA().rates, ...data.rates };
    }
  } else {
    let legacy = DEFAULT_DATA();
    try {
      const contents = await fs.readFile(path.join(__dirname, "sales_data.json"), "utf8");
      const parsed = JSON.parse(contents);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Expected a JSON object.");
      inventoryCostBasisWasMissing = !Object.hasOwn(parsed, "inventory_cost_basis_php_cents");
      legacy = { ...legacy, ...parsed };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Could not read sales_data.json: ${error.message}`);
    }
    data = legacy;
    await saveData(data);
  }
  for (const key of ["vouches", "points_tenths", "redemptions", "tickets", "ticket_stats", "midman_tickets"]) {
    if (!data[key] || Array.isArray(data[key]) || typeof data[key] !== "object") {
      throw new Error(`The ${key} entry in PostgreSQL must be an object.`);
    }
  }
  await mutate(state => {
    if (!state.reward_tiers || Array.isArray(state.reward_tiers) || typeof state.reward_tiers !== "object") {
      state.reward_tiers = { ...DEFAULT_REWARD_TIERS };
    }
    if (!state.payment_details || Array.isArray(state.payment_details) || typeof state.payment_details !== "object") {
      state.payment_details = {};
    }
    if (!state.rates || Array.isArray(state.rates) || typeof state.rates !== "object") {
      state.rates = { ...DEFAULT_DATA().rates };
    } else {
      state.rates = { ...DEFAULT_DATA().rates, ...state.rates };
    }
    if (inventoryCostBasisWasMissing) {
      state.inventory_cost_basis_php_cents = Number(state.total_stock) === 0 ? 0 : null;
    }
    if (state.inventory_cost_basis_php_cents !== null
      && (!Number.isSafeInteger(state.inventory_cost_basis_php_cents) || state.inventory_cost_basis_php_cents < 0)) {
      throw new Error("The inventory cost basis in PostgreSQL must be non-negative PHP cents or null.");
    }
    if (!Number.isSafeInteger(state.inventory_writeoffs_php_cents) || state.inventory_writeoffs_php_cents < 0) {
      throw new Error("The inventory write-off total in PostgreSQL must be non-negative PHP cents.");
    }
    if (!Array.isArray(state.inventory_events)) state.inventory_events = [];
    if (!state.sales_ledger || Array.isArray(state.sales_ledger) || typeof state.sales_ledger !== "object") {
      state.sales_ledger = {};
    }
    if (!state.commission_claims || Array.isArray(state.commission_claims) || typeof state.commission_claims !== "object") {
      state.commission_claims = {};
    }
    for (const key of ["vouches", "points_tenths", "redemptions", "tickets", "ticket_stats", "midman_tickets"]) {
      if (!state[key] || Array.isArray(state[key]) || typeof state[key] !== "object") {
        throw new Error(`The ${key} entry in PostgreSQL must be an object.`);
      }
    }
    for (const vouch of Object.values(state.vouches)) {
      if (vouch.status === "approving") {
        vouch.status = "pending";
        recordAuditEvent(vouch, "approval_recovered", null);
      }
    }
    const reservationCutoff = Date.now() - 15 * 60 * 1000;
    for (const collection of [state.tickets, state.midman_tickets]) {
      for (const ticket of Object.values(collection)) {
        if (ticket.status === "closing") {
          ticket.status = ticket.close_previous_status || "open";
          delete ticket.close_previous_status;
          delete ticket.close_outcome_status;
          recordAuditEvent(ticket, "close_recovered", null);
        } else if (ticket.status === "creating" && Date.parse(ticket.created_at) < reservationCutoff) {
          ticket.status = "failed";
          recordAuditEvent(ticket, "creation_expired", null);
        }
      }
    }
  });
}

async function refreshData() {
  const result = await pool.query("SELECT data FROM vouch_bot_state WHERE id = 1");
  if (!result.rowCount) throw new Error("The bot state row is missing from PostgreSQL.");
  data = { ...DEFAULT_DATA(), ...result.rows[0].data };
}

function recordAuditEvent(ticket, action, actorId, details = {}) {
  if (!Array.isArray(ticket.audit_log)) ticket.audit_log = [];
  ticket.audit_log.push({
    action,
    actor_id: actorId ? String(actorId) : null,
    at: new Date().toISOString(),
    details,
  });
}

function transitionMidman(ticket, nextStatus, action, actorId, details = {}) {
  if (!MIDMAN_TRANSITIONS[ticket.status]?.includes(nextStatus)) return false;
  ticket.status = nextStatus;
  ticket.updated_at = new Date().toISOString();
  recordAuditEvent(ticket, action, actorId, details);
  return true;
}

function findActiveTicketForUser(state, guildId, userId) {
  const id = String(userId);
  for (const ticket of Object.values(state.tickets || {})) {
    if (ticket.guild_id === guildId && String(ticket.owner_id) === id && ACTIVE_TICKET_STATUSES.has(ticket.status)) {
      return { kind: "purchase", ticket };
    }
  }
  for (const ticket of Object.values(state.midman_tickets || {})) {
    if (ticket.guild_id === guildId
      && [ticket.opened_by_id, ticket.buyer_id, ticket.seller_id].some(participantId => String(participantId) === id)
      && ACTIVE_TICKET_STATUSES.has(ticket.status)) {
      return { kind: "midman", ticket };
    }
  }
  return null;
}

function expireTicketReservations(state) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const collection of [state.tickets, state.midman_tickets]) {
    for (const ticket of Object.values(collection || {})) {
      if (ticket.status === "creating" && Date.parse(ticket.created_at) < cutoff) {
        ticket.status = "failed";
        recordAuditEvent(ticket, "creation_expired", null);
      }
    }
  }
}

function reserveNewTicket(state, kind, ticket) {
  expireTicketReservations(state);
  const participants = kind === "midman"
    ? [ticket.opened_by_id, ticket.buyer_id, ticket.seller_id]
    : [ticket.owner_id];
  for (const participantId of participants) {
    const existing = findActiveTicketForUser(state, ticket.guild_id, participantId);
    if (existing) return { created: false, existing: clone(existing) };
  }

  const sequenceKey = kind === "midman" ? "midman_sequence" : "ticket_sequence";
  const collectionKey = kind === "midman" ? "midman_tickets" : "tickets";
  ticket.number = Number(state[sequenceKey] || 0) + 1;
  state[sequenceKey] = ticket.number;
  ticket.status = "creating";
  ticket.created_at = new Date().toISOString();
  ticket.audit_log = [];
  recordAuditEvent(ticket, "creation_started", ticket.opened_by_id || ticket.owner_id);
  state[collectionKey][ticket.id] = ticket;
  return { created: true, ticket: clone(ticket) };
}

function activeTicketNotice(existing) {
  const { kind, ticket } = existing;
  const ticketType = kind === "midman" ? "midman" : "purchase";
  return ticket.channel_id
    ? `You or another participant already has an active ${ticketType} ticket: <#${ticket.channel_id}>. Close it before opening another.`
    : `You or another participant already has a ${ticketType} ticket being created. Please wait a moment and try again.`;
}

function applyStockRemoval(state, amount) {
  const quantity = Number(amount);
  const stock = Number(state.total_stock);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return { ok: false, stock };
  if (!Number.isSafeInteger(stock) || stock < quantity) return { ok: false, stock };
  state.total_stock = stock - quantity;
  return { ok: true, stock: state.total_stock };
}

function updatePointsBalance(state, userId, delta) {
  const current = Number(state.points_tenths[userId] || 0);
  const next = current + delta;
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(next) || next < 0) return null;
  state.points_tenths[userId] = next;
  return next;
}

function formatPoints(tenths) {
  const whole = Math.floor(tenths / POINT_SCALE);
  const remainder = tenths % POINT_SCALE;
  return remainder ? `${whole}.${remainder}` : String(whole);
}

function parsePhpCents(value, allowZero = false) {
  const text = String(value).trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return null;
  const amount = Number(text);
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || (!allowZero && cents <= 0)) return null;
  return cents;
}

function parseNonNegativeInteger(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function formatPhpCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const absoluteCents = Math.abs(cents);
  const whole = Math.floor(absoluteCents / 100);
  const fraction = absoluteCents % 100;
  if (fraction === 0) return String(whole);
  return `${sign}${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

function calculateTicketPriceCents(ticket, rates) {
  const effectiveRates = ticket.sale_rate_snapshot || rates;
  const rate = ticket.quantity_type === "diamond_lock"
    ? effectiveRates.diamond_lock_php_cents
    : ticket.quantity_type === "world_lock"
      ? effectiveRates.world_lock_php_cents
      : ticket.quantity_type === "blue_gem_lock"
        ? effectiveRates.blue_gem_lock_php_cents
        : null;
  if (!Number.isSafeInteger(rate) || !Number.isSafeInteger(Number(ticket.quantity))) return null;
  const total = rate * Number(ticket.quantity);
  return Number.isSafeInteger(total) ? total : null;
}

function getOrCreateTicketQuote(state, ticketId, actorId) {
  const ticket = state.tickets?.[ticketId];
  if (!ticket || !["open", "claimed"].includes(ticket.status)) return { ok: false, reason: "ticket_unavailable" };
  if (Number.isSafeInteger(ticket.quoted_sale_php_cents) && ticket.sale_rate_snapshot) {
    return {
      ok: true,
      amount: ticket.quoted_sale_php_cents,
      rate_snapshot: clone(ticket.sale_rate_snapshot),
    };
  }
  const rateSnapshot = clone(state.rates || {});
  const amount = calculateTicketPriceCents(ticket, rateSnapshot);
  if (!Number.isSafeInteger(amount)) return { ok: false, reason: "rates_not_configured" };
  ticket.sale_rate_snapshot = rateSnapshot;
  ticket.quoted_sale_php_cents = amount;
  recordAuditEvent(ticket, "price_quoted", actorId, { amount_php_cents: amount, rate_snapshot: rateSnapshot });
  return { ok: true, amount, rate_snapshot: rateSnapshot };
}

function quantityWorldLocks(quantities) {
  const world = Number(quantities.world_lock || 0);
  const diamond = Number(quantities.diamond_lock || 0);
  const blueGem = Number(quantities.blue_gem_lock || 0);
  if (![world, diamond, blueGem].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const total = world + diamond * WORLD_LOCKS_PER_DIAMOND_LOCK + blueGem * WORLD_LOCKS_PER_BLUE_GEM_LOCK;
  return Number.isSafeInteger(total) ? total : null;
}

function costForWorldLocks(costBasisCents, stockWorldLocks, soldWorldLocks) {
  if (![costBasisCents, stockWorldLocks, soldWorldLocks].every(Number.isSafeInteger)
    || costBasisCents < 0 || stockWorldLocks <= 0 || soldWorldLocks < 0 || soldWorldLocks > stockWorldLocks) {
    return null;
  }
  const numerator = BigInt(costBasisCents) * BigInt(soldWorldLocks) + BigInt(Math.floor(stockWorldLocks / 2));
  const cost = Number(numerator / BigInt(stockWorldLocks));
  return Number.isSafeInteger(cost) ? cost : null;
}

function recordInventoryEvent(state, event) {
  if (!Array.isArray(state.inventory_events)) state.inventory_events = [];
  state.inventory_events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), ...event });
  if (state.inventory_events.length > 5000) state.inventory_events.splice(0, state.inventory_events.length - 5000);
}

function adjustInventory(state, action, quantities, purchaseCostCents, actorId, reason = "") {
  const addedWorldLocks = quantityWorldLocks(quantities);
  const stock = Number(state.total_stock);
  const costBasis = state.inventory_cost_basis_php_cents;
  if (addedWorldLocks === null || !Number.isSafeInteger(stock) || stock < 0) {
    return { ok: false, reason: "invalid_quantity" };
  }
  if (action === "restock") {
    if (addedWorldLocks <= 0 || !Number.isSafeInteger(purchaseCostCents) || purchaseCostCents < 0) {
      return { ok: false, reason: "invalid_restock" };
    }
    if (stock > 0 && costBasis === null) return { ok: false, reason: "reconcile_cost_basis" };
    const newStock = stock + addedWorldLocks;
    const newCostBasis = Number(costBasis || 0) + purchaseCostCents;
    if (!Number.isSafeInteger(newStock) || !Number.isSafeInteger(newCostBasis)) return { ok: false, reason: "overflow" };
    state.total_stock = newStock;
    state.inventory_cost_basis_php_cents = newCostBasis;
    if (!state.accounting_started_at) state.accounting_started_at = new Date().toISOString();
    recordInventoryEvent(state, {
      action: "restock",
      actor_id: String(actorId),
      quantity_world_locks: addedWorldLocks,
      purchase_cost_php_cents: purchaseCostCents,
      reason,
    });
    return { ok: true, stock: newStock, cost_basis: newCostBasis };
  }
  if (action === "set") {
    if (!Number.isSafeInteger(purchaseCostCents) || purchaseCostCents < 0
      || (addedWorldLocks === 0 && purchaseCostCents !== 0)) {
      return { ok: false, reason: "invalid_inventory_value" };
    }
    state.total_stock = addedWorldLocks;
    state.inventory_cost_basis_php_cents = purchaseCostCents;
    if (!state.accounting_started_at) state.accounting_started_at = new Date().toISOString();
    recordInventoryEvent(state, {
      action: "reconciled",
      actor_id: String(actorId),
      quantity_world_locks: addedWorldLocks,
      purchase_cost_php_cents: purchaseCostCents,
      reason,
    });
    return { ok: true, stock: addedWorldLocks, cost_basis: purchaseCostCents };
  }
  if (action === "remove") {
    if (addedWorldLocks <= 0 || addedWorldLocks > stock) return { ok: false, reason: "insufficient_stock", stock };
    if (costBasis === null) return { ok: false, reason: "reconcile_cost_basis" };
    const writtenOffCost = stock === 0 ? 0 : costForWorldLocks(costBasis, stock, addedWorldLocks);
    if (writtenOffCost === null) return { ok: false, reason: "invalid_cost_basis" };
    const totalWriteoffs = Number(state.inventory_writeoffs_php_cents || 0) + writtenOffCost;
    if (!Number.isSafeInteger(totalWriteoffs)) return { ok: false, reason: "overflow" };
    state.total_stock = stock - addedWorldLocks;
    state.inventory_cost_basis_php_cents = costBasis - writtenOffCost;
    state.inventory_writeoffs_php_cents = totalWriteoffs;
    recordInventoryEvent(state, {
      action: "write_off",
      actor_id: String(actorId),
      quantity_world_locks: addedWorldLocks,
      cost_basis_php_cents: writtenOffCost,
      reason,
    });
    return { ok: true, stock: state.total_stock, cost_basis: state.inventory_cost_basis_php_cents };
  }
  return { ok: false, reason: "invalid_action" };
}

function recordSaleInState(state, sale) {
  if (state.sales_ledger[sale.id]) return { ok: false, reason: "duplicate" };
  const quantity = Number(sale.quantity);
  const quantityType = sale.quantity_type;
  const quantityWorldLocksValue = worldLocks(quantity, quantityType);
  const stock = Number(state.total_stock);
  const costBasis = state.inventory_cost_basis_php_cents;
  const revenue = Number(sale.revenue_php_cents);
  const commission = Number(sale.commission_php_cents || 0);
  if (!Number.isSafeInteger(quantity) || quantity <= 0
    || !Number.isSafeInteger(quantityWorldLocksValue)
    || !Number.isSafeInteger(revenue) || revenue < 0
    || !Number.isSafeInteger(commission) || commission < 0
    || !Number.isSafeInteger(stock) || stock < quantityWorldLocksValue) {
    return { ok: false, reason: "insufficient_stock", stock };
  }
  if (costBasis === null) return { ok: false, reason: "reconcile_cost_basis" };
  const cogs = costForWorldLocks(costBasis, stock, quantityWorldLocksValue);
  const totalSold = Number(state.total_sold) + quantityWorldLocksValue;
  if (cogs === null || !Number.isSafeInteger(totalSold)) return { ok: false, reason: "invalid_accounting" };
  const entry = {
    id: sale.id,
    status: "completed",
    source: sale.source,
    source_id: sale.source_id || null,
    buyer_id: sale.buyer_id || null,
    buyer_name: sale.buyer_name || null,
    payment_method: sale.payment_method || null,
    quantity,
    quantity_type: quantityType,
    quantity_world_locks: quantityWorldLocksValue,
    revenue_php_cents: revenue,
    cogs_php_cents: cogs,
    commission_php_cents: commission,
    commission_rate_php_cents: Number.isSafeInteger(sale.commission_rate_php_cents) ? sale.commission_rate_php_cents : null,
    rate_snapshot: clone(sale.rate_snapshot || {}),
    created_at: sale.created_at || new Date().toISOString(),
    completed_by: sale.completed_by ? String(sale.completed_by) : null,
  };
  state.total_stock = stock - quantityWorldLocksValue;
  state.inventory_cost_basis_php_cents = costBasis - cogs;
  state.total_sold = totalSold;
  state.sales_ledger[sale.id] = entry;
  recordInventoryEvent(state, {
    action: "sale",
    actor_id: sale.completed_by ? String(sale.completed_by) : null,
    quantity_world_locks: quantityWorldLocksValue,
    cogs_php_cents: cogs,
    sale_id: sale.id,
  });
  return {
    ok: true,
    entry,
    stock: state.total_stock,
    cost_basis: state.inventory_cost_basis_php_cents,
    total_sold: totalSold,
  };
}

function calculateProfitSummary(state) {
  const entries = Object.values(state.sales_ledger || {}).filter(entry => entry.status !== "void");
  const commissionExpenses = Object.values(state.commission_claims || {})
    .filter(claim => claim.status === "paid")
    .reduce((total, claim) => total + Number(claim.commission_php_cents || 0), 0);
  const writeoffs = Number(state.inventory_writeoffs_php_cents || 0);
  const totals = entries.reduce((result, entry) => {
    result.revenue += Number(entry.revenue_php_cents || 0);
    result.cogs += Number(entry.cogs_php_cents || 0);
    return result;
  }, { revenue: 0, cogs: 0 });
  totals.commission = commissionExpenses;
  const safe = Object.values(totals).every(Number.isSafeInteger) && Number.isSafeInteger(writeoffs);
  const net = totals.revenue - totals.cogs - totals.commission - writeoffs;
  return {
    ...totals,
    writeoffs,
    net: safe && Number.isSafeInteger(net) ? net : null,
    sale_count: entries.length,
    inventory_cost_basis_php_cents: state.inventory_cost_basis_php_cents,
    accounting_started_at: state.accounting_started_at,
    safe: safe && Number.isSafeInteger(net),
  };
}

function reserveCommissionClaim(state, userId) {
  if (!state.commission_claims || typeof state.commission_claims !== "object") state.commission_claims = {};
  const existing = Object.values(state.commission_claims)
    .find(claim => claim.member_id === String(userId) && claim.status === "logging");
  if (existing) {
    return existing.log_message_id
      ? { ok: true, resume: true, claim: clone(existing) }
      : { ok: false, reason: "pending" };
  }
  const stats = state.ticket_stats?.[userId] || {};
  const commissionCents = Number(stats.commission_php_cents || 0);
  const commissionDiamondLocks = Number(stats.commission_diamond_locks || 0);
  if (!Number.isSafeInteger(commissionCents) || commissionCents < 0
    || !Number.isSafeInteger(commissionDiamondLocks) || commissionDiamondLocks < 0) {
    return { ok: false, reason: "invalid_commission" };
  }
  if (commissionCents === 0 && commissionDiamondLocks === 0) return { ok: false, reason: "none" };
  const id = crypto.randomUUID();
  const claim = {
    id,
    member_id: String(userId),
    commission_php_cents: commissionCents,
    commission_diamond_locks: commissionDiamondLocks,
    status: "logging",
    created_at: new Date().toISOString(),
    log_message_id: null,
    audit_log: [{ action: "claim_reserved", at: new Date().toISOString() }],
  };
  state.commission_claims[id] = claim;
  return { ok: true, resume: false, claim: clone(claim) };
}

function attachCommissionClaimLog(state, claimId, messageId) {
  const claim = state.commission_claims?.[claimId];
  if (!claim || claim.status !== "logging") return false;
  claim.log_message_id = String(messageId);
  claim.audit_log.push({ action: "claim_logged_before_reset", at: new Date().toISOString() });
  return true;
}

function finalizeCommissionClaim(state, claimId) {
  const claim = state.commission_claims?.[claimId];
  if (!claim || claim.status !== "logging" || !claim.log_message_id) return { ok: false, reason: "claim_unavailable" };
  const stats = state.ticket_stats?.[claim.member_id] || {};
  const accruedCents = Number(stats.commission_php_cents || 0);
  const accruedDiamondLocks = Number(stats.commission_diamond_locks || 0);
  if (!Number.isSafeInteger(accruedCents) || accruedCents < claim.commission_php_cents
    || !Number.isSafeInteger(accruedDiamondLocks) || accruedDiamondLocks < claim.commission_diamond_locks) {
    return { ok: false, reason: "commission_changed" };
  }
  stats.commission_php_cents = accruedCents - claim.commission_php_cents;
  stats.commission_diamond_locks = accruedDiamondLocks - claim.commission_diamond_locks;
  state.ticket_stats[claim.member_id] = stats;
  claim.status = "paid";
  claim.paid_at = new Date().toISOString();
  claim.audit_log.push({ action: "claim_paid_and_stats_reset", at: claim.paid_at });
  return { ok: true, claim: clone(claim), remaining_commission_php_cents: stats.commission_php_cents };
}

function failCommissionClaim(state, claimId) {
  const claim = state.commission_claims?.[claimId];
  if (!claim || claim.status !== "logging" || claim.log_message_id) return false;
  claim.status = "failed";
  claim.audit_log.push({ action: "claim_log_failed", at: new Date().toISOString() });
  return true;
}

function inventoryFailureMessage(reason) {
  if (reason === "reconcile_cost_basis") {
    return "Current inventory has no known cost basis. Run `/stock action:set` to reconcile its quantity and total acquisition cost before recording sales or restocks.";
  }
  if (reason === "insufficient_stock") return "There is not enough stock for that operation.";
  if (reason === "invalid_quantity") return "The recorded transaction has an invalid lock quantity. Contact an administrator.";
  if (reason === "missing_ticket") return "The linked purchase ticket could not be found. Contact an administrator.";
  if (reason === "invalid_restock") return "Restock quantity must be greater than zero and purchase cost must be a valid non-negative PHP amount.";
  if (reason === "invalid_inventory_value") return "A zero inventory quantity must have a zero cost basis.";
  if (reason === "overflow" || reason === "invalid_accounting" || reason === "invalid_cost_basis") {
    return "The inventory values exceed the supported accounting range. Check the stock and cost inputs.";
  }
  if (reason === "duplicate") return "This transaction has already been recorded.";
  return "Enter valid non-negative whole-number lock quantities and a valid PHP cost.";
}

function completedDiamondLocksForTicket(stats, ticket) {
  const quantity = Number(ticket.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 0) return null;
  const previousWorldLocks = totalTicketWorldLocks(stats);
  const additionalWorldLocks = worldLocks(quantity, ticket.quantity_type);
  if (!Number.isSafeInteger(previousWorldLocks) || additionalWorldLocks === null
    || !Number.isSafeInteger(additionalWorldLocks)) return null;
  return Math.floor((previousWorldLocks + additionalWorldLocks) / WORLD_LOCKS_PER_DIAMOND_LOCK)
    - Math.floor(previousWorldLocks / WORLD_LOCKS_PER_DIAMOND_LOCK);
}

function totalTicketWorldLocks(stats) {
  const worldLocks = Number(stats.world_locks || 0) + Number(stats.quantity || 0);
  const diamondLocks = Number(stats.diamond_locks || 0);
  const blueGemLocks = Number(stats.blue_gem_locks || 0);
  if (![worldLocks, diamondLocks, blueGemLocks].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  return worldLocks + (diamondLocks + blueGemLocks * DIAMOND_LOCKS_PER_BLUE_GEM_LOCK) * WORLD_LOCKS_PER_DIAMOND_LOCK;
}

function commissionCentsForTicket(stats, ticket, rateCents) {
  const completedDiamondLocks = completedDiamondLocksForTicket(stats, ticket);
  if (completedDiamondLocks === null || !Number.isSafeInteger(rateCents)) return null;
  return completedDiamondLocks * rateCents;
}

function getRewardTiers() {
  const tiers = data.reward_tiers || DEFAULT_REWARD_TIERS;
  return new Map(
    Object.entries(tiers)
      .map(([cost, reward]) => [Number(cost), String(reward)])
      .filter(([cost, reward]) => Number.isInteger(cost) && cost > 0 && reward.trim())
      .sort(([a], [b]) => a - b),
  );
}

function affordableRewardTiers(balanceTenths, tiers = getRewardTiers()) {
  const balance = Number(balanceTenths);
  if (!Number.isSafeInteger(balance) || balance < 0) return [];
  return [...tiers].filter(([cost]) => Number.isSafeInteger(cost)
    && cost > 0
    && Number.isSafeInteger(cost * POINT_SCALE)
    && cost * POINT_SCALE <= balance);
}

function normalizeTicketStats(stats) {
  const rawWorldLocks = Number(stats.world_locks || 0) + Number(stats.quantity || 0);
  const totalDiamondLocks = Number(stats.diamond_locks || 0)
    + Math.floor(rawWorldLocks / WORLD_LOCKS_PER_DIAMOND_LOCK);
  return {
    claims: Number(stats.claims || 0),
    blueGemLocks: Number(stats.blue_gem_locks || 0)
      + Math.floor(totalDiamondLocks / DIAMOND_LOCKS_PER_BLUE_GEM_LOCK),
    diamondLocks: totalDiamondLocks % DIAMOND_LOCKS_PER_BLUE_GEM_LOCK,
    worldLocks: rawWorldLocks % WORLD_LOCKS_PER_DIAMOND_LOCK,
  };
}

const PAYMENT_METHOD_LABELS = {
  gcash: "GCash",
  binance: "Binance",
  paypal: "Paypal",
  wise: "Wise",
};
const PAYMENT_METHOD_EMOJIS = {
  gcash: "<:gcash:1571440261890834615>",
  binance: "<:bnb:1571440078226460703>",
  paypal: "<:paypal:1571440749570953256>",
  wise: "<:wise:1571440378958053408>",
};

function calculateMidmanFeeCents(amountPesos) {
  if (!Number.isFinite(amountPesos) || amountPesos < 0) return null;
  let feePesos;
  if (amountPesos <= 150) feePesos = 10;
  else if (amountPesos <= 350) feePesos = 15;
  else if (amountPesos <= 600) feePesos = 20;
  else if (amountPesos <= 1000) feePesos = 25;
  else feePesos = 30;
  return Math.round(feePesos * 100);
}

async function resolveGuildMember(guild, input) {
  const userId = String(input).trim();
  if (!/^\d{17,20}$/.test(userId)) return null;
  try {
    return await guild.members.fetch(userId);
  } catch (error) {
    if (error.code === 10007) return null;
    throw error;
  }
}

function formatQuantity(quantity, type = "world_lock") {
  const emoji = type === "blue_gem_lock"
    ? "<:bgl:1574400431826800710>"
    : type === "diamond_lock"
      ? "<:diamondlock:1571426833981906944>"
      : "<:worldlock:1571426562824216687>";
  return `\`${quantity}\` ${emoji}`;
}

function worldLocks(quantity, type) {
  if (type === "blue_gem_lock") return quantity * WORLD_LOCKS_PER_BLUE_GEM_LOCK;
  if (type === "diamond_lock") return quantity * WORLD_LOCKS_PER_DIAMOND_LOCK;
  if (type === "world_lock") return quantity;
  return null;
}

function vouchWorldLocks(vouch) {
  const totalWorldLocks = vouch.quantity_world_locks == null
    ? worldLocks(Number(vouch.quantity), vouch.quantity_type || "world_lock")
    : Number(vouch.quantity_world_locks);
  return Number.isSafeInteger(totalWorldLocks) && totalWorldLocks > 0 ? totalWorldLocks : null;
}

function formatNormalizedWorldLocks(totalWorldLocks, fallbackQuantity, fallbackType) {
  if (!Number.isSafeInteger(totalWorldLocks) || totalWorldLocks <= 0) {
    return formatQuantity(fallbackQuantity, fallbackType);
  }
  const blueGemLocks = Math.floor(totalWorldLocks / WORLD_LOCKS_PER_BLUE_GEM_LOCK);
  const remainderAfterBlueGems = totalWorldLocks % WORLD_LOCKS_PER_BLUE_GEM_LOCK;
  const diamondLocks = Math.floor(remainderAfterBlueGems / WORLD_LOCKS_PER_DIAMOND_LOCK);
  const remainingWorldLocks = remainderAfterBlueGems % WORLD_LOCKS_PER_DIAMOND_LOCK;
  return [
    blueGemLocks > 0 ? formatQuantity(blueGemLocks, "blue_gem_lock") : null,
    diamondLocks > 0 ? formatQuantity(diamondLocks, "diamond_lock") : null,
    remainingWorldLocks > 0 ? formatQuantity(remainingWorldLocks, "world_lock") : null,
  ].filter(Boolean).join(" + ");
}

function formatNormalizedLockQuantity(quantity, type) {
  return formatNormalizedWorldLocks(worldLocks(Number(quantity), type), quantity, type);
}

function formatNormalizedVouchQuantity(vouch) {
  return formatNormalizedWorldLocks(vouchWorldLocks(vouch), vouch.quantity, vouch.quantity_type);
}

function makeEmbed(title, description, color = 0x5865f2) {
  const embed = new EmbedBuilder().setTitle(title).setColor(color);
  if (description !== null && description !== undefined) embed.setDescription(description);
  return embed;
}

function commandsEmbed(member) {
  const lines = [
    "`/help` — Show this command list.",
    "`/points` — View your reward points.",
    "`/leaderboard` — Show the points leaderboard.",
    "`/rewards` — Show available rewards.",
    "`/redeem` — Request an affordable reward using a modal.",
  ];
  if (member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    lines.push(
      "`/setup_vouch` — Set up the vouch panel (Manage Server).",
      "`/stock` — View inventory; choose restock, reconcile/set, or remove to open a modal (Manage Server).",
      "`/sold action amount` — Adjust total sold (Manage Server).",
    );
  }
  if (member?.roles?.cache?.has(config.STAFF_ROLE_ID)
    || member?.permissions.has(PermissionFlagsBits.Administrator)) {
    lines.push("`/commission action:claim` — Log and claim your accrued commission.");
  }
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) {
    lines.push(
      "`/setup_ticket` — Set up the purchase ticket panel (Administrator).",
      "`/setup_midman` — Set up the midman service panel (Administrator).",
      "`/ticket [target]` — View ticket claims and handled quantity.",
      "`/ticketstat member` — Edit a member's ticket stats.",
      "`/managepoints action target amount` — Add or remove coins.",
      "`/changerewards` — Change available reward tiers.",
      "`/changerate` — Set independent BGL/DL/WL selling rates and staff commission.",
      "`/setstatus option:<Open or Close>` — Change the shop status voice channel.",
      "`/setpayment payment_method` — Set payment details.",
      "`/payment payment_method` — Send payment details.",
      "`/received` — Notify both parties that payment was received.",
      "`/sales` — Record a manual sale using a modal; sends the log to staff.",
      "`/profit` — View tracked revenue, cost of goods sold, commission, and net profit.",
    );
  }
  return makeEmbed("Available Commands", lines.join("\n"));
}

function makeButton(label, style, customId, emoji) {
  const button = new ButtonBuilder().setLabel(label).setStyle(style).setCustomId(customId);
  if (emoji) button.setEmoji(emoji);
  return button;
}

function textInput(customId, label, style = TextInputStyle.Short, required = true, placeholder, value) {
  const input = new TextInputBuilder().setCustomId(customId).setStyle(style).setRequired(required);
  if (placeholder) input.setPlaceholder(placeholder);
  if (value) input.setValue(value.slice(0, 4000));
  return input;
}

function ticketStatEditFirstModal(token, stats) {
  const worldLocks = Number(stats.world_locks || 0) + Number(stats.quantity || 0);
  return new ModalBuilder().setCustomId(`ticketstat:locks:${token}`).setTitle("Edit ticket stats (1/2)")
    .setLabelComponents(
      modalLabel("Tickets claimed", textInput("claims", "Tickets claimed", TextInputStyle.Short, true, "Whole number", String(stats.claims || 0))),
      modalLabel("Blue Gem Locks", textInput("blue_gem_locks", "Blue Gem Locks", TextInputStyle.Short, true, "Whole number", String(stats.blue_gem_locks || 0))),
      modalLabel("Diamond Locks", textInput("diamond_locks", "Diamond Locks", TextInputStyle.Short, true, "Whole number", String(stats.diamond_locks || 0))),
      modalLabel("World Locks", textInput("world_locks", "World Locks", TextInputStyle.Short, true, "Whole number", String(worldLocks))),
    );
}

function stockUpdateModal(action) {
  const isRemoval = action === "remove";
  const title = action === "restock" ? "Restock inventory" : action === "set" ? "Set / reconcile inventory" : "Remove inventory";
  const components = [
    modalLabel("World Locks", textInput("world_lock", "World Locks", TextInputStyle.Short, true, "Whole number", "0").setMaxLength(12)),
    modalLabel("Diamond Locks", textInput("diamond_lock", "Diamond Locks", TextInputStyle.Short, true, "Whole number", "0").setMaxLength(12)),
    modalLabel("Blue Gem Locks", textInput("blue_gem_lock", "Blue Gem Locks", TextInputStyle.Short, true, "Whole number", "0").setMaxLength(12)),
  ];
  if (isRemoval) {
    components.push(modalLabel("Reason", textInput("reason", "Reason", TextInputStyle.Short, false, "Optional audit note").setMaxLength(100)));
  } else {
    components.push(modalLabel(
      action === "restock" ? "Total purchase cost (PHP)" : "Cost basis of current inventory (PHP)",
      textInput(
        "purchase_cost",
        "Total cost in PHP",
        TextInputStyle.Short,
        true,
        "Enter the total cost, e.g. 1500.00",
      ).setMaxLength(20),
    ));
  }
  return new ModalBuilder()
    .setCustomId(`stock:update:${action}`)
    .setTitle(title)
    .setLabelComponents(...components);
}

function ticketStatEditCommissionModal(token, stats) {
  return new ModalBuilder().setCustomId(`ticketstat:commission:${token}`).setTitle("Edit ticket stats (2/2)")
    .setLabelComponents(
      modalLabel("Commission DLs", textInput(
        "commission_diamond_locks",
        "Commission DLs",
        TextInputStyle.Short,
        true,
        "Whole number",
        String(stats.commission_diamond_locks || 0),
      )),
      modalLabel("Commission PHP", textInput(
        "commission_php",
        "Commission PHP",
        TextInputStyle.Short,
        true,
        "Amount, up to 2 decimal places",
        formatPhpCents(Number(stats.commission_php_cents || 0)),
      )),
    );
}

function quantityTypeSelect(customId = "quantity_type", selectedType = null) {
  const options = [
    ["World Lock", "world_lock", "1571426562824216687"],
    ["Diamond Lock", "diamond_lock", "1571426833981906944"],
    ["Blue Gem Lock", "blue_gem_lock", "1574400431826800710"],
  ].map(([label, value, emojiId]) => {
    const option = new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setValue(value)
      .setEmoji({ id: emojiId });
    if (selectedType === value) option.setDefault(true);
    return option;
  });
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("Select a quantity type")
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(options);
}

function paymentMethodSelect(customId = "payment_method", selectedMethod = null) {
  const options = [
    ["GCash", "GCash", "1571440261890834615"],
    ["Binance", "Binance", "1571440078226460703"],
    ["Paypal", "Paypal", "1571440749570953256"],
    ["Wise", "Wise", "1571440378958053408"],
  ].map(([label, value, emojiId]) => {
    const option = new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setValue(value)
      .setEmoji({ id: emojiId });
    if (selectedMethod === value) option.setDefault(true);
    return option;
  });
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("Select a payment method")
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(options);
}

function ticketVouchModal(kind, id, ticket) {
  const paymentMethod = PAYMENT_METHOD_LABELS[String(ticket.payment_method || "").toLowerCase()];
  return new ModalBuilder()
    .setCustomId(`ticketvouch:submit:${kind}:${id}`)
    .setTitle("Submit a vouch")
    .setLabelComponents(
      modalLabel(
        "How many did you buy?",
        textInput("quantity", "Quantity", TextInputStyle.Short, true, "Enter the quantity", String(ticket.quantity)),
      ),
      modalLabel("Type", quantityTypeSelect("quantity_type", ticket.quantity_type)),
      modalLabel("Payment method", paymentMethodSelect("payment_method", paymentMethod)),
      modalLabel("Note (optional)", textInput("note", "Note", TextInputStyle.Paragraph, false, "Legit seller, fast delivery, etc.")),
    );
}

function rewardRedemptionModal(availableTiers) {
    if (availableTiers.length === 0 || availableTiers.length > 25) {
      throw new Error("Reward selection must contain between 1 and 25 available tiers.");
    }
    const options = availableTiers.map(([cost, reward]) => new StringSelectMenuOptionBuilder()
      .setLabel(`${cost} coins — ${reward}`.slice(0, 100))
      .setValue(String(cost))
      .setDescription(`Redeem ${cost} points`));
    const rewardSelect = new StringSelectMenuBuilder()
      .setCustomId("reward_cost")
      .setPlaceholder("Choose an affordable reward")
      .setMinValues(1)
      .setMaxValues(1)
      .setOptions(options);
    return new ModalBuilder()
      .setCustomId("redeem:submit")
      .setTitle("Redeem points")
      .setLabelComponents(
        modalLabel("Reward", rewardSelect),
        modalLabel("World name", textInput("world_name", "World name", TextInputStyle.Short, true, "Name of the world").setMaxLength(100)),
        modalLabel("World owner", textInput("world_owner", "World owner", TextInputStyle.Short, true, "Owner of the world").setMaxLength(100)),
      );
}

function ticketVouchButton(kind, id) {
  return [new ActionRowBuilder().addComponents(
    makeButton("Leave a Vouch", ButtonStyle.Primary, `${kind}:vouch:${id}`, "⭐"),
  )];
}

function ticketSuccessEmbed() {
  return makeEmbed("Purchase Successful", "This purchase ticket was marked successful.", 0x57f287);
}

function midmanSuccessEmbed() {
  return makeEmbed("Midman Transaction Successful", "This midman transaction was marked successful.", 0x57f287);
}

function ticketSuccessMessage(ticketId, makerId) {
  return {
    content: `<@${makerId}>`,
    allowedMentions: { users: [String(makerId)] },
    embeds: [ticketSuccessEmbed()],
    components: ticketVouchButton("ticket", ticketId),
  };
}

function midmanSuccessMessage(ticketId, makerId) {
  return {
    content: `<@${makerId}>`,
    allowedMentions: { users: [String(makerId)] },
    embeds: [midmanSuccessEmbed()],
    components: ticketVouchButton("midman", ticketId),
  };
}

function feePayerSelect() {
  return new StringSelectMenuBuilder()
    .setCustomId("fee_payer")
    .setPlaceholder("Who pays the middleman fee?")
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(
      new StringSelectMenuOptionBuilder().setLabel("Buyer").setValue("buyer"),
      new StringSelectMenuOptionBuilder().setLabel("Seller").setValue("seller"),
    );
}

function midmanTicketButtons(midmanId, status = "open") {
  return [new ActionRowBuilder().addComponents(
    makeButton("Claim Ticket", ButtonStyle.Primary, `midman:claim:${midmanId}`, "📜").setDisabled(status !== "open"),
    makeButton("Successful", ButtonStyle.Success, `midman:success:${midmanId}`, "✅").setDisabled(status !== "completed"),
    makeButton("Close", ButtonStyle.Danger, `midman:close:${midmanId}`, "🔒"),
  )];
}

async function updateMidmanControlMessage(ticket, status) {
  if (!ticket.message_id) return;
  const channel = await client.channels.fetch(ticket.channel_id);
  if (!channel?.isTextBased()) throw new Error(`Midman ticket ${ticket.number} channel is unavailable.`);
  const message = await channel.messages.fetch(ticket.message_id);
  await message.edit({ components: midmanTicketButtons(ticket.id, status) });
}

function modalLabel(label, component) {
  const builder = new LabelBuilder().setLabel(label);
  if (component instanceof StringSelectMenuBuilder) {
    return builder.setStringSelectMenuComponent(component);
  }
  if (component instanceof TextInputBuilder) {
    return builder.setTextInputComponent(component);
  }
  throw new Error("Unsupported modal label component.");
}

function validQuantity(value) {
  return QUANTITY_PATTERN.test(value) && Number(value) > 0;
}

async function sendCounter(guild, envName, channelName) {
  const channelId = config[envName];
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error(`${envName} must identify a voice channel in this server.`);
  if (channel.name !== channelName) await channel.setName(channelName);
}

async function updateRateVoiceChannel(guild, rateCents) {
  const channelId = config.RATE_VOICE_CHANNEL_ID;
  if (!channelId) throw new Error("RATE_VOICE_CHANNEL_ID is not configured.");
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice || channel.guildId !== guild.id) {
    throw new Error("RATE_VOICE_CHANNEL_ID must identify a voice channel in this server.");
  }
  const channelName = `💰 Rate: ₱ ${formatPhpCents(rateCents)}`;
  if (channel.name !== channelName) await channel.setName(channelName);
}

function statusVoiceChannelName(status) {
  if (status === "open") return "Status: Open🟢";
  if (status === "close") return "Status: Close🔴";
  throw new Error("Status must be open or close.");
}

async function updateStatusVoiceChannel(guild, status) {
  const channelId = config.STATUS_VOICE_CHANNEL_ID;
  if (!channelId) throw new Error("STATUS_VOICE_CHANNEL_ID is not configured.");
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice || channel.guildId !== guild.id) {
    throw new Error("STATUS_VOICE_CHANNEL_ID must identify a voice channel in this server.");
  }
  const channelName = statusVoiceChannelName(status);
  if (channel.name !== channelName) await channel.setName(channelName);
}

async function requireGuildManager(interaction) {
  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "You need the Manage Server permission to use this command.", flags: MessageFlags.Ephemeral });
    return false;
  }
  return true;
}

async function handleCommand(interaction) {
  const { commandName: name } = interaction;
  const member = interaction.member;
  if (name === "help") {
    return interaction.reply({ embeds: [commandsEmbed(member)], flags: MessageFlags.Ephemeral });
  }
  if (name === "setup_vouch") {
    if (!await requireGuildManager(interaction)) return;
    if (!interaction.channel?.isTextBased()) return interaction.reply({ content: "Use this command in a server text channel.", flags: MessageFlags.Ephemeral });
    await mutate(state => { state.vouch_channel_id = interaction.channelId; });
    return interaction.reply({
      embeds: [makeEmbed("Leave a vouch", "Bought from us? Click the button below to submit a vouch for staff review.")],
      components: [new ActionRowBuilder().addComponents(makeButton("Vouch", ButtonStyle.Primary, "vouch:open", "⭐"))],
    });
  }
  if (name === "setup_ticket") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can set up the purchase panel.", flags: MessageFlags.Ephemeral });
    }
    const embed = makeEmbed("💵 Purchase here!", "Wanna buy from us? Click below to make a purchase!");
    embed.setFooter({ text: "Powered by The Vault", iconURL: client.user.displayAvatarURL() });
    return interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(makeButton("Purchase", ButtonStyle.Primary, "ticket:open", "🎫"))],
    });
  }
  if (name === "setup_midman") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can set up the midman panel.", flags: MessageFlags.Ephemeral });
    }
    if (!interaction.channel?.isTextBased()) {
      return interaction.reply({ content: "Use this command in a server text channel.", flags: MessageFlags.Ephemeral });
    }
    const embed = makeEmbed("Midman Service 🏷️",
      "**Fee per transaction** 💵\n"
      + "1-150 PHP → 10 Pesos\n"
      + "151-350 PHP → 15 Pesos\n"
      + "351-600 PHP → 20 Pesos\n"
      + "601-1000 PHP → 25 Pesos\n"
      + "1001+ PHP → 30 Pesos\n\n"
      + "**Terms**\n"
      + "• The fee is paid by the buyer or the seller, picked when the ticket is opened\n"
      + "• The middleman coordinates the transfer until the buyer confirms receipt; the bot does not hold funds\n"
      + "• Send the transfer receipt and a screenshot of trade.\n"
      + "• Canceling after the money is in → the fee isn't refunded");
    return interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        makeButton("Selling", ButtonStyle.Primary, "midman:open:selling", "🏷️"),
        makeButton("Buying", ButtonStyle.Success, "midman:open:buying", "🛒"),
      )],
    });
  }
  if (name === "setstatus") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can change the shop status.", flags: MessageFlags.Ephemeral });
    }
    const status = interaction.options.getString("option", true);
    if (!["open", "close"].includes(status)) {
      return interaction.reply({ content: "Choose Open or Close.", flags: MessageFlags.Ephemeral });
    }
    try {
      await updateStatusVoiceChannel(interaction.guild, status);
    } catch (error) {
      console.error("Could not update the shop status voice channel", error);
      return interaction.reply({ content: `Could not update the status channel: ${error.message}`, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({
      content: `Shop status updated: **${status === "open" ? "Open🟢" : "Close🔴"}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (name === "ticket") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can view ticket stats.", flags: MessageFlags.Ephemeral });
    }
    const target = interaction.options.getUser("target") || interaction.user;
    const stats = data.ticket_stats[target.id] || {};
    const normalized = normalizeTicketStats(stats);
    const embed = makeEmbed("Ticket Stats", `Stats for <@${target.id}>.`)
      .addFields(
        { name: "Tickets claimed", value: String(normalized.claims), inline: true },
        { name: "Blue Gem Locks", value: `${normalized.blueGemLocks} <:bgl:1574400431826800710>`, inline: true },
        { name: "Diamond Locks", value: `${normalized.diamondLocks} <:diamondlock:1571426833981906944>`, inline: true },
        { name: "World Locks", value: `${normalized.worldLocks} <:worldlock:1571426562824216687>`, inline: true },
        { name: "Commission DLs", value: String(stats.commission_diamond_locks || 0), inline: true },
        { name: "Commission accrued", value: `₱ ${formatPhpCents(Number(stats.commission_php_cents || 0))}`, inline: true },
      );
    return interaction.reply({ embeds: [embed] });
  }
  if (name === "commission") {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: "Commission claims can only be made in a server.", flags: MessageFlags.Ephemeral });
    }
    const isStaff = interaction.member?.roles?.cache?.has(config.STAFF_ROLE_ID)
      || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!isStaff) {
      return interaction.reply({ content: "Only staff members can claim commission.", flags: MessageFlags.Ephemeral });
    }
    if (interaction.options.getString("action", true) !== "claim") {
      return interaction.reply({ content: "Choose the Claim action.", flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let staffChannel;
    try {
      staffChannel = await client.channels.fetch(config.STAFF_CHANNEL_ID);
    } catch (error) {
      console.error("Could not fetch staff channel for commission claim", error);
      return interaction.editReply("The staff log channel is unavailable; commission was not claimed.");
    }
    if (!staffChannel?.isTextBased() || typeof staffChannel.send !== "function") {
      return interaction.editReply("The staff log channel is unavailable; commission was not claimed.");
    }

    const reserved = await mutate(state => reserveCommissionClaim(state, interaction.user.id));
    if (!reserved.ok) {
      const message = reserved.reason === "none"
        ? "You have no accrued commission to claim."
        : reserved.reason === "pending"
          ? "A commission claim is already being processed. Please wait or contact an administrator."
          : "Your accrued commission stats are invalid. Contact an administrator.";
      return interaction.editReply(message);
    }

    const claim = reserved.claim;
    if (!reserved.resume) {
      const claimLog = makeEmbed("Commission Claim Approved", null, 0x57f287)
        .addFields(
          { name: "Staff member", value: `<@${claim.member_id}>`, inline: true },
          { name: "Commission payout", value: `₱ ${formatPhpCents(claim.commission_php_cents)}`, inline: true },
          { name: "Commission DLs", value: String(claim.commission_diamond_locks), inline: true },
          { name: "Approved by", value: `<@${interaction.user.id}>`, inline: true },
          { name: "Action", value: "Payout is recorded before accrued commission stats are reset.", inline: false },
        )
        .setFooter({ text: `Claim ID: ${claim.id}` })
        .setTimestamp();
      let logMessage;
      try {
        logMessage = await staffChannel.send({
          embeds: [claimLog],
          allowedMentions: { users: [claim.member_id, interaction.user.id] },
        });
      } catch (error) {
        console.error(`Could not log commission claim ${claim.id}`, error);
        await mutate(state => failCommissionClaim(state, claim.id));
        return interaction.editReply("The commission claim could not be logged, so no stats were reset.");
      }
      const attached = await mutate(state => attachCommissionClaimLog(state, claim.id, logMessage.id));
      if (!attached) {
        return interaction.editReply(`The claim log was sent, but its record could not be attached (claim ${claim.id}). Contact an administrator before retrying.`);
      }
    }

    let finalized;
    try {
      finalized = await mutate(state => finalizeCommissionClaim(state, claim.id));
    } catch (error) {
      console.error(`Commission claim ${claim.id} was logged but could not be finalized`, error);
      return interaction.editReply(`The claim was logged, but commission stats were not reset (claim ${claim.id}). Retry the claim or contact an administrator.`);
    }
    if (!finalized.ok) {
      return interaction.editReply(`The claim was logged, but commission stats changed before reset. Contact an administrator (claim ${claim.id}).`);
    }
    return interaction.editReply(
      `Commission claimed: ₱ ${formatPhpCents(finalized.claim.commission_php_cents)}. `
      + `The payout was logged before commission totals were reset.`,
    );
  }
  if (name === "ticketstat") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can edit ticket stats.", flags: MessageFlags.Ephemeral });
    }
    const target = interaction.options.getUser("member", true);
    const stats = data.ticket_stats[target.id] || {};
    for (const [token, pending] of pendingTicketStatEdits) {
      if (pending.expires_at <= Date.now()) pendingTicketStatEdits.delete(token);
    }
    const token = crypto.randomUUID().replaceAll("-", "");
    pendingTicketStatEdits.set(token, {
      admin_id: interaction.user.id,
      target_id: target.id,
      expires_at: Date.now() + 15 * 60 * 1000,
      commission_defaults: {
        commission_diamond_locks: stats.commission_diamond_locks || 0,
        commission_php_cents: stats.commission_php_cents || 0,
      },
    });
    return interaction.showModal(ticketStatEditFirstModal(token, stats));
  }
  if (name === "points") {
    return interaction.reply({ embeds: [makeEmbed("Points Balance", `<@${interaction.user.id}> has **${formatPoints(data.points_tenths[interaction.user.id] || 0)} coins**. 🪙`)] });
  }
  if (name === "managepoints") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can manage points.", flags: MessageFlags.Ephemeral });
    }
    const action = interaction.options.getString("action", true);
    const target = interaction.options.getUser("target", true);
    const amountText = interaction.options.getString("amount", true);
    if (!validQuantity(amountText)) {
      return interaction.reply({ content: "Amount must be a whole number from 1 to 999,999,999.", flags: MessageFlags.Ephemeral });
    }
    if (!["add", "remove"].includes(action)) {
      return interaction.reply({ content: "Choose Add or Remove.", flags: MessageFlags.Ephemeral });
    }
    const amount = Number(amountText) * POINT_SCALE;
    const result = await mutate(state => {
      return updatePointsBalance(state, target.id, action === "add" ? amount : -amount);
    });
    if (result === null) {
      return interaction.reply({ content: `<@${target.id}> does not have enough points for that update.`, flags: MessageFlags.Ephemeral });
    }
    const verb = action === "add" ? "Added" : "Removed";
    return interaction.reply({
      embeds: [makeEmbed("Points Updated", `${verb} **${amountText} coins** ${action === "add" ? "to" : "from"} <@${target.id}>.\nNew balance: **${formatPoints(result)} coins**. 🪙`, 0x57f287)],
      allowedMentions: { users: [target.id] },
    });
  }
  if (name === "changerewards") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can change rewards.", flags: MessageFlags.Ephemeral });
    }
    const tiers = getRewardTiers();
    const modal = new ModalBuilder().setCustomId("rewards:change").setTitle("Change reward tiers")
      .setLabelComponents(
        modalLabel(
          "Reward tiers",
          textInput(
            "tiers",
            "Reward tiers",
            TextInputStyle.Paragraph,
            true,
            "One tier per line: 50=10 World Locks",
            [...tiers].map(([cost, reward]) => `${cost}=${reward}`).join("\n"),
          ),
        ),
      );
    return interaction.showModal(modal);
  }
  if (name === "changerate") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can change rates.", flags: MessageFlags.Ephemeral });
    }
    const rates = data.rates || DEFAULT_DATA().rates;
    const modal = new ModalBuilder()
      .setCustomId("rates:change")
      .setTitle("Change rates (PHP)")
      .setLabelComponents(
        modalLabel(
          "Diamond Lock rate (PHP)",
          textInput("diamond_lock_rate", "Diamond Lock rate", TextInputStyle.Short, true, "Example: 30 or 30.50",
            Number.isSafeInteger(rates.diamond_lock_php_cents) ? formatPhpCents(rates.diamond_lock_php_cents) : "").setMaxLength(20),
        ),
        modalLabel(
          "World Lock rate (PHP)",
          textInput("world_lock_rate", "World Lock rate", TextInputStyle.Short, true, "Example: 0.30",
            Number.isSafeInteger(rates.world_lock_php_cents) ? formatPhpCents(rates.world_lock_php_cents) : "").setMaxLength(20),
        ),
        modalLabel(
          "Blue Gem Lock rate (PHP, independent)",
          textInput("blue_gem_lock_rate", "Blue Gem Lock rate", TextInputStyle.Short, true, "Discounted BGL price, e.g. 2500",
            Number.isSafeInteger(rates.blue_gem_lock_php_cents) ? formatPhpCents(rates.blue_gem_lock_php_cents) : "").setMaxLength(20),
        ),
        modalLabel(
          "Staff commission per whole Diamond Lock (PHP)",
          textInput("staff_commission_rate", "Commission per Diamond Lock", TextInputStyle.Short, true, "Example: 1 or 1.50",
            Number.isSafeInteger(rates.staff_commission_per_diamond_lock_php_cents)
              ? formatPhpCents(rates.staff_commission_per_diamond_lock_php_cents)
              : "").setMaxLength(20),
        ),
      );
    return interaction.showModal(modal);
  }
  if (name === "setpayment") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can set payment details.", flags: MessageFlags.Ephemeral });
    }
    const method = interaction.options.getString("payment_method", true);
    const existing = data.payment_details?.[method] || "";
    const modal = new ModalBuilder()
      .setCustomId(`payment:set:${method}`)
      .setTitle(`Set ${PAYMENT_METHOD_LABELS[method]} details`)
      .setLabelComponents(
        modalLabel(
          "Payment details",
          textInput(
            "details",
            "Payment details",
            TextInputStyle.Paragraph,
            true,
            "Example: account name, number, or wallet address",
            existing,
          ),
        ),
      );
    return interaction.showModal(modal);
  }
  if (name === "payment") {
    const method = interaction.options.getString("payment_method", true);
    const details = data.payment_details?.[method]?.trim();
    const label = PAYMENT_METHOD_LABELS[method];
    if (!details) {
      return interaction.reply({
        content: `No ${label} payment details are configured. Use \`/setpayment payment_method:${label}\` first.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!interaction.inGuild()) {
      return interaction.reply({ content: "Payment details can only be sent in a server.", flags: MessageFlags.Ephemeral });
    }
    const midmanTicket = Object.values(data.midman_tickets || {}).find(
      ticket => ticket.channel_id === interaction.channelId && ["claimed", "payment_sent", "payment_received"].includes(ticket.status),
    );
    if (midmanTicket) {
      const isMiddleman = interaction.member?.roles?.cache?.has(config.STAFF_ROLE_ID)
        || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
      if (!isMiddleman) {
        return interaction.reply({ content: "Only middleman staff can send payment details.", flags: MessageFlags.Ephemeral });
      }
      const paymentEmbed = makeEmbed(`${PAYMENT_METHOD_EMOJIS[method]} ${label} Payment Details`, details);
      paymentEmbed.addFields(
        { name: "Buyer", value: `<@${midmanTicket.buyer_id}>`, inline: true },
        { name: "Seller", value: `<@${midmanTicket.seller_id}>`, inline: true },
        { name: "Quantity", value: formatNormalizedLockQuantity(midmanTicket.quantity, midmanTicket.quantity_type), inline: false },
        { name: "Transaction amount", value: `₱ ${formatPhpCents(midmanTicket.transaction_php_cents)}`, inline: true },
        { name: "Middleman fee", value: `₱ ${formatPhpCents(midmanTicket.fee_php_cents)}`, inline: true },
        { name: "Fee paid by", value: midmanTicket.fee_payer === "buyer" ? "Buyer" : "Seller", inline: true },
      );
      await interaction.reply({
        content: `<@${midmanTicket.buyer_id}>`,
        allowedMentions: { users: [midmanTicket.buyer_id] },
        embeds: [paymentEmbed],
        components: [new ActionRowBuilder().addComponents(
          makeButton("I sent the payment", ButtonStyle.Success, `midman:paid:${midmanTicket.id}`, "✅")
            .setDisabled(midmanTicket.status !== "claimed"),
        )],
      });
      await mutate(state => {
        const current = state.midman_tickets[midmanTicket.id];
        if (current && current.status === "claimed") {
          current.payment_method = method;
          recordAuditEvent(current, "payment_details_sent", interaction.user.id, { payment_method: method });
        }
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can send purchase payment details.", flags: MessageFlags.Ephemeral });
    }
    const channelTicket = Object.values(data.tickets).find(
      ticket => ticket.channel_id === interaction.channelId && ["open", "claimed"].includes(ticket.status),
    );
    const claimedTicket = channelTicket?.status === "claimed" ? channelTicket : null;
    const paymentEmbed = makeEmbed(`${PAYMENT_METHOD_EMOJIS[method]} ${label} Payment Details`, details);
    if (channelTicket) {
      const quote = await mutate(state => getOrCreateTicketQuote(state, channelTicket.id, interaction.user.id));
      if (!quote.ok) {
        return interaction.reply({
          content: "Payment rates are not configured. An administrator must run `/changerate` before payment can be requested.",
          flags: MessageFlags.Ephemeral,
        });
      }
      paymentEmbed.addFields(
        { name: "Order", value: formatNormalizedLockQuantity(channelTicket.quantity, channelTicket.quantity_type), inline: true },
        { name: "Amount to send", value: `**₱ ${formatPhpCents(quote.amount)}**`, inline: true },
      );
    }
    await interaction.reply({
      content: channelTicket ? `<@${channelTicket.owner_id}>` : undefined,
      allowedMentions: channelTicket ? { users: [String(channelTicket.owner_id)] } : undefined,
      embeds: [paymentEmbed],
      components: claimedTicket
        ? paymentSentButton(claimedTicket.id, Boolean(claimedTicket.payment_sent))
        : [],
    });
    if (claimedTicket) {
      await mutate(state => {
        const current = state.tickets[claimedTicket.id];
        if (current && current.status === "claimed") {
          current.payment_method = method;
          recordAuditEvent(current, "payment_details_sent", interaction.user.id, { payment_method: method });
        }
      });
    }
    return;
  }
  if (name === "received") {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
    }
    const midmanTicket = Object.values(data.midman_tickets || {}).find(
      ticket => ticket.channel_id === interaction.channelId && ticket.status === "payment_sent",
    );
    if (!midmanTicket) {
      return interaction.reply({ content: "Use `/received` after the buyer has confirmed payment was sent.", flags: MessageFlags.Ephemeral });
    }
    const isMiddleman = interaction.member?.roles?.cache?.has(config.STAFF_ROLE_ID)
      || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!isMiddleman) {
      return interaction.reply({ content: "Only middleman staff can mark payment as received.", flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply();
    const changed = await mutate(state => {
      const current = state.midman_tickets[midmanTicket.id];
      if (!current || !transitionMidman(current, "payment_received", "payment_received", interaction.user.id)) return false;
      current.payment_received_at = new Date().toISOString();
      return true;
    });
    if (!changed) {
      return interaction.editReply("Payment can only be marked received after the buyer confirms payment was sent.");
    }
    const receivedEmbed = makeEmbed("Payment Received 💵",
      `<@${midmanTicket.seller_id}>, please give the item to <@${midmanTicket.buyer_id}>.\n`
      + "Screenshot the trade and send it here.");
    try {
      await interaction.editReply({
      allowedMentions: { users: [midmanTicket.seller_id, midmanTicket.buyer_id] },
      embeds: [receivedEmbed],
      components: [new ActionRowBuilder().addComponents(
        makeButton("I received the item", ButtonStyle.Success, `midman:received-confirm:${midmanTicket.id}`, "✅"),
      )],
      });
    } catch (error) {
      await mutate(state => {
        const current = state.midman_tickets[midmanTicket.id];
        if (current?.status === "payment_received") {
          current.status = "payment_sent";
          delete current.payment_received_at;
          recordAuditEvent(current, "payment_received_notification_failed", interaction.user.id);
        }
      });
      throw error;
    }
    return;
  }
  if (name === "leaderboard") {
    const entries = Object.entries(data.points_tenths)
      .map(([userId, points]) => [userId, Number(points)])
      .filter(([, points]) => points > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const page = 0;
    return interaction.reply({
      embeds: [leaderboardEmbed(entries, page)],
      components: entries.length > PAGE_SIZE ? leaderboardButtons(page, entries.length) : [],
    });
  }
  if (name === "rewards") {
    const description = "Get rewarded for every coin! 🪙\n\n" + [...getRewardTiers()]
      .map(([cost, reward]) => `**${cost} coins** = ${reward}`).join("\n");
    return interaction.reply({ embeds: [makeEmbed("Available Rewards", description)] });
  }
  if (name === "redeem") {
    if (!interaction.inGuild()) {
      return interaction.reply({
        embeds: [makeEmbed("Server Required", "Reward redemptions can only be requested in a server.", 0xed4245)],
        flags: MessageFlags.Ephemeral,
      });
    }
    const balance = Number(data.points_tenths[interaction.user.id] || 0);
    const availableTiers = affordableRewardTiers(balance);
    if (availableTiers.length === 0) {
      return interaction.reply({
        embeds: [makeEmbed("No Rewards Available", `You have **${formatPoints(balance)} points**, which is not enough for any current reward tier.`, 0xed4245)],
        flags: MessageFlags.Ephemeral,
      });
    }
    if (availableTiers.length > 25) {
      return interaction.reply({
        content: "There are more than 25 rewards you can redeem. Ask an administrator to reduce the configured reward tiers before submitting.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.showModal(rewardRedemptionModal(availableTiers));
  }
  if (name === "sales") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can manage sales.", flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(salesEntryModal());
  }
  if (name === "stock") {
    if (!await requireGuildManager(interaction)) return;
    const action = interaction.options.getString("action");
    if (!action) {
      const stock = Number(data.total_stock);
      const inventory = makeEmbed("Inventory", null).addFields(
        { name: "Available stock", value: Number.isSafeInteger(stock) ? formatNormalizedWorldLocks(stock, 0, "world_lock") : "Invalid stock data", inline: true },
        { name: "Remaining cost basis", value: data.inventory_cost_basis_php_cents === null
          ? "Not reconciled"
          : `₱ ${formatPhpCents(data.inventory_cost_basis_php_cents)}`, inline: true },
      );
      return interaction.reply({ embeds: [inventory], flags: MessageFlags.Ephemeral });
    }
    if (!["restock", "set", "remove"].includes(action)) {
      return interaction.reply({ content: "Choose restock, set/reconcile, or remove.", flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(stockUpdateModal(action));
  }
  if (name === "profit") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can view profit reports.", flags: MessageFlags.Ephemeral });
    }
    const summary = calculateProfitSummary(data);
    const embed = makeEmbed("Profit report", null).addFields(
      { name: "Completed sales", value: String(summary.sale_count), inline: true },
      { name: "Recorded revenue", value: `₱ ${formatPhpCents(summary.revenue)}`, inline: true },
      { name: "Cost of goods sold", value: `₱ ${formatPhpCents(summary.cogs)}`, inline: true },
      { name: "Staff commission", value: `₱ ${formatPhpCents(summary.commission)}`, inline: true },
      { name: "Inventory write-offs", value: `₱ ${formatPhpCents(summary.writeoffs)}`, inline: true },
      { name: "Net profit", value: summary.net === null ? "Unavailable (accounting totals exceed supported range)" : `₱ ${formatPhpCents(summary.net)}`, inline: true },
      { name: "Current inventory value", value: summary.inventory_cost_basis_php_cents === null
        ? "Unknown — run `/stock action:set` to reconcile"
        : `₱ ${formatPhpCents(summary.inventory_cost_basis_php_cents)}`, inline: true },
    );
    if (summary.accounting_started_at) {
      embed.setFooter({ text: `Ledger tracked since ${new Date(summary.accounting_started_at).toLocaleDateString()}; older sales are not included.` });
    } else {
      embed.setFooter({ text: "No accounting baseline exists yet. Reconcile inventory with /stock action:set." });
    }
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
  if (name === "sold") {
    if (!await requireGuildManager(interaction)) return;
    const action = interaction.options.getString("action");
    const amount = interaction.options.getString("amount");
    if (!validQuantity(amount || "")) return interaction.reply({ content: "Amount must be a whole number from 1 to 999,999,999.", flags: MessageFlags.Ephemeral });
    if (action === "remove" && Number(amount) > Number(data.total_sold)) return interaction.reply({ content: `Cannot remove ${amount}: current total sold is ${data.total_sold}.`, flags: MessageFlags.Ephemeral });
    const total = await mutate(state => {
      if (action === "remove" && Number(amount) > Number(state.total_sold)) {
        throw new Error(`Cannot remove ${amount}: current total sold is ${state.total_sold}.`);
      }
      state.total_sold = Number(state.total_sold) + (action === "add" ? 1 : -1) * Number(amount);
      return state.total_sold;
    });
    let notice = "";
    if (interaction.guild) {
      try { await sendCounter(interaction.guild, "COUNTER_VOICE_CHANNEL_ID", `📦 Total Sold: ${total}`); }
      catch (error) { console.error("Could not update sales counter", error); notice = " The voice counter could not be updated."; }
    }
    return interaction.reply({ content: `Total sold ${action === "add" ? "increased" : "decreased"} by ${amount}. New total: ${total}.${notice}` });
  }
}

function leaderboardEmbed(entries, page) {
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const section = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const description = section.length
    ? section.map(([userId, points], index) => `**${page * PAGE_SIZE + index + 1}** <@${userId}> — **${formatPoints(points)} coins**`).join("\n")
    : "No users have earned points yet.";
  return new EmbedBuilder().setTitle("🪙 Points Leaderboard").setDescription(description).setColor(0x5865f2)
    .setFooter({ text: `Page ${page + 1} of ${totalPages} • ${entries.length} players` });
}

function leaderboardButtons(page, count) {
  const pages = Math.ceil(count / PAGE_SIZE);
  return [new ActionRowBuilder().addComponents(
    makeButton("Previous", ButtonStyle.Secondary, `leaderboard:page:${page - 1}`).setDisabled(page === 0),
    makeButton("Next", ButtonStyle.Secondary, `leaderboard:page:${page + 1}`).setDisabled(page >= pages - 1),
  )];
}

function reviewButtons(kind, id) {
  const prefix = kind === "vouch" ? "vouch-review" : "redemption-review";
  return [new ActionRowBuilder().addComponents(
    makeButton(kind === "vouch" ? "Approve & Post" : "Approve", ButtonStyle.Success, `${prefix}:approve:${id}`),
    makeButton("Reject", ButtonStyle.Danger, `${prefix}:reject:${id}`),
  )];
}

function redemptionEmbed(redemption) {
  return new EmbedBuilder().setTitle("Reward redemption request")
    .setDescription(`Status: ${redemption.status[0].toUpperCase()}${redemption.status.slice(1)}`)
    .setColor(0xfee75c).setTimestamp(new Date(redemption.created_at))
    .addFields(
      { name: "Player", value: `<@${redemption.buyer_id}>`, inline: false },
      { name: "Points", value: `${redemption.point_cost} 🪙`, inline: true },
      { name: "Reward", value: redemption.reward, inline: true },
      { name: "World", value: redemption.world_name || "Not provided", inline: true },
      { name: "World owner", value: redemption.world_owner || "Not provided", inline: true },
    );
}

function vouchReviewEmbed(vouch) {
  const embed = new EmbedBuilder().setTitle("Vouch pending review").setColor(0xfee75c)
    .setTimestamp(new Date(vouch.created_at))
    .addFields(
      { name: "Buyer", value: `<@${vouch.buyer_id}>`, inline: false },
      { name: "Quantity", value: formatNormalizedVouchQuantity(vouch), inline: true },
      { name: "Payment method", value: vouch.payment_method || "Not specified", inline: true },
    );
  if (vouch.note) embed.addFields({ name: "Note", value: vouch.note.slice(0, 1024), inline: false });
  if (vouch.avatar_url) embed.setThumbnail(vouch.avatar_url);
  return embed;
}

function publicVouchEmbed(vouch, metrics = null) {
  const embed = new EmbedBuilder().setTitle(metrics ? `⭐ Vouch #${metrics.count}` : "⭐ Vouch")
    .setColor(0x57f287).setTimestamp(new Date(vouch.created_at))
    .addFields(
      { name: "👤 Buyer", value: `<@${vouch.buyer_id}>`, inline: true },
      { name: "📦 Quantity", value: formatNormalizedVouchQuantity(vouch), inline: true },
      { name: "💳 Payment method", value: vouch.payment_method || "Not specified", inline: true },
    );
  if (metrics) {
    embed.addFields({ name: "🪙 Points Balance", value: `${formatPoints(metrics.points)} coins`, inline: true })
      .setFooter({ text: `📊 Running Total Sold: ${metrics.total_sold} • Ref: ${vouch.id}` });
  } else {
    embed.setFooter({ text: `Vouch ref: ${vouch.id}` });
  }
  if (vouch.note) embed.addFields({ name: "💬 Note", value: `> *"${vouch.note.replace(/\s+/g, " ").slice(0, 1018)}"*`, inline: false });
  if (vouch.avatar_url) embed.setThumbnail(vouch.avatar_url);
  return embed;
}

function ticketCloseLogEmbed(ticket, closedBy) {
  const successful = ticket.status === "success" || ticket.close_outcome_status === "success";
  const paymentMethod = PAYMENT_METHOD_LABELS[String(ticket.payment_method || "").toLowerCase()]
    || ticket.payment_method
    || "Not specified";
  const embed = new EmbedBuilder()
    .setTitle("Ticket closed")
    .setColor(successful ? 0x57f287 : 0xfee75c)
    .setTimestamp()
    .addFields(
      { name: "Ticket", value: `#${ticket.number} (<#${ticket.channel_id}>)`, inline: true },
      { name: "Buyer", value: `<@${ticket.owner_id}>`, inline: true },
      { name: "Claimed by", value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : "Not claimed", inline: true },
      { name: "Payment method", value: paymentMethod, inline: true },
      { name: "Amount", value: formatNormalizedLockQuantity(ticket.quantity, ticket.quantity_type), inline: true },
      { name: "Outcome", value: successful ? "Successful" : "Closed before being marked successful", inline: false },
      { name: "Closed by", value: `${closedBy.tag} (${closedBy.id})`, inline: false },
    );
  const activity = auditSummary(ticket);
  if (activity) embed.addFields({ name: "Recent activity", value: activity.slice(0, 1024), inline: false });
  if (successful) {
    if (Number.isSafeInteger(ticket.sale_revenue_php_cents)) {
      embed.addFields({ name: "Sale total", value: `₱ ${formatPhpCents(ticket.sale_revenue_php_cents)}`, inline: true });
    }
    if (Number.isSafeInteger(ticket.sale_cogs_php_cents)) {
      embed.addFields({ name: "Cost of goods sold", value: `₱ ${formatPhpCents(ticket.sale_cogs_php_cents)}`, inline: true });
    }
    embed.addFields({
      name: "Staff commission",
      value: `₱ ${formatPhpCents(Number(ticket.staff_commission_php_cents || 0))} for ${Number(ticket.staff_commission_diamond_locks || 0)} whole Diamond Locks`,
      inline: false,
    });
  }
  return embed;
}

function auditSummary(ticket) {
  return (ticket.audit_log || []).slice(-8).map(event => {
    const timestamp = Date.parse(event.at);
    const when = Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:f>` : "Unknown time";
    const actor = event.actor_id ? `<@${event.actor_id}>` : "System";
    return `${when} — ${String(event.action || "activity").replaceAll("_", " ")} — ${actor}`;
  }).join("\n");
}

function midmanCloseLogEmbed(ticket, closedBy) {
  const outcome = (ticket.close_outcome_status || ticket.status) === "success"
    ? "Successful"
    : "Closed before being marked successful";
  const embed = makeEmbed("Midman Ticket Closed",
    `**Ticket:** #${ticket.number} (<#${ticket.channel_id}>)\n`
    + `**Buyer:** <@${ticket.buyer_id}>\n**Seller:** <@${ticket.seller_id}>\n`
    + `**Quantity:** ${formatNormalizedLockQuantity(ticket.quantity, ticket.quantity_type)}\n`
    + `**Transaction:** ₱ ${formatPhpCents(ticket.transaction_php_cents)}\n`
    + `**Middleman fee:** ₱ ${formatPhpCents(ticket.fee_php_cents)} (${ticket.fee_payer})\n`
    + `**Outcome:** ${outcome}\n**Closed by:** ${closedBy.tag} (${closedBy.id})`);
  const activity = auditSummary(ticket);
  if (activity) embed.addFields({ name: "Recent activity", value: activity.slice(0, 1024), inline: false });
  return embed;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function transcriptMessageHtml(message) {
  const author = message.author;
  const authorLabel = author?.tag || author?.username || "Unknown user";
  const timestamp = message.createdAt instanceof Date
    ? message.createdAt
    : Number.isFinite(message.createdTimestamp) ? new Date(message.createdTimestamp) : null;
  const createdAt = timestamp?.toISOString() || "Unknown time";
  const content = message.content ? `<pre class="content">${escapeHtml(message.content)}</pre>` : "";
  const attachments = [...(message.attachments?.values() || [])].map(attachment => {
    const url = String(attachment.url || "");
    const label = escapeHtml(attachment.name || "Attachment");
    return `<li>${/^https?:\/\//i.test(url) ? `<a href="${escapeHtml(url)}">${label}</a>` : label}</li>`;
  }).join("");
  const embeds = (message.embeds || []).map(embed => {
    const fields = (embed.fields || []).map(field =>
      `<dt>${escapeHtml(field.name)}</dt><dd>${escapeHtml(field.value)}</dd>`,
    ).join("");
    const imageUrl = String(embed.image?.url || embed.thumbnail?.url || "");
    const image = /^https?:\/\//i.test(imageUrl)
      ? `<img class="embed-image" src="${escapeHtml(imageUrl)}" alt="Embed image">`
      : "";
    return `<section class="embed">${embed.author?.name ? `<div>${escapeHtml(embed.author.name)}</div>` : ""}`
      + `<strong>${escapeHtml(embed.title || "Embed")}</strong>`
      + `${embed.description ? `<pre>${escapeHtml(embed.description)}</pre>` : ""}`
      + `${fields ? `<dl>${fields}</dl>` : ""}${image}`
      + `${embed.footer?.text ? `<small>${escapeHtml(embed.footer.text)}</small>` : ""}</section>`;
  }).join("");
  const files = attachments ? `<ul class="attachments">${attachments}</ul>` : "";
  return `<article class="message"><header><strong>${escapeHtml(authorLabel)}</strong> `
    + `<span class="user-id">${escapeHtml(author?.id || "")}</span> · `
    + `<time datetime="${escapeHtml(createdAt)}">${escapeHtml(createdAt)}</time></header>`
    + `${content}${embeds}${files}</article>`;
}

function buildTicketTranscriptHtml(kind, ticket, messages, truncated = false) {
  const title = `${kind === "midman" ? "Midman" : "Purchase"} Ticket #${ticket.number}`;
  const audit = (ticket.audit_log || []).map(event => {
    const details = Object.keys(event.details || {}).length
      ? ` — ${JSON.stringify(event.details)}`
      : "";
    return `<li><time>${escapeHtml(event.at || "Unknown time")}</time> — `
      + `${escapeHtml(String(event.action || "activity").replaceAll("_", " "))} — `
      + `${escapeHtml(event.actor_id || "System")}${escapeHtml(details)}</li>`;
  }).join("");
  const entries = messages.map(transcriptMessageHtml).join("\n");
  const warning = truncated
    ? `<p class="notice">Transcript was truncated to fit the attachment size limit.</p>`
    : "";
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} transcript</title>`
    + `<style>body{font:14px system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#222}`
    + "header{border-bottom:1px solid #ccc;padding-bottom:.5rem}.message{border-bottom:1px solid #ddd;padding:1rem 0}"
    + ".content,pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.user-id,time{color:#666;font-size:.85em}"
    + ".embed{border-left:4px solid #5865f2;padding:.5rem 1rem;margin:.5rem 0;background:#f5f5f5}"
    + ".embed-image{display:block;max-width:100%;max-height:600px;margin-top:.5rem}"
    + ".notice{background:#fff3cd;padding:.75rem}.attachments{margin:.5rem 0}</style></head><body>"
    + `<h1>${escapeHtml(title)} transcript</h1>${warning}`
    + `<p>Guild: ${escapeHtml(ticket.guild_id || "")} · Channel: ${escapeHtml(ticket.channel_id || "")}</p>`
    + `<h2>Audit history</h2><ol>${audit || "<li>No audit events recorded.</li>"}</ol>`
    + `<h2>Messages (${messages.length})</h2>${entries || "<p>No messages were available.</p>"}`
    + "</body></html>";
}

async function createTicketTranscript(channel, kind, ticket, closedBy) {
  const messages = [];
  let before;
  let truncated = false;
  while (messages.length < TRANSCRIPT_MAX_MESSAGES) {
    const limit = Math.min(100, TRANSCRIPT_MAX_MESSAGES - messages.length);
    const page = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
    if (!page.size) break;
    messages.push(...page.values());
    const oldest = page.last();
    if (page.size < limit || !oldest) break;
    before = oldest.id;
  }
  if (messages.length >= TRANSCRIPT_MAX_MESSAGES) truncated = true;
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const ticketSnapshot = clone(ticket);
  ticketSnapshot.status = "closed";
  ticketSnapshot.close_outcome_status = ticket.close_outcome_status || ticket.status;
  ticketSnapshot.closed_at = ticket.closed_at || new Date().toISOString();
  recordAuditEvent(ticketSnapshot, "closed", closedBy.id);
  let html = buildTicketTranscriptHtml(kind, ticketSnapshot, messages, truncated);
  while (Buffer.byteLength(html, "utf8") > TRANSCRIPT_MAX_BYTES && messages.length > 1) {
    messages.splice(0, Math.max(1, Math.ceil(messages.length / 4)));
    truncated = true;
    html = buildTicketTranscriptHtml(kind, ticketSnapshot, messages, truncated);
  }
  if (Buffer.byteLength(html, "utf8") > TRANSCRIPT_MAX_BYTES) {
    throw new Error(`Ticket ${ticket.number} transcript exceeds the attachment size limit.`);
  }
  return {
    file: new AttachmentBuilder(Buffer.from(html, "utf8"), {
      name: `${kind}-${ticket.number}-transcript.html`,
    }),
    messageCount: messages.length,
    truncated,
  };
}

function reserveTicketClose(state, kind, id, actorId) {
  const collection = kind === "midman" ? state.midman_tickets : state.tickets;
  const current = collection[id];
  if (!current) return { found: false };
  if (current.status === "closed" && current.close_log_message_id) {
    return { found: true, closed: true, ticket: clone(current) };
  }
  if (current.status === "closing") return { found: true, closing: true };
  current.close_previous_status = current.status === "closed"
    ? current.close_outcome_status || "closed"
    : current.status;
  current.close_outcome_status = current.close_previous_status;
  current.status = "closing";
  recordAuditEvent(current, "close_started", actorId);
  return { found: true, ticket: clone(current) };
}

function finishTicketClose(state, kind, id, logMessageId, actorId) {
  const collection = kind === "midman" ? state.midman_tickets : state.tickets;
  const current = collection[id];
  if (!current || current.status !== "closing") return false;
  current.status = "closed";
  current.closed_at = new Date().toISOString();
  current.close_log_message_id = logMessageId;
  delete current.close_previous_status;
  recordAuditEvent(current, "closed", actorId);
  return true;
}

function abortTicketClose(state, kind, id, actorId) {
  const collection = kind === "midman" ? state.midman_tickets : state.tickets;
  const current = collection[id];
  if (!current || current.status !== "closing") return;
  current.status = current.close_previous_status || "open";
  delete current.close_previous_status;
  delete current.close_outcome_status;
  recordAuditEvent(current, "close_failed", actorId);
}

async function handleButton(interaction) {
  const id = interaction.customId;
  if (id.startsWith("midman:open:")) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: "Midman tickets can only be opened in a server.", flags: MessageFlags.Ephemeral });
    }
    const role = id.split(":")[2];
    if (!["selling", "buying"].includes(role)) {
      return interaction.reply({ content: "Invalid midman ticket type.", flags: MessageFlags.Ephemeral });
    }
    const makerIsSeller = role === "selling";
    const modal = new ModalBuilder()
      .setCustomId(`midman:submit:${role}`)
      .setTitle(makerIsSeller ? "Open selling midman ticket" : "Open buying midman ticket")
      .setLabelComponents(
        modalLabel(
          makerIsSeller ? "Buyer's Discord User ID" : "Seller's Discord User ID",
          textInput("opposite_user", "Discord User ID", TextInputStyle.Short, true, "Enable Developer Mode, then Copy User ID"),
        ),
        modalLabel(
          "Quantity",
          textInput("quantity", "Quantity", TextInputStyle.Short, true, "Example: 10"),
        ),
        modalLabel("Type", quantityTypeSelect("midman_quantity_type")),
        modalLabel(
          "Total transaction (PHP)",
          textInput("transaction_amount", "PHP amount", TextInputStyle.Short, true, "Example: 500"),
        ),
        modalLabel("Fee paid by", feePayerSelect()),
      );
    return interaction.showModal(modal);
  }
  if (id.startsWith("ticketstat:continue:")) {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can edit ticket stats.", flags: MessageFlags.Ephemeral });
    }
    const token = id.split(":")[2];
    const pending = pendingTicketStatEdits.get(token);
    if (!pending || pending.expires_at <= Date.now()) {
      pendingTicketStatEdits.delete(token);
      return interaction.reply({ content: "This ticket-stat edit expired. Run `/ticketstat` again.", flags: MessageFlags.Ephemeral });
    }
    if (pending.admin_id !== interaction.user.id) {
      return interaction.reply({ content: "This ticket-stat edit was opened by another administrator.", flags: MessageFlags.Ephemeral });
    }
    if (!pending.lock_stats) {
      return interaction.reply({ content: "Complete the first ticket-stat form before continuing.", flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(ticketStatEditCommissionModal(token, pending.commission_defaults));
  }
  if (id.startsWith("midman:")) {
    const [, action, midmanId] = id.split(":");
    const midman = data.midman_tickets[midmanId];
    if (!midman || midman.guild_id !== interaction.guildId || midman.channel_id !== interaction.channelId) {
      return interaction.reply({ content: "This midman ticket could not be found.", flags: MessageFlags.Ephemeral });
    }
    if (action === "vouch") {
      if (midman.status !== "success") {
        return interaction.reply({ content: "A vouch can only be submitted after the midman ticket is marked successful.", flags: MessageFlags.Ephemeral });
      }
      if (interaction.user.id !== midman.opened_by_id) {
        return interaction.reply({ content: "Only the person who opened this midman ticket can submit its vouch.", flags: MessageFlags.Ephemeral });
      }
      if (midman.vouch_id) {
        return interaction.reply({ content: "A vouch has already been submitted for this ticket.", flags: MessageFlags.Ephemeral });
      }
      return interaction.showModal(ticketVouchModal("midman", midmanId, midman));
    }
    if (action === "claim") {
      const isMiddleman = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
        || interaction.member?.roles?.cache?.has(config.STAFF_ROLE_ID);
      if (!isMiddleman) {
        return interaction.reply({ content: "Only middleman staff can claim this ticket.", flags: MessageFlags.Ephemeral });
      }
      if (midman.status !== "open") {
        return interaction.reply({ content: "This midman ticket has already been claimed or closed.", flags: MessageFlags.Ephemeral });
      }
      await interaction.deferUpdate();
      const claimed = await mutate(state => {
        const current = state.midman_tickets[midmanId];
        if (!current || !transitionMidman(current, "claimed", "claimed", interaction.user.id)) return false;
        current.claimed_by = interaction.user.id;
        current.claimed_at = new Date().toISOString();
        return true;
      });
      if (!claimed) {
        return interaction.followUp({ content: "This midman ticket was already claimed or closed.", flags: MessageFlags.Ephemeral });
      }
      try {
        await interaction.channel.send({
          embeds: [makeEmbed("Ticket Claimed!",
            `This ticket has been claimed by ${interaction.user}.`,
            0x57f287)],
        });
      } catch (error) {
        console.error(`Midman ticket ${midman.number} was claimed but its announcement failed`, error);
      }
      return interaction.editReply({ components: midmanTicketButtons(midmanId, "claimed") });
    }
    if (action === "success") {
      const isMiddleman = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
        || interaction.member?.roles?.cache?.has(config.STAFF_ROLE_ID);
      if (!isMiddleman) {
        return interaction.reply({ content: "Only middleman staff can mark this ticket successful.", flags: MessageFlags.Ephemeral });
      }
      if (midman.status !== "completed") {
        return interaction.reply({ content: "The buyer must confirm item receipt before this ticket can be marked successful.", flags: MessageFlags.Ephemeral });
      }
      await interaction.deferUpdate();
      const successful = await mutate(state => {
        const current = state.midman_tickets[midmanId];
        if (!current || !transitionMidman(current, "success", "marked_successful", interaction.user.id)) return false;
        current.successful_at = new Date().toISOString();
        return true;
      });
      if (!successful) {
        return interaction.followUp({ content: "This ticket must be completed by the buyer before it can be marked successful.", flags: MessageFlags.Ephemeral });
      }
      try {
        await interaction.channel.send(midmanSuccessMessage(midmanId, midman.opened_by_id));
      } catch (error) {
        await mutate(state => {
          const current = state.midman_tickets[midmanId];
          if (current?.status === "success") {
            current.status = "completed";
            delete current.successful_at;
            recordAuditEvent(current, "success_announcement_failed", interaction.user.id);
          }
        });
        throw error;
      }
      return interaction.editReply({ components: midmanTicketButtons(midmanId, "success") });
    }
    if (action === "paid") {
      if (interaction.user.id !== midman.buyer_id) {
        return interaction.reply({ content: "Only the buyer can confirm that payment was sent.", flags: MessageFlags.Ephemeral });
      }
      if (midman.status !== "claimed") {
        return interaction.reply({ content: "Payment for this midman ticket can no longer be confirmed.", flags: MessageFlags.Ephemeral });
      }
      await interaction.deferUpdate();
      const updated = await mutate(state => {
        const current = state.midman_tickets[midmanId];
        if (!current || !transitionMidman(current, "payment_sent", "buyer_confirmed_payment_sent", interaction.user.id)) return false;
        current.payment_sent_at = new Date().toISOString();
        return true;
      });
      if (!updated) {
        return interaction.followUp({ content: "Payment was already confirmed or the ticket is closed.", flags: MessageFlags.Ephemeral });
      }
      try {
        await interaction.channel.send({
          content: `<@${midman.buyer_id}> confirmed payment was sent.`,
          allowedMentions: { users: [midman.buyer_id] },
        });
      } catch (error) {
        console.error(`Midman ticket ${midman.number} payment was confirmed but the announcement failed`, error);
      }
      return interaction.editReply({ components: [] });
    }
    if (action === "received-confirm") {
      if (interaction.user.id !== midman.buyer_id) {
        return interaction.reply({ content: "Only the buyer can confirm that the item was received.", flags: MessageFlags.Ephemeral });
      }
      if (midman.status !== "payment_received") {
        return interaction.reply({ content: "Item receipt is not available for this ticket.", flags: MessageFlags.Ephemeral });
      }
      await interaction.deferUpdate();
      const updated = await mutate(state => {
        const current = state.midman_tickets[midmanId];
        if (!current || !transitionMidman(current, "completed", "buyer_confirmed_item_received", interaction.user.id)) return false;
        current.completed_at = new Date().toISOString();
        return true;
      });
      if (!updated) {
        return interaction.followUp({ content: "This transaction has already been completed or closed.", flags: MessageFlags.Ephemeral });
      }
      try {
        await interaction.channel.send({
          content: `<@${midman.buyer_id}> confirmed receipt of the item.`,
          allowedMentions: { users: [midman.buyer_id, midman.seller_id] },
        });
      } catch (error) {
        console.error(`Midman ticket ${midman.number} item receipt was confirmed but the announcement failed`, error);
      }
      await interaction.editReply({ components: [] });
      try {
        await updateMidmanControlMessage(midman, "completed");
      } catch (error) {
        console.error(`Could not update midman control message for ticket ${midman.number}`, error);
      }
      return;
    }
    if (action === "close") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
        && !interaction.member?.roles?.cache?.has(config.STAFF_ROLE_ID)) {
        return interaction.reply({ content: "Only middleman staff or administrators can close this ticket.", flags: MessageFlags.Ephemeral });
      }
      await interaction.deferUpdate();
      const staffChannel = await client.channels.fetch(config.STAFF_CHANNEL_ID);
      if (!staffChannel?.isTextBased()) {
        return interaction.followUp({ content: "The staff log channel is unavailable; the midman ticket was not deleted.", flags: MessageFlags.Ephemeral });
      }
      if (staffChannel.id === interaction.channelId) {
        return interaction.followUp({ content: "The staff log channel cannot be the ticket channel; this ticket was not deleted.", flags: MessageFlags.Ephemeral });
      }
      const close = await mutate(state => reserveTicketClose(state, "midman", midmanId, interaction.user.id));
      if (!close.found) return interaction.followUp({ content: "This midman ticket could not be found.", flags: MessageFlags.Ephemeral });
      if (close.closing) return interaction.followUp({ content: "This ticket is already being archived.", flags: MessageFlags.Ephemeral });
      if (close.closed && close.ticket.close_log_message_id) {
        try {
          await interaction.channel.delete(`Midman ticket ${midman.number} closed by ${interaction.user.tag}`);
        } catch (error) {
          console.error(`Midman ticket ${midman.number} is archived but could not be deleted`, error);
          return interaction.followUp({ content: "The ticket is archived, but I could not delete the channel. Please try again.", flags: MessageFlags.Ephemeral });
        }
        return;
      }
      try {
        const transcript = await createTicketTranscript(interaction.channel, "midman", close.ticket, interaction.user);
        const logMessage = await staffChannel.send({
          embeds: [midmanCloseLogEmbed(close.ticket, interaction.user)],
          files: [transcript.file],
          allowedMentions: { parse: [] },
        });
        const finished = await mutate(state => finishTicketClose(state, "midman", midmanId, logMessage.id, interaction.user.id));
        if (!finished) throw new Error(`Could not finalize closure for midman ticket ${midmanId}.`);
      } catch (error) {
        await mutate(state => abortTicketClose(state, "midman", midmanId, interaction.user.id));
        console.error(`Could not archive midman ticket ${midman.number}`, error);
        return interaction.followUp({ content: "The transcript or staff log could not be created; the ticket was left open.", flags: MessageFlags.Ephemeral });
      }
      try {
        await interaction.channel.delete(`Midman ticket ${midman.number} closed by ${interaction.user.tag}`);
      } catch (error) {
        console.error(`Midman ticket ${midman.number} was archived but its channel could not be deleted`, error);
        return interaction.followUp({ content: "The ticket is archived, but I could not delete the channel. Please try again.", flags: MessageFlags.Ephemeral });
      }
      return;
    }
  }
  if (id === "vouch:open") {
    const modal = new ModalBuilder().setCustomId("vouch:submit").setTitle("Submit a vouch")
      .setLabelComponents(
        modalLabel("How many did you buy?", textInput("quantity", "Quantity", TextInputStyle.Short, true, "Enter the quantity")),
        modalLabel("Type", quantityTypeSelect()),
        modalLabel("Payment method", paymentMethodSelect()),
        modalLabel("Note (optional)", textInput("note", "Note", TextInputStyle.Paragraph, false, "Legit seller, fast delivery, etc.")),
      );
    return interaction.showModal(modal);
  }
  if (id === "ticket:open") {
    const modal = new ModalBuilder().setCustomId("ticket:submit").setTitle("Purchase ticket")
      .setLabelComponents(
        modalLabel("Payment method", paymentMethodSelect()),
        modalLabel("Type", quantityTypeSelect()),
        modalLabel("Quantity", textInput("quantity", "Quantity", TextInputStyle.Short, true, "Enter the quantity")),
      );
    return interaction.showModal(modal);
  }
  if (id.startsWith("leaderboard:page:")) {
    const page = Number(id.split(":").at(-1));
    const entries = Object.entries(data.points_tenths).map(([userId, points]) => [userId, Number(points)])
      .filter(([, points]) => points > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const safePage = Math.max(0, Math.min(page, Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1)));
    return interaction.update({ embeds: [leaderboardEmbed(entries, safePage)], components: entries.length > PAGE_SIZE ? leaderboardButtons(safePage, entries.length) : [] });
  }
  if (id.startsWith("vouch-review:") || id.startsWith("redemption-review:")) return reviewAction(interaction);
  if (id.startsWith("ticket:")) return ticketAction(interaction);
}

async function submitVouch(interaction, quantityText, type, payment, note, source = null) {
  if (!validQuantity(quantityText) || !["world_lock", "diamond_lock", "blue_gem_lock"].includes(type)) {
    return interaction.reply({ content: "Enter a valid quantity and select a supported lock type.", flags: MessageFlags.Ephemeral });
  }
  if (!interaction.inGuild()) {
    return interaction.reply({ content: "Vouches can only be submitted in a server.", flags: MessageFlags.Ephemeral });
  }
  if (!Object.hasOwn(PAYMENT_METHOD_LABELS, String(payment).toLowerCase())) {
    return interaction.reply({ content: "Select a supported payment method.", flags: MessageFlags.Ephemeral });
  }
  const id = crypto.randomUUID().replaceAll("-", "");
  const vouch = {
    id,
    buyer_id: interaction.user.id,
    buyer_name: interaction.user.tag,
    avatar_url: interaction.user.displayAvatarURL(),
    quantity: Number(quantityText),
    quantity_type: type,
    quantity_world_locks: worldLocks(Number(quantityText), type),
    payment_method: PAYMENT_METHOD_LABELS[String(payment).toLowerCase()],
    note: note.trim(),
    created_at: new Date().toISOString(),
    status: "pending",
    review_message_id: null,
    public_message_id: null,
    source_kind: source?.kind || null,
    source_ticket_id: source?.kind === "ticket" ? source.id : null,
    sale_rate_snapshot: clone(source?.kind === "ticket"
      ? data.tickets[source.id]?.sale_rate_snapshot
      : data.rates || {}),
    quoted_sale_php_cents: source?.kind === "ticket"
      ? data.tickets[source.id]?.quoted_sale_php_cents
      : calculateTicketPriceCents({ quantity: Number(quantityText), quantity_type: type }, data.rates || {}),
  };
  const stored = await mutate(state => {
    if (source) {
      const sourceTicket = source.kind === "ticket"
        ? state.tickets[source.id]
        : state.midman_tickets[source.id];
      const isMaker = source.kind === "ticket"
        ? sourceTicket?.owner_id === interaction.user.id
        : sourceTicket?.opened_by_id === interaction.user.id;
      if (!sourceTicket || sourceTicket.status !== "success" || !isMaker || sourceTicket.vouch_id) return false;
      if (source.kind === "ticket"
        && (Number(sourceTicket.quantity) !== Number(quantityText) || sourceTicket.quantity_type !== type)) return false;
      sourceTicket.vouch_id = id;
    }
    state.vouches[id] = vouch;
    return true;
  });
  if (!stored) {
    return interaction.reply({ content: "This ticket is no longer eligible for a vouch or already has one.", flags: MessageFlags.Ephemeral });
  }
  try {
    const channel = await client.channels.fetch(config.STAFF_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error("STAFF_CHANNEL_ID is not a text channel.");
    const message = await channel.send({ embeds: [vouchReviewEmbed(vouch)], components: reviewButtons("vouch", id) });
    await mutate(state => {
      if (state.vouches[id]) state.vouches[id].review_message_id = message.id;
    });
    return interaction.reply({ content: "Thanks! Your vouch has been sent to staff for review.", flags: MessageFlags.Ephemeral });
  } catch (error) {
    console.error("Could not queue vouch", error);
    return interaction.reply({ content: "Your vouch could not be queued for staff review. Please contact staff.", flags: MessageFlags.Ephemeral });
  }
}

async function handleModal(interaction) {
  const get = name => interaction.fields.getTextInputValue(name).trim();
  if (interaction.customId === "redeem:submit") {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: "Reward redemptions can only be requested in a server.", flags: MessageFlags.Ephemeral });
    }
    const cost = parseNonNegativeInteger(interaction.fields.getStringSelectValues("reward_cost")[0]);
    const worldName = get("world_name");
    const worldOwner = get("world_owner");
    if (cost === null || cost <= 0 || !worldName || !worldOwner) {
      return interaction.reply({
        content: "Choose an available reward and enter both the world name and its owner.",
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const id = crypto.randomUUID().replaceAll("-", "");
    const request = await mutate(state => {
      const reward = String(state.reward_tiers?.[String(cost)] || "").trim();
      const balance = Number(state.points_tenths[interaction.user.id] || 0);
      if (!reward) return { accepted: false, reason: "unavailable", balance };
      if (!Number.isSafeInteger(balance) || balance < cost * POINT_SCALE) {
        return { accepted: false, reason: "balance", balance };
      }
      const redemption = {
        id,
        buyer_id: interaction.user.id,
        point_cost: cost,
        reward,
        world_name: worldName,
        world_owner: worldOwner,
        created_at: new Date().toISOString(),
        status: "pending",
        staff_message_id: null,
        audit_log: [],
      };
      recordAuditEvent(redemption, "requested", interaction.user.id, {
        point_cost: cost,
        world_name: worldName,
        world_owner: worldOwner,
      });
      state.redemptions[id] = redemption;
      return { accepted: true, balance, redemption: clone(redemption) };
    });
    if (!request.accepted) {
      return interaction.editReply(request.reason === "balance"
        ? `You no longer have enough points for that reward. Current balance: ${formatPoints(request.balance)} points.`
        : "That reward tier is no longer available. Run `/redeem` again to see current options.");
    }

    try {
      const channel = await client.channels.fetch(config.STAFF_CHANNEL_ID);
      if (!channel?.isTextBased()) throw new Error("STAFF_CHANNEL_ID is not a text channel.");
      const message = await channel.send({
        content: `<@${interaction.user.id}>`,
        allowedMentions: { users: [interaction.user.id] },
        embeds: [redemptionEmbed(request.redemption)],
        components: reviewButtons("redemption", id),
      });
      const saved = await mutate(state => {
        const current = state.redemptions[id];
        if (!current || current.status !== "pending") return false;
        current.staff_message_id = message.id;
        return true;
      });
      if (!saved) throw new Error(`Redemption ${id} is no longer pending.`);
      return interaction.editReply({
        content: `Your request for **${request.redemption.reward}** has been sent to staff for approval. Points are deducted only if approved.`,
      });
    } catch (error) {
      console.error(`Could not notify staff about redemption ${id}`, error);
      return interaction.editReply("Your redemption request was saved, but staff could not be notified. Contact staff before submitting another request.");
    }
  }
  if (interaction.customId === "sales:submit") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can record sales.", flags: MessageFlags.Ephemeral });
    }
    const buyerName = get("buyer_name");
    const quantityText = get("quantity");
    const quantityType = interaction.fields.getStringSelectValues("quantity_type")[0];
    if (!buyerName || !validQuantity(quantityText)
      || !["world_lock", "diamond_lock", "blue_gem_lock"].includes(quantityType)) {
      return interaction.reply({ content: "Enter a buyer name, a positive whole-number quantity, and a lock type.", flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let staffChannel;
    try {
      staffChannel = await client.channels.fetch(config.STAFF_CHANNEL_ID);
    } catch (error) {
      console.error("Could not fetch the staff channel before recording a manual sale", error);
      return interaction.editReply("The staff log channel is unavailable; the sale was not recorded.");
    }
    if (!staffChannel?.isTextBased() || typeof staffChannel.send !== "function") {
      return interaction.editReply("The staff log channel is unavailable; the sale was not recorded.");
    }

    const saleId = `manual:${interaction.id}`;
    const result = await mutate(state => {
      const rateSnapshot = clone(state.rates);
      const revenue = calculateTicketPriceCents({ quantity: Number(quantityText), quantity_type: quantityType }, rateSnapshot);
      if (revenue === null) return { ok: false, reason: "rates_not_configured" };
      return recordSaleInState(state, {
        id: saleId,
        source: "manual",
        buyer_name: buyerName,
        quantity: Number(quantityText),
        quantity_type: quantityType,
        revenue_php_cents: revenue,
        commission_php_cents: 0,
        rate_snapshot: rateSnapshot,
        completed_by: interaction.user.id,
      });
    });
    if (!result.ok) {
      return interaction.editReply(result.reason === "rates_not_configured"
        ? "The selected lock's selling rate is not configured. Update it with `/changerate`."
        : inventoryFailureMessage(result.reason));
    }

    const logEmbed = makeEmbed("Manual Sale Recorded", null, 0x57f287)
      .addFields(
        { name: "Buyer", value: buyerName.slice(0, 100), inline: true },
        { name: "Quantity", value: formatQuantity(Number(quantityText), quantityType), inline: true },
        { name: "Sale total", value: `₱ ${formatPhpCents(result.entry.revenue_php_cents)}`, inline: true },
        { name: "Cost of goods sold", value: `₱ ${formatPhpCents(result.entry.cogs_php_cents)}`, inline: true },
        { name: "Recorded by", value: `<@${interaction.user.id}>`, inline: true },
        { name: "Remaining stock", value: formatNormalizedWorldLocks(result.stock, 0, "world_lock"), inline: true },
      )
      .setFooter({ text: `Ledger ID: ${saleId}` })
      .setTimestamp();
    try {
      await staffChannel.send({ embeds: [logEmbed], allowedMentions: { parse: [] } });
    } catch (error) {
      console.error(`Sale ${saleId} was recorded but its staff log could not be sent`, error);
      return interaction.editReply(`Sale recorded (${saleId}), but its staff log could not be sent. Do not retry this sale; contact an administrator.`);
    }

    await sendCounter(interaction.guild, "COUNTER_VOICE_CHANNEL_ID", `📦 Total Sold: ${result.total_sold}`)
      .catch(error => console.error("Sale was logged but the total-sold counter could not be updated", error));
    await sendCounter(interaction.guild, "TOTAL_STOCK_VOICE_CHANNEL_ID", `📦 Total Stock: ${result.stock}`)
      .catch(error => console.error("Sale was logged but the stock counter could not be updated", error));
    return interaction.editReply(`Sale recorded and logged to staff. Total sold: ${result.total_sold} WL equivalent.`);
  }
  if (interaction.customId.startsWith("stock:update:")) {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "You need the Manage Server permission to update inventory.", flags: MessageFlags.Ephemeral });
    }
    const action = interaction.customId.split(":")[2];
    if (!["restock", "set", "remove"].includes(action)) {
      return interaction.reply({ content: "Invalid inventory operation.", flags: MessageFlags.Ephemeral });
    }
    const quantities = {
      world_lock: parseNonNegativeInteger(get("world_lock")),
      diamond_lock: parseNonNegativeInteger(get("diamond_lock")),
      blue_gem_lock: parseNonNegativeInteger(get("blue_gem_lock")),
    };
    if (Object.values(quantities).some(value => value === null)) {
      return interaction.reply({ content: "Enter non-negative whole-number quantities for all lock types.", flags: MessageFlags.Ephemeral });
    }
    const purchaseCostCents = action === "remove" ? 0 : parsePhpCents(get("purchase_cost"), true);
    if (purchaseCostCents === null) {
      return interaction.reply({ content: "Enter a valid non-negative PHP cost with up to two decimal places.", flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await mutate(state => adjustInventory(
      state,
      action,
      quantities,
      purchaseCostCents,
      interaction.user.id,
      action === "remove" ? get("reason") : "",
    ));
    if (!result.ok) return interaction.editReply(inventoryFailureMessage(result.reason));
    let notice = "";
    try {
      await sendCounter(interaction.guild, "TOTAL_STOCK_VOICE_CHANNEL_ID", `📦 Total Stock: ${result.stock}`);
    } catch (error) {
      console.error("Inventory was saved but the stock voice counter could not be updated", error);
      notice += " The stock voice counter could not be updated.";
    }
    const actionLabel = action === "restock" ? "Restocked" : action === "set" ? "Inventory reconciled to" : "Inventory removed; remaining stock";
    return interaction.editReply(
      `${actionLabel} ${formatNormalizedWorldLocks(result.stock, 0, "world_lock")}. `
      + `Remaining cost basis: ₱ ${formatPhpCents(result.cost_basis)}.${notice}`,
    );
  }
  if (interaction.customId.startsWith("midman:submit:")) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: "Midman tickets can only be opened in a server.", flags: MessageFlags.Ephemeral });
    }
    const makerRole = interaction.customId.split(":")[2];
    if (!["selling", "buying"].includes(makerRole)) {
      return interaction.reply({ content: "Invalid midman ticket type.", flags: MessageFlags.Ephemeral });
    }
    const oppositeInput = get("opposite_user");
    const quantityText = get("quantity");
    const quantityType = interaction.fields.getStringSelectValues("midman_quantity_type")[0];
    const amountText = get("transaction_amount");
    const feePayer = interaction.fields.getStringSelectValues("fee_payer")[0];
    if (!validQuantity(quantityText) || !["world_lock", "diamond_lock", "blue_gem_lock"].includes(quantityType)) {
      return interaction.reply({ content: "Enter a valid quantity and select World Lock, Diamond Lock, or Blue Gem Lock.", flags: MessageFlags.Ephemeral });
    }
    const transactionPhpCents = parsePhpCents(amountText);
    if (transactionPhpCents === null) {
      return interaction.reply({ content: "Enter a valid PHP transaction amount with up to two decimal places.", flags: MessageFlags.Ephemeral });
    }
    if (!["buyer", "seller"].includes(feePayer)) {
      return interaction.reply({ content: "Choose who pays the middleman fee.", flags: MessageFlags.Ephemeral });
    }
    const opposite = await resolveGuildMember(interaction.guild, oppositeInput);
    if (!opposite) {
      return interaction.reply({ content: "Enter a valid Discord User ID for a member of this server.", flags: MessageFlags.Ephemeral });
    }
    if (opposite.id === interaction.user.id) {
      return interaction.reply({ content: "You cannot open a midman ticket with yourself.", flags: MessageFlags.Ephemeral });
    }
    const staffRole = config.STAFF_ROLE_ID && await interaction.guild.roles.fetch(config.STAFF_ROLE_ID);
    if (!staffRole) {
      return interaction.reply({ content: "Midman tickets are unavailable: configure a valid STAFF_ROLE_ID.", flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let channel;
    const buyerId = makerRole === "buying" ? interaction.user.id : opposite.id;
    const sellerId = makerRole === "selling" ? interaction.user.id : opposite.id;
    const transactionPesos = transactionPhpCents / 100;
    const feePhpCents = calculateMidmanFeeCents(transactionPesos);
    const id = crypto.randomUUID().replaceAll("-", "");
    const draft = {
      id,
      guild_id: interaction.guild.id,
      channel_id: null,
      message_id: null,
      buyer_id: buyerId,
      seller_id: sellerId,
      opened_by_id: interaction.user.id,
      opened_as: makerRole,
      opposite_user_id: opposite.id,
      quantity: Number(quantityText),
      quantity_type: quantityType,
      transaction_php_cents: transactionPhpCents,
      fee_payer: feePayer,
      fee_php_cents: feePhpCents,
    };
    let reserved;
    try {
      reserved = await mutate(state => reserveNewTicket(state, "midman", draft));
      if (!reserved.created) return interaction.editReply(activeTicketNotice(reserved.existing));
      const midman = reserved.ticket;
      channel = await interaction.guild.channels.create({
        name: `midman-${midman.number}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: buyerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: sellerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
          { id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
        ],
        reason: `Midman ticket opened by ${interaction.user.tag}`,
      });
      await mutate(state => {
        const current = state.midman_tickets[id];
        if (!current || current.status !== "creating") throw new Error(`Midman reservation ${id} is no longer active.`);
        current.channel_id = channel.id;
        current.status = "open";
        recordAuditEvent(current, "channel_created", interaction.user.id);
      });
      const message = await channel.send({
        content: `<@${buyerId}> <@${sellerId}> <@&${staffRole.id}>`,
        allowedMentions: { users: [buyerId, sellerId], roles: [staffRole.id] },
        embeds: [makeEmbed("Midman Ticket",
          `**Buyer:** <@${buyerId}>\n**Seller:** <@${sellerId}>\n`
          + `**Quantity:** ${formatNormalizedLockQuantity(midman.quantity, midman.quantity_type)}\n**Transaction:** ₱ ${formatPhpCents(transactionPhpCents)}\n`
          + `**Middleman fee:** ₱ ${formatPhpCents(feePhpCents)}\n**Fee paid by:** ${feePayer === "buyer" ? "Buyer" : "Seller"}`,
          0x5865f2)],
        components: midmanTicketButtons(id, "open"),
      });
      await mutate(state => {
        const current = state.midman_tickets[id];
        if (current) current.message_id = message.id;
      });
      return interaction.editReply(`Your midman ticket is ready: ${channel}`);
    } catch (error) {
      console.error("Could not create midman ticket", error);
      if (channel) await channel.delete("Midman ticket setup did not complete").catch(deleteError => console.error("Could not remove incomplete midman channel", deleteError));
      if (reserved?.created) {
        await mutate(state => {
          const current = state.midman_tickets[id];
          if (current && ["creating", "open"].includes(current.status)) {
            current.status = "failed";
            recordAuditEvent(current, "creation_failed", interaction.user.id);
          }
        });
      }
      return interaction.editReply("Your midman ticket could not be created. Please contact an administrator.");
    }
  }
  if (interaction.customId.startsWith("ticketstat:")) {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can edit ticket stats.", flags: MessageFlags.Ephemeral });
    }
    const [prefix, step, token] = interaction.customId.split(":");
    const pending = pendingTicketStatEdits.get(token);
    if (!pending || pending.expires_at <= Date.now()) {
      pendingTicketStatEdits.delete(token);
      return interaction.reply({ content: "This ticket-stat edit expired. Run `/ticketstat` again.", flags: MessageFlags.Ephemeral });
    }
    if (pending.admin_id !== interaction.user.id) {
      return interaction.reply({ content: "This ticket-stat edit was opened by another administrator.", flags: MessageFlags.Ephemeral });
    }
    if (prefix !== "ticketstat") {
      return interaction.reply({ content: "Invalid ticket-stat edit step.", flags: MessageFlags.Ephemeral });
    }
    if (step === "locks") {
      const lockStats = {
        claims: parseNonNegativeInteger(get("claims")),
        blue_gem_locks: parseNonNegativeInteger(get("blue_gem_locks")),
        diamond_locks: parseNonNegativeInteger(get("diamond_locks")),
        world_locks: parseNonNegativeInteger(get("world_locks")),
      };
      if (Object.values(lockStats).some(value => value === null)) {
        return interaction.reply({ content: "Claims and lock amounts must be whole non-negative numbers.", flags: MessageFlags.Ephemeral });
      }
      pending.lock_stats = lockStats;
      pending.expires_at = Date.now() + 15 * 60 * 1000;
      return interaction.reply({
        content: "Lock stats saved for this edit. Continue to the commission fields.",
        components: [new ActionRowBuilder().addComponents(
          makeButton("Continue", ButtonStyle.Primary, `ticketstat:continue:${token}`),
        )],
        flags: MessageFlags.Ephemeral,
      });
    }
    if (step === "commission") {
      if (!pending.lock_stats) {
        return interaction.reply({ content: "Complete the first ticket-stat form before submitting commission values.", flags: MessageFlags.Ephemeral });
      }
      const commissionDiamondLocks = parseNonNegativeInteger(get("commission_diamond_locks"));
      const commissionPhpCents = parsePhpCents(get("commission_php"), true);
      if (commissionDiamondLocks === null || commissionPhpCents === null) {
        return interaction.reply({
          content: "Commission DLs must be a whole non-negative number, and commission PHP must be a non-negative amount with up to two decimals.",
          flags: MessageFlags.Ephemeral,
        });
      }
      const updated = await mutate(state => {
        const activeClaim = Object.values(state.commission_claims || {})
          .some(claim => claim.member_id === pending.target_id && claim.status === "logging");
        if (activeClaim) return false;
        const current = state.ticket_stats[pending.target_id] || {};
        if (Number(current.commission_diamond_locks || 0) !== Number(pending.commission_defaults.commission_diamond_locks || 0)
          || Number(current.commission_php_cents || 0) !== Number(pending.commission_defaults.commission_php_cents || 0)) {
          return false;
        }
        state.ticket_stats[pending.target_id] = {
          ...pending.lock_stats,
          commission_diamond_locks: commissionDiamondLocks,
          commission_php_cents: commissionPhpCents,
        };
        return true;
      });
      pendingTicketStatEdits.delete(token);
      if (!updated) {
        return interaction.reply({
          content: "Commission stats changed while this form was open. Run `/ticketstat` again to review the current values.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        content: `Ticket stats updated for <@${pending.target_id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({ content: "Invalid ticket-stat edit step.", flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === "rates:change") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can change rates.", flags: MessageFlags.Ephemeral });
    }
    const diamondLockRate = parsePhpCents(get("diamond_lock_rate"));
    const worldLockRate = parsePhpCents(get("world_lock_rate"));
    const blueGemLockRate = parsePhpCents(get("blue_gem_lock_rate"));
    const staffCommissionRate = parsePhpCents(get("staff_commission_rate"), true);
    if (diamondLockRate === null || worldLockRate === null || blueGemLockRate === null || staffCommissionRate === null) {
      return interaction.reply({
        content: "Enter valid PHP amounts with up to two decimal places. BGL, DL, and WL rates must be greater than zero; commission may be zero. BGL is an independent selling price.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await mutate(state => {
      state.rates = {
        diamond_lock_php_cents: diamondLockRate,
        world_lock_php_cents: worldLockRate,
        blue_gem_lock_php_cents: blueGemLockRate,
        staff_commission_per_diamond_lock_php_cents: staffCommissionRate,
      };
    });

    let response = `Rates saved: BGL ₱ ${formatPhpCents(blueGemLockRate)}, DL ₱ ${formatPhpCents(diamondLockRate)}, WL ₱ ${formatPhpCents(worldLockRate)}, staff commission ₱ ${formatPhpCents(staffCommissionRate)} per whole DL.`;
    try {
      await updateRateVoiceChannel(interaction.guild, diamondLockRate);
      response += ` Voice rate updated to ₱ ${formatPhpCents(diamondLockRate)}.`;
    } catch (error) {
      console.error("Rates were saved but the rate voice channel could not be updated", error);
      response += ` Rates were saved, but the voice channel was not updated: ${error.message}`;
    }
    return interaction.reply({ content: response, flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId.startsWith("payment:set:")) {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can set payment details.", flags: MessageFlags.Ephemeral });
    }
    const method = interaction.customId.split(":")[2];
    if (!Object.hasOwn(PAYMENT_METHOD_LABELS, method)) {
      return interaction.reply({ content: "Invalid payment method.", flags: MessageFlags.Ephemeral });
    }
    const details = get("details");
    if (!details) {
      return interaction.reply({ content: "Payment details cannot be empty.", flags: MessageFlags.Ephemeral });
    }
    await mutate(state => {
      state.payment_details = state.payment_details || {};
      state.payment_details[method] = details.slice(0, 4000);
    });
    return interaction.reply({
      content: `${PAYMENT_METHOD_LABELS[method]} payment details saved.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (interaction.customId === "rewards:change") {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only server administrators can change rewards.", flags: MessageFlags.Ephemeral });
    }
    const tiers = {};
    for (const line of get("tiers").split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const costText = line.slice(0, separator).trim();
      const reward = line.slice(separator + 1).trim();
      if (!/^[1-9][0-9]{0,8}$/.test(costText) || !reward) continue;
      tiers[costText] = reward.slice(0, 500);
    }
    if (Object.keys(tiers).length === 0) {
      return interaction.reply({
        content: "No valid reward tiers found. Use one line per tier, for example: `50=10 World Locks`.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (Object.keys(tiers).length > 25) {
      return interaction.reply({
        content: "A maximum of 25 reward tiers can be configured so they fit in the redemption selector.",
        flags: MessageFlags.Ephemeral,
      });
    }
    await mutate(state => {
      state.reward_tiers = tiers;
    });
    const description = [...getRewardTiers()]
      .map(([cost, reward]) => `**${cost} coins** = ${reward}`)
      .join("\n");
    return interaction.reply({
      embeds: [makeEmbed("Rewards Updated", description, 0x57f287)],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (interaction.customId.startsWith("ticketvouch:submit:")) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: "Vouches can only be submitted in a server.", flags: MessageFlags.Ephemeral });
    }
    const [, , kind, id] = interaction.customId.split(":");
    if (!["ticket", "midman"].includes(kind)) {
      return interaction.reply({ content: "Invalid ticket vouch request.", flags: MessageFlags.Ephemeral });
    }
    const sourceTicket = kind === "ticket" ? data.tickets[id] : data.midman_tickets[id];
    const isMaker = kind === "ticket"
      ? sourceTicket?.owner_id === interaction.user.id
      : sourceTicket?.opened_by_id === interaction.user.id;
    if (!sourceTicket || sourceTicket.status !== "success" || !isMaker || sourceTicket.vouch_id) {
      return interaction.reply({ content: "This ticket is no longer eligible for a vouch or already has one.", flags: MessageFlags.Ephemeral });
    }
    return submitVouch(
      interaction,
      get("quantity"),
      interaction.fields.getStringSelectValues("quantity_type")[0],
      interaction.fields.getStringSelectValues("payment_method")[0],
      interaction.fields.getTextInputValue("note"),
      { kind, id },
    );
  }
  if (interaction.customId === "vouch:submit") {
    const quantityText = get("quantity");
    const type = interaction.fields.getStringSelectValues("quantity_type")[0];
    const payment = interaction.fields.getStringSelectValues("payment_method")[0];
    return submitVouch(interaction, quantityText, type, payment, interaction.fields.getTextInputValue("note"));
  }
  if (interaction.customId === "ticket:submit") {
    return createTicket(
      interaction,
      get,
      interaction.fields.getStringSelectValues("quantity_type")[0],
      interaction.fields.getStringSelectValues("payment_method")[0],
    );
  }
}

async function isReviewer(interaction) {
  if (!interaction.inGuild()) return false;
  const memberRoles = interaction.member?.roles;
  if (memberRoles?.cache) return memberRoles.cache.has(config.REVIEWER_ROLE_ID);
  if (Array.isArray(memberRoles)) return memberRoles.includes(config.REVIEWER_ROLE_ID);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return member.roles.cache.has(config.REVIEWER_ROLE_ID);
}

async function reviewAction(interaction) {
  if (!await isReviewer(interaction)) {
    return interaction.reply({ content: "You do not have the staff role required to review requests.", flags: MessageFlags.Ephemeral });
  }
  const [prefix, action, id] = interaction.customId.split(":");
  if (prefix === "vouch-review") {
    const vouch = data.vouches[id];
    if (!vouch || vouch.status !== "pending") return interaction.reply({ content: "This vouch has already been reviewed.", flags: MessageFlags.Ephemeral });
    if (action === "reject") {
      const rejected = await mutate(state => {
        const current = state.vouches[id];
        if (!current || current.status !== "pending") return false;
        current.status = "rejected";
        recordAuditEvent(current, "rejected", interaction.user.id);
        return true;
      });
      if (!rejected) return interaction.reply({ content: "This vouch has already been reviewed.", flags: MessageFlags.Ephemeral });
      await interaction.update({ components: [] });
      return interaction.followUp({ content: "Vouch rejected.", flags: MessageFlags.Ephemeral });
    }
    const quantity = vouchWorldLocks(vouch);
    if (quantity === null) {
      return interaction.reply({ content: "This vouch has an invalid quantity. Contact an administrator.", flags: MessageFlags.Ephemeral });
    }
    const channelId = config.PUBLIC_VOUCH_CHANNEL_ID;
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return interaction.reply({ content: "The public vouch channel is not configured correctly.", flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const claimed = await mutate(state => {
      const current = state.vouches[id];
      if (!current || current.status !== "pending") return false;
      current.status = "approving";
      recordAuditEvent(current, "approval_started", interaction.user.id);
      return true;
    });
    if (!claimed) return interaction.editReply("This vouch has already been reviewed.");
    let message;
    let finalized = false;
    let completion;
    try {
      message = await channel.send({ embeds: [publicVouchEmbed(vouch)] });
      completion = await mutate(state => {
        const current = state.vouches[id];
        if (!current || current.status !== "approving") return { ok: false, reason: "already reviewed" };
        const currentQuantity = vouchWorldLocks(current);
        if (currentQuantity === null) {
          current.status = "pending";
          recordAuditEvent(current, "approval_blocked_invalid_quantity", interaction.user.id);
          return { ok: false, reason: "invalid_quantity" };
        }
        const count = Number(state.vouch_count) + 1;
        if (!Number.isSafeInteger(count)) {
          throw new Error(`Vouch ${id} would exceed the safe sales counters.`);
        }
        let sale = null;
        let saleId = null;
        if (current.source_kind === "ticket") {
          const sourceTicket = state.tickets[current.source_ticket_id];
          const ticketSaleId = `ticket:${current.source_ticket_id}`;
          if (!sourceTicket || sourceTicket.status !== "success") {
            current.status = "pending";
            recordAuditEvent(current, "approval_blocked_missing_ticket", interaction.user.id);
            return { ok: false, reason: "missing_ticket" };
          }
          if (!state.sales_ledger[ticketSaleId]) {
            current.status = "pending";
            recordAuditEvent(current, "approval_blocked_missing_ticket_sale", interaction.user.id);
            return { ok: false, reason: "missing_ticket_sale" };
          }
          saleId = ticketSaleId;
        } else if (current.source_kind === "midman") {
          if (!state.midman_tickets[current.source_ticket_id]
            || state.midman_tickets[current.source_ticket_id].status !== "success") {
            current.status = "pending";
            recordAuditEvent(current, "approval_blocked_missing_midman_ticket", interaction.user.id);
            return { ok: false, reason: "missing_ticket" };
          }
        } else if (Object.hasOwn(current, "source_kind")) {
          const rateSnapshot = clone(current.sale_rate_snapshot || state.rates || {});
          const revenue = Number.isSafeInteger(current.quoted_sale_php_cents)
            ? current.quoted_sale_php_cents
            : calculateTicketPriceCents(current, rateSnapshot);
          if (!Number.isSafeInteger(revenue)) {
            current.status = "pending";
            recordAuditEvent(current, "approval_blocked_missing_rate", interaction.user.id);
            return { ok: false, reason: "rates_not_configured" };
          }
          sale = recordSaleInState(state, {
            id: `vouch:${id}`,
            source: "vouch",
            source_id: id,
            buyer_id: current.buyer_id,
            buyer_name: current.buyer_name,
            payment_method: current.payment_method,
            quantity: current.quantity,
            quantity_type: current.quantity_type,
            revenue_php_cents: revenue,
            commission_php_cents: 0,
            rate_snapshot: rateSnapshot,
            completed_by: interaction.user.id,
          });
          if (!sale.ok) {
            current.status = "pending";
            recordAuditEvent(current, "approval_blocked_inventory", interaction.user.id, { reason: sale.reason });
            return { ok: false, reason: sale.reason };
          }
          saleId = sale.entry.id;
        }
        const points = updatePointsBalance(state, current.buyer_id, currentQuantity);
        if (points === null) throw new Error(`Could not safely update points for vouch ${id}.`);
        state.vouch_count = count;
        current.status = "approved";
        current.public_message_id = message.id;
        recordAuditEvent(current, "approved", interaction.user.id, {
          quantity_world_locks: currentQuantity,
          sale_id: saleId,
        });
        return {
          ok: true,
          count,
          total_sold: Number(state.total_sold),
          total_stock: Number(state.total_stock),
          points,
          earned: currentQuantity,
        };
      });
      if (!completion.ok) {
        await message.delete().catch(error => console.error(`Could not remove blocked vouch ${id} from public channel`, error));
        if (completion.reason === "rates_not_configured") {
          return interaction.editReply("The sale rate for this vouch is not configured. Update it with `/changerate` and retry.");
        }
        if (completion.reason === "missing_ticket_sale") {
          return interaction.editReply("This linked ticket has no accounting entry. Contact an administrator; do not approve it as a new sale.");
        }
        if (completion.reason !== "already reviewed") {
          return interaction.editReply(inventoryFailureMessage(completion.reason));
        }
        return interaction.editReply("This vouch has already been reviewed.");
      }
      finalized = true;
      try {
        await message.edit({ embeds: [publicVouchEmbed(vouch, completion)] });
      } catch (error) {
        console.error(`Vouch ${id} was approved but its public embed could not be finalized`, error);
      }
      try {
        const guild = interaction.guild;
        const [buyer, role] = await Promise.all([
          guild.members.fetch(vouch.buyer_id),
          guild.roles.fetch(config.VOUCH_ROLE_ID),
        ]);
        if (role && !buyer.roles.cache.has(role.id)) await buyer.roles.add(role, "Vouch approved");
      } catch (error) { console.error("Could not assign approved-vouch role", error); }
      await interaction.editReply(`Vouch approved and posted. Buyer earned ${formatPoints(completion.earned)} coins.`);
      await interaction.message.edit({ components: [] });
      const guild = interaction.guild;
      if (guild) {
        await sendCounter(guild, "COUNTER_VOICE_CHANNEL_ID", `📦 Total Sold: ${completion.total_sold}`).catch(error => console.error("Could not update sales counter", error));
        await sendCounter(guild, "TOTAL_VOUCH_VOICE_CHANNEL_ID", `⭐ Total Vouch: ${completion.count}`).catch(error => console.error("Could not update vouch counter", error));
        await sendCounter(guild, "TOTAL_STOCK_VOICE_CHANNEL_ID", `📦 Total Stock: ${completion.total_stock}`).catch(error => console.error("Could not update stock counter", error));
      }
    } catch (error) {
      console.error("Could not approve vouch", error);
      if (!finalized) {
        if (message) await message.delete().catch(deleteError => console.error(`Could not remove failed vouch ${id} from public channel`, deleteError));
        await mutate(state => {
          const current = state.vouches[id];
          if (current?.status === "approving") {
            current.status = "pending";
            recordAuditEvent(current, "approval_failed", interaction.user.id);
          }
        });
        return interaction.editReply("The vouch could not be posted. Please try again or contact an administrator.");
      }
      return interaction.editReply("Vouch approval and stock/points were saved, but a follow-up action failed. Check bot logs.");
    }
    return;
  }
  const redemption = data.redemptions[id];
  if (!redemption || redemption.status !== "pending") return interaction.reply({ content: "This redemption has already been reviewed.", flags: MessageFlags.Ephemeral });
  if (action === "reject") {
    await interaction.deferUpdate();
    const rejected = await mutate(state => {
      const current = state.redemptions[id];
      if (!current || current.status !== "pending") return false;
      current.status = "rejected";
      recordAuditEvent(current, "rejected", interaction.user.id);
      return true;
    });
    if (!rejected) return interaction.followUp({ content: "This redemption has already been reviewed.", flags: MessageFlags.Ephemeral });
    await interaction.message.edit({ embeds: [redemptionEmbed({ ...redemption, status: "rejected" })], components: [] });
    return interaction.followUp({ content: "Redemption rejected; no points were deducted.", flags: MessageFlags.Ephemeral });
  }
  await interaction.deferUpdate();
  const approval = await mutate(state => {
    const current = state.redemptions[id];
    if (!current || current.status !== "pending") return { approved: false, reason: "reviewed" };
    const updatedBalance = updatePointsBalance(
      state,
      current.buyer_id,
      -Number(current.point_cost) * POINT_SCALE,
    );
    if (updatedBalance === null) return { approved: false, reason: "balance" };
    current.status = "approved";
    current.approved_at = new Date().toISOString();
    current.approved_by = interaction.user.id;
    recordAuditEvent(current, "approved", interaction.user.id, { points_balance: updatedBalance });
    return { approved: true, balance: updatedBalance };
  });
  if (!approval.approved) {
    return interaction.followUp({
      content: approval.reason === "balance"
        ? "This player no longer has enough points to approve the redemption."
        : "This redemption has already been reviewed.",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.message.edit({ embeds: [redemptionEmbed({ ...redemption, status: "approved" })], components: [] });
  try {
    const user = await client.users.fetch(redemption.buyer_id);
    await user.send(
      `Your reward redemption for ${redemption.reward} was approved. `
      + `World: ${redemption.world_name || "Not provided"}; owner: ${redemption.world_owner || "Not provided"}. `
      + "Staff will deliver your reward.",
    );
  } catch (error) { console.error("Could not DM redemption approval", error); }
  return interaction.followUp({ content: `Redemption approved; deduct ${redemption.point_cost} points and deliver ${redemption.reward}.`, flags: MessageFlags.Ephemeral });
}

async function createTicket(interaction, get, type, payment) {
  if (!interaction.inGuild()) return interaction.reply({ content: "Purchase tickets can only be opened in a server.", flags: MessageFlags.Ephemeral });
  const quantityText = get("quantity");
  if (!validQuantity(quantityText) || !["world_lock", "diamond_lock", "blue_gem_lock"].includes(type)) {
    return interaction.reply({ content: "Enter a valid quantity and select a supported lock type.", flags: MessageFlags.Ephemeral });
  }
  const guild = interaction.guild;
  const staffRole = config.STAFF_ROLE_ID && await guild.roles.fetch(config.STAFF_ROLE_ID);
  if (!staffRole) return interaction.reply({ content: "Purchase tickets are unavailable: configure a valid STAFF_ROLE_ID.", flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let channel;
  const id = crypto.randomUUID().replaceAll("-", "");
  const draft = {
    id,
    guild_id: guild.id,
    channel_id: null,
    message_id: null,
    owner_id: interaction.user.id,
    payment_method: payment,
    quantity: Number(quantityText),
    quantity_type: type,
  };
  let reserved;
  try {
    reserved = await mutate(state => reserveNewTicket(state, "purchase", draft));
    if (!reserved.created) return interaction.editReply(activeTicketNotice(reserved.existing));
    const ticket = reserved.ticket;
    channel = await guild.channels.create({
      name: `ticket-${ticket.number}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
        { id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
      reason: `Purchase ticket opened by ${interaction.user.tag}`,
    });
    await mutate(state => {
      const current = state.tickets[id];
      if (!current || current.status !== "creating") throw new Error(`Ticket reservation ${id} is no longer active.`);
      current.channel_id = channel.id;
      current.status = "open";
      recordAuditEvent(current, "channel_created", interaction.user.id);
    });
    const embed = makeEmbed("Ticket Opened",
      `<@${ticket.owner_id}> has created a new **🎫Purchase** ticket\n**Payment method**\n\`${payment}\`\n**Quantity**\n${formatNormalizedLockQuantity(ticket.quantity, type)}`);
    const message = await channel.send({
      content: `<@${ticket.owner_id}> <@&${staffRole.id}>`,
      allowedMentions: { users: [ticket.owner_id], roles: [staffRole.id] },
      embeds: [embed], components: ticketButtons(id, "open"),
    });
    await mutate(state => {
      const current = state.tickets[id];
      if (current) current.message_id = message.id;
    });
    return interaction.editReply(`Your purchase ticket is ready: ${channel}.`);
  } catch (error) {
    console.error("Could not create purchase ticket", error);
    if (channel) await channel.delete("Ticket setup did not complete").catch(deleteError => console.error("Could not remove incomplete ticket channel", deleteError));
    if (reserved?.created) {
      await mutate(state => {
        const current = state.tickets[id];
        if (current && ["creating", "open"].includes(current.status)) {
          current.status = "failed";
          recordAuditEvent(current, "creation_failed", interaction.user.id);
        }
      });
    }
    return interaction.editReply("Your ticket could not be created. Please contact an administrator.");
  }
}

function paymentSentButton(ticketId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    makeButton("Mark as sent", ButtonStyle.Success, `ticket:paid:${ticketId}`, "✅").setDisabled(disabled),
  )];
}

function ticketButtons(id, status) {
  return [new ActionRowBuilder().addComponents(
    makeButton("Claim Ticket", ButtonStyle.Primary, `ticket:claim:${id}`, "📜").setDisabled(status !== "open"),
    makeButton("Success", ButtonStyle.Success, `ticket:success:${id}`, "✅").setDisabled(status !== "claimed"),
    makeButton("Close", ButtonStyle.Danger, `ticket:close:${id}`, "🔒"),
  )];
}

async function ticketAction(interaction) {
  const [, action, id] = interaction.customId.split(":");
  const ticket = data.tickets[id];
  if (!ticket || ticket.guild_id !== interaction.guildId || ticket.channel_id !== interaction.channelId) {
    return interaction.reply({ content: "This ticket could not be found.", flags: MessageFlags.Ephemeral });
  }
  if (action === "vouch") {
    if (ticket.status !== "success") {
      return interaction.reply({ content: "A vouch can only be submitted after the ticket is marked successful.", flags: MessageFlags.Ephemeral });
    }
    if (interaction.user.id !== ticket.owner_id) {
      return interaction.reply({ content: "Only the ticket owner can submit its vouch.", flags: MessageFlags.Ephemeral });
    }
    if (ticket.vouch_id) {
      return interaction.reply({ content: "A vouch has already been submitted for this ticket.", flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(ticketVouchModal("ticket", id, ticket));
  }
  if (action === "paid") {
    if (interaction.user.id !== String(ticket.owner_id)) {
      return interaction.reply({ content: "Only the ticket owner can mark their payment as sent.", flags: MessageFlags.Ephemeral });
    }
    if (ticket.status !== "claimed" || !ticket.claimed_by) {
      return interaction.reply({ content: "A staff member must claim this ticket before you can mark payment as sent.", flags: MessageFlags.Ephemeral });
    }
    if (ticket.payment_sent) {
      return interaction.reply({ content: "You have already marked this payment as sent.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();
    const marked = await mutate(state => {
      const current = state.tickets[id];
      if (!current || current.status !== "claimed" || !current.claimed_by || current.payment_sent) return false;
      current.payment_sent = true;
      current.payment_sent_at = new Date().toISOString();
      recordAuditEvent(current, "buyer_confirmed_payment_sent", interaction.user.id);
      return true;
    });
    if (!marked) {
      return interaction.followUp({ content: "This payment was already marked as sent or the ticket is no longer claimed.", flags: MessageFlags.Ephemeral });
    }
    try {
      const notifiedUsers = [...new Set([String(ticket.claimed_by), String(ticket.owner_id)])];
      await interaction.channel.send({
        content: `<@${ticket.claimed_by}>, <@${ticket.owner_id}> has marked payment as sent.`,
        allowedMentions: { users: notifiedUsers },
      });
    } catch (error) {
      console.error(`Ticket ${ticket.number} payment was marked sent but its announcement failed`, error);
    }
    return interaction.editReply({ components: paymentSentButton(id, true) });
  }
  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "Only server administrators can manage purchase tickets.", flags: MessageFlags.Ephemeral });
  }
  await interaction.deferUpdate();
  if (action === "claim") {
    const claimed = await mutate(state => {
      const current = state.tickets[id];
      if (!current || current.status !== "open") return false;
      current.status = "claimed";
      current.claimed_by = interaction.user.id;
      current.claimed_at = new Date().toISOString();
      recordAuditEvent(current, "claimed", interaction.user.id);
      const stats = state.ticket_stats[interaction.user.id] || { claims: 0, quantity: 0 };
      state.ticket_stats[interaction.user.id] = { ...stats, claims: Number(stats.claims || 0) + 1 };
      return true;
    });
    if (!claimed) return interaction.followUp({ content: "This ticket has already been claimed or closed.", flags: MessageFlags.Ephemeral });
    try {
      await interaction.channel.send({ content: `<@${ticket.owner_id}>`, allowedMentions: { users: [ticket.owner_id] },
        embeds: [makeEmbed("Ticket Claimed!", `This ticket has been claimed by ${interaction.user}.`, 0x57f287)] });
    } catch (error) {
      console.error(`Ticket ${ticket.number} was claimed but its announcement failed`, error);
    }
    return interaction.editReply({ components: ticketButtons(id, "claimed") });
  }
  if (action === "success") {
    if (ticket.status !== "claimed" || !ticket.claimed_by) return interaction.followUp({ content: "Claim this ticket before marking it successful.", flags: MessageFlags.Ephemeral });
    const completion = await mutate(state => {
      const current = state.tickets[id];
      if (!current || current.status !== "claimed" || !current.claimed_by) return { ok: false, reason: "ticket_unavailable" };
      const quantity = Number(current.quantity);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new Error(`Ticket ${id} has an invalid quantity.`);
      }
      const stats = state.ticket_stats[current.claimed_by] || { claims: 0, quantity: 0 };
      const key = current.quantity_type === "blue_gem_lock"
        ? "blue_gem_locks"
        : current.quantity_type === "diamond_lock"
          ? "diamond_locks"
          : "world_locks";
      const quote = getOrCreateTicketQuote(state, id, interaction.user.id);
      if (!quote.ok) return quote;
      const commissionRate = Number.isSafeInteger(quote.rate_snapshot.staff_commission_per_diamond_lock_php_cents)
        ? quote.rate_snapshot.staff_commission_per_diamond_lock_php_cents
        : state.rates?.staff_commission_per_diamond_lock_php_cents;
      if (!Number.isSafeInteger(commissionRate)) return { ok: false, reason: "commission_not_configured" };
      const commissionDiamondLocks = completedDiamondLocksForTicket(stats, current);
      const commissionCents = commissionCentsForTicket(stats, current, commissionRate);
      if (commissionDiamondLocks === null || commissionCents === null || !Number.isSafeInteger(commissionCents)) {
        throw new Error(`Could not calculate ticket commission for ticket ${id}.`);
      }
      const sale = recordSaleInState(state, {
        id: `ticket:${id}`,
        source: "ticket",
        source_id: id,
        buyer_id: current.owner_id,
        payment_method: current.payment_method,
        quantity,
        quantity_type: current.quantity_type,
        revenue_php_cents: quote.amount,
        commission_php_cents: commissionCents,
        commission_rate_php_cents: commissionRate,
        rate_snapshot: quote.rate_snapshot,
        completed_by: interaction.user.id,
      });
      if (!sale.ok) return sale;
      current.status = "success";
      current.successful_at = new Date().toISOString();
      current.sale_revenue_php_cents = sale.entry.revenue_php_cents;
      current.sale_cogs_php_cents = sale.entry.cogs_php_cents;
      recordAuditEvent(current, "marked_successful", interaction.user.id, {
        sale_id: sale.entry.id,
        revenue_php_cents: sale.entry.revenue_php_cents,
        cogs_php_cents: sale.entry.cogs_php_cents,
        commission_php_cents: sale.entry.commission_php_cents,
      });
      current.staff_commission_diamond_locks = commissionDiamondLocks;
      current.staff_commission_php_cents = commissionCents;
      current.staff_commission_rate_php_cents = commissionRate;
      if (current.quantity_type === "world_lock") {
        stats.world_locks = Number(stats.world_locks || 0) + Number(stats.quantity || 0) + quantity;
        delete stats.quantity;
      } else {
        stats[key] = Number(stats[key] || 0) + quantity;
      }
      stats.commission_diamond_locks = Number(stats.commission_diamond_locks || 0) + commissionDiamondLocks;
      stats.commission_php_cents = Number(stats.commission_php_cents || 0) + commissionCents;
      state.ticket_stats[current.claimed_by] = stats;
      return { ok: true, sale: sale.entry };
    });
    if (!completion.ok) {
      if (completion.reason === "commission_not_configured") {
        return interaction.followUp({ content: "Set the staff commission rate with `/changerate` before completing tickets.", flags: MessageFlags.Ephemeral });
      }
      if (completion.reason === "rates_not_configured") {
        return interaction.followUp({ content: "The sale rate for this item is not configured. Update it with `/changerate` before completing this ticket.", flags: MessageFlags.Ephemeral });
      }
      if (completion.reason === "ticket_unavailable") {
        return interaction.followUp({ content: "This ticket has already been completed or is no longer claimed.", flags: MessageFlags.Ephemeral });
      }
      return interaction.followUp({ content: inventoryFailureMessage(completion.reason), flags: MessageFlags.Ephemeral });
    }
    await interaction.channel.send(ticketSuccessMessage(id, ticket.owner_id));
    return interaction.editReply({ components: ticketButtons(id, "success") });
  }
  if (action === "close") {
    const staffChannel = await client.channels.fetch(config.STAFF_CHANNEL_ID);
    if (!staffChannel?.isTextBased() || typeof staffChannel.send !== "function") {
      return interaction.followUp({ content: "The staff log channel is unavailable; this ticket was not deleted.", flags: MessageFlags.Ephemeral });
    }
    if (staffChannel.id === interaction.channelId) {
      return interaction.followUp({ content: "The staff log channel cannot be the ticket channel; this ticket was not deleted.", flags: MessageFlags.Ephemeral });
    }
    const close = await mutate(state => reserveTicketClose(state, "purchase", id, interaction.user.id));
    if (!close.found) return interaction.followUp({ content: "This ticket could not be found.", flags: MessageFlags.Ephemeral });
    if (close.closing) return interaction.followUp({ content: "This ticket is already being archived.", flags: MessageFlags.Ephemeral });
    if (close.closed && close.ticket.close_log_message_id) {
      try {
        await interaction.channel.delete(`Ticket ${ticket.number} closed by ${interaction.user.tag}`);
      } catch (error) {
        console.error(`Ticket ${ticket.number} is archived but could not be deleted`, error);
        return interaction.followUp({ content: "The ticket is archived, but I could not delete the channel. Please try again.", flags: MessageFlags.Ephemeral });
      }
      return;
    }
    try {
      const transcript = await createTicketTranscript(interaction.channel, "ticket", close.ticket, interaction.user);
      const logMessage = await staffChannel.send({
        embeds: [ticketCloseLogEmbed(close.ticket, interaction.user)],
        files: [transcript.file],
        allowedMentions: { parse: [] },
      });
      const finished = await mutate(state => finishTicketClose(state, "purchase", id, logMessage.id, interaction.user.id));
      if (!finished) throw new Error(`Could not finalize closure for ticket ${id}.`);
    } catch (error) {
      await mutate(state => abortTicketClose(state, "purchase", id, interaction.user.id));
      console.error(`Could not archive ticket ${ticket.number}`, error);
      return interaction.followUp({ content: "The transcript or staff log could not be created; the ticket was left open.", flags: MessageFlags.Ephemeral });
    }
    try {
      await interaction.channel.delete(`Ticket ${ticket.number} closed by ${interaction.user.tag}`);
    } catch (error) {
      console.error(`Ticket ${ticket.number} was archived but its channel could not be deleted`, error);
      return interaction.followUp({ content: "The ticket is archived, but I could not delete the channel. Please try again.", flags: MessageFlags.Ephemeral });
    }
    return;
  }
}

async function onInteraction(interaction) {
  try {
    await refreshData();
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
    else if (interaction.isModalSubmit()) await handleModal(interaction);
  } catch (error) {
    console.error(`Interaction ${interaction.id} failed`, error);
    const response = { content: "The request failed. Please check the bot logs or contact an administrator.", flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(console.error);
    else await interaction.reply(response).catch(console.error);
  }
}

client.on(Events.InteractionCreate, onInteraction);
client.once(Events.ClientReady, async readyClient => {
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    const guildId = process.env.DISCORD_GUILD_ID;
    const route = guildId
      ? Routes.applicationGuildCommands(readyClient.user.id, guildId)
      : Routes.applicationCommands(readyClient.user.id);
    await rest.put(route, { body: commands });
    console.log(`Logged in as ${readyClient.user.tag}; registered ${commands.length} slash commands${guildId ? ` for guild ${guildId}` : " globally"}.`);
    const staffChannel = await client.channels.fetch(config.STAFF_CHANNEL_ID);
    if (!staffChannel?.isTextBased()) throw new Error("STAFF_CHANNEL_ID is not a text channel.");
    for (const [id, vouch] of Object.entries(data.vouches)) {
      if (vouch.status !== "pending" || vouch.review_message_id) continue;
      const message = await staffChannel.send({ embeds: [vouchReviewEmbed(vouch)], components: reviewButtons("vouch", id) });
      await mutate(state => {
        if (state.vouches[id]?.status === "pending") state.vouches[id].review_message_id = message.id;
      });
    }
    for (const [id, redemption] of Object.entries(data.redemptions)) {
      if (redemption.status !== "pending" || redemption.staff_message_id) continue;
      const message = await staffChannel.send({
        content: `<@${redemption.buyer_id}>`,
        allowedMentions: { users: [redemption.buyer_id] },
        embeds: [redemptionEmbed(redemption)],
        components: reviewButtons("redemption", id),
      });
      await mutate(state => {
        if (state.redemptions[id]?.status === "pending") state.redemptions[id].staff_message_id = message.id;
      });
    }
  } catch (error) {
    console.error("Could not synchronize slash commands or restore pending reviews", error);
  }
});

async function main() {
  loadConfig();
  await loadData();
  await loginWithRetry();
}

async function loginWithRetry() {
  const retryDelayMs = 15000;
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await client.login(process.env.DISCORD_TOKEN);
      return;
    } catch (error) {
      const refusal = error?.code === "ECONNREFUSED"
        || error?.errors?.some(candidate => candidate?.code === "ECONNREFUSED");
      if (!refusal || attempt === maxAttempts) throw error;
      console.error(
        `Discord gateway connection refused (attempt ${attempt}/${maxAttempts}). Retrying in ${retryDelayMs / 1000}s.`,
      );
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("Bot startup failed", error);
    process.exitCode = 1;
  });
}

process.on("SIGINT", async () => {
  await pool.end();
  client.destroy();
  process.exit(0);
});

module.exports = {
  commands,
  calculateTicketPriceCents,
  calculateMidmanFeeCents,
  adjustInventory,
  recordSaleInState,
  calculateProfitSummary,
  affordableRewardTiers,
  rewardRedemptionModal,
  redemptionEmbed,
  quantityWorldLocks,
  transitionMidman,
  findActiveTicketForUser,
  reserveNewTicket,
  applyStockRemoval,
  updatePointsBalance,
  resolveGuildMember,
  buildTicketTranscriptHtml,
  createTicketTranscript,
  completedDiamondLocksForTicket,
  commissionCentsForTicket,
  formatNormalizedVouchQuantity,
  formatNormalizedLockQuantity,
  formatPhpCents,
  statusVoiceChannelName,
  ticketVouchModal,
  ticketSuccessMessage,
  midmanSuccessMessage,
  ticketCloseLogEmbed,
  normalizeTicketStats,
  parseNonNegativeInteger,
  parsePhpCents,
  ticketStatEditCommissionModal,
  ticketStatEditFirstModal,
  stockUpdateModal,
  salesEntryModal,
  reserveCommissionClaim,
  attachCommissionClaimLog,
  finalizeCommissionClaim,
  midmanTicketButtons,
  vouchWorldLocks,
  worldLocks,
};
