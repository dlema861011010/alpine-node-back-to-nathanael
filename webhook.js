'use strict';

/**
 * Stripe → FuseFlash USDC onboarding webhook
 *
 * Environment variables required:
 *   STRIPE_SECRET_KEY      – Stripe secret key (sk_live_… / sk_test_…)
 *   STRIPE_WEBHOOK_SECRET  – Signing secret from the Stripe dashboard / CLI
 *   FUSE_FLASH_RPC_URL     – JSON-RPC endpoint for the FuseFlash network
 *   PRIVATE_KEY            – Private key of the USDC-dispensing wallet
 *   USDC_ADDRESS           – ERC-20 USDC contract address on FuseFlash
 *   PORT                   – (optional) HTTP port, defaults to 3000
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { ethers } = require('ethers');
const express = require('express');

const app = express();

// ── USDC contract ────────────────────────────────────────────────────────────
// Standard ERC-20 USDC address on FuseFlash.
// Must be set via the USDC_ADDRESS environment variable for the target network.
const USDC_ADDRESS = process.env.USDC_ADDRESS;
if (!USDC_ADDRESS || !ethers.isAddress(USDC_ADDRESS)) {
  throw new Error('USDC_ADDRESS environment variable is missing or invalid.');
}

// Minimal ERC-20 ABI – only the `transfer` function is needed here.
const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

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

        // Mark the PaymentIntent so duplicate webhook deliveries are no-ops.
        await stripe.paymentIntents.update(paymentIntent.id, {
          metadata: { usdc_sent: 'true' },
        });
      } catch (blockchainErr) {
        console.error(
          `Blockchain transfer failed for PaymentIntent ${paymentIntent.id}:`,
          blockchainErr,
        );
        // TODO: implement a retry queue or alerting system (e.g. SQS, PagerDuty).
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
