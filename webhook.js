'use strict';

/**
 * Stripe → FuseFlash USDC onboarding webhook
 *
 * Environment variables required:
 *   STRIPE_SECRET_KEY           – Stripe secret key (sk_live_… / sk_test_…)
 *   STRIPE_WEBHOOK_SECRET       – Signing secret from the Stripe dashboard / CLI
 *   FUSE_FLASH_RPC_URL          – JSON-RPC endpoint for the FuseFlash network
 *   PRIVATE_KEY                 – Private key of the USDC-dispensing wallet
 *   USDC_ADDRESS                – (optional) ERC-20 USDC contract address on Fuse
 *                                 defaults to 0x5f33ec4ec21c2266dedd927b43f388c4a06261c0
 *   GCP_TASKS_QUEUE_URL         – Full Cloud Tasks queue resource name
 *                                 projects/PROJECT/locations/REGION/queues/QUEUE
 *   GCP_TASKS_HANDLER_URL       – HTTPS URL Cloud Tasks will POST the retry payload to
 *   PORT                        – (optional) HTTP port, defaults to 3000
 *
 * Optional overrides for external endpoints (defaults shown below):
 *   STRIPE_API_BASE             – https://api.stripe.com
 *   STRIPE_DASHBOARD_BASE       – https://dashboard.stripe.com
 *   BLOCKSCOUT_BASE_URL         – https://explorer.fuse.io   (FuseFlash Blockscout)
 *   GCP_BASE_URL                – https://cloudtasks.googleapis.com
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { ethers } = require('ethers');
const express = require('express');

const app = express();

// ── External endpoint base URLs ───────────────────────────────────────────────
const ENDPOINTS = {
  stripeApi:       process.env.STRIPE_API_BASE       || 'https://api.stripe.com',
  stripeDashboard: process.env.STRIPE_DASHBOARD_BASE || 'https://dashboard.stripe.com',
  blockscout:      process.env.BLOCKSCOUT_BASE_URL   || 'https://explorer.fuse.io',
  gcpTasks:        process.env.GCP_BASE_URL          || 'https://cloudtasks.googleapis.com',
};

// ── USDC contract ────────────────────────────────────────────────────────────
// USDC on Fuse: 0x5f33ec4ec21c2266dedd927b43f388c4a06261c0
// Override via the USDC_ADDRESS environment variable for other networks.
const USDC_ADDRESS = process.env.USDC_ADDRESS || '0x5f33ec4ec21c2266dedd927b43f388c4a06261c0';
if (!ethers.isAddress(USDC_ADDRESS)) {
  throw new Error(`USDC_ADDRESS is not a valid Ethereum address: ${USDC_ADDRESS}`);
}

// Minimal ERC-20 ABI – only the `transfer` function is needed here.
const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

// ── Google Cloud Tasks retry helper ──────────────────────────────────────────
/**
 * Enqueue a failed PaymentIntent for a later blockchain-transfer retry via
 * Google Cloud Tasks (https://cloudtasks.googleapis.com).
 *
 * Authentication uses the GCE metadata server when running on GCP (Cloud Run,
 * GKE, Compute Engine).  Outside GCP supply a bearer token via GCP_ACCESS_TOKEN.
 */
async function enqueueRetry(paymentIntentId, userWallet, amountUsd) {
  const queueUrl = process.env.GCP_TASKS_QUEUE_URL;
  const handlerUrl = process.env.GCP_TASKS_HANDLER_URL;

  if (!queueUrl || !handlerUrl) {
    console.warn(
      'GCP_TASKS_QUEUE_URL / GCP_TASKS_HANDLER_URL not set – retry not enqueued.',
    );
    return;
  }

  // Obtain a short-lived access token from the GCE metadata server.
  let accessToken = process.env.GCP_ACCESS_TOKEN;
  if (!accessToken) {
    try {
      const metaRes = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } },
      );
      const meta = await metaRes.json();
      accessToken = meta.access_token;
    } catch {
      console.error('Failed to obtain GCP access token – retry not enqueued.');
      return;
    }
  }

  const payload = Buffer.from(
    JSON.stringify({ paymentIntentId, userWallet, amountUsd }),
  ).toString('base64');

  const tasksEndpoint =
    `${ENDPOINTS.gcpTasks}/v2/${queueUrl}/tasks`;

  const body = {
    task: {
      httpRequest: {
        httpMethod: 'POST',
        url: handlerUrl,
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      },
    },
  };

  try {
    const res = await fetch(tasksEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Cloud Tasks enqueue failed (${res.status}): ${text}`);
    } else {
      const task = await res.json();
      console.log(`Retry task enqueued: ${task.name}`);
    }
  } catch (taskErr) {
    console.error('Cloud Tasks request error:', taskErr);
  }
}


// ── FuseFlash provider & dispensing wallet ────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.FUSE_FLASH_RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);

// ── Webhook endpoint ─────────────────────────────────────────────────────────
// express.raw() must be used here so that Stripe's signature verification has
// access to the raw request body bytes.
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    // 1. Verify the payload came from Stripe.
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      // Send a plain-text error; do not reflect err.message into HTML context.
      return res.status(400).type('text').send('Webhook signature verification failed.');
    }

    // 2. For payment_intent.succeeded, run idempotency check before ack so
    //    concurrent duplicate deliveries cannot both pass the guard.
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;

      // Idempotency: skip if we already processed this PaymentIntent.
      if (paymentIntent.metadata.usdc_sent === 'true') {
        console.log(`PaymentIntent ${paymentIntent.id} already processed – skipping.`);
        return res.json({ received: true });
      }

      const userWallet = paymentIntent.metadata.wallet_address;
      if (!userWallet || !ethers.isAddress(userWallet)) {
        console.error(
          `PaymentIntent ${paymentIntent.id}: invalid or missing wallet_address in metadata.`,
        );
        return res.json({ received: true });
      }

      // Acknowledge receipt so Stripe won't retry while the transfer runs.
      res.json({ received: true });

      // Stripe amounts are in the currency's smallest unit (cents for USD).
      // USDC uses 6 decimal places, so 1 USD = 1 USDC = 1_000_000 base units.
      const amountUsd = paymentIntent.amount / 100;
      console.log(
        `Payment confirmed (${paymentIntent.id})! Sending ${amountUsd} USDC to ${userWallet} on FuseFlash…`,
      );

      try {
        const tx = await usdcContract.transfer(
          userWallet,
          ethers.parseUnits(amountUsd.toString(), 6),
        );
        await tx.wait();
        console.log(`On-chain transfer successful: ${tx.hash}`);
        console.log(`  Blockscout:       ${ENDPOINTS.blockscout}/tx/${tx.hash}`);
        console.log(`  Stripe Dashboard: ${ENDPOINTS.stripeDashboard}/payments/${paymentIntent.id}`);

        // Mark the PaymentIntent so duplicate webhook deliveries are no-ops.
        await stripe.paymentIntents.update(paymentIntent.id, {
          metadata: { usdc_sent: 'true' },
        });
      } catch (blockchainErr) {
        console.error(
          `Blockchain transfer failed for PaymentIntent ${paymentIntent.id}:`,
          blockchainErr,
        );
        console.error(
          `  Review in Stripe Dashboard: ${ENDPOINTS.stripeDashboard}/payments/${paymentIntent.id}`,
        );
        // Enqueue a retry task via Google Cloud Tasks.
        await enqueueRetry(paymentIntent.id, userWallet, amountUsd);
      }
      return;
    }

    // 3. Acknowledge all other event types.
    res.json({ received: true });
  },
);

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stripe webhook listener running on port ${PORT}`);
});

module.exports = app; // exported for testing
