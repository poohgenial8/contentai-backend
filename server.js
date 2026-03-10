const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ── Prices (create these once in Stripe Dashboard or via API) ──
// For now we use price_data inline so no manual setup needed

const PLANS = {
  basic_monthly:   { amount: 999,   interval: 'month', name: 'Starter Mensual',   credits: 30  },
  basic_annual:    { amount: 9588,  interval: 'year',  name: 'Starter Anual',     credits: 360 },
  pro_monthly:     { amount: 2499,  interval: 'month', name: 'Creator Mensual',   credits: 150 },
  pro_annual:      { amount: 23988, interval: 'year',  name: 'Creator Anual',     credits: 1800},
  unlimited_annual:{ amount: 39900, interval: 'year',  name: 'Agency Ilimitado',  credits: -1  },
};

const CREDIT_PACKS = {
  credits_10:  { amount: 199,  credits: 10,  name: '10 Créditos'  },
  credits_50:  { amount: 799,  credits: 50,  name: '50 Créditos'  },
  credits_120: { amount: 1699, credits: 120, name: '120 Créditos' },
  credits_300: { amount: 3499, credits: 300, name: '300 Créditos' },
};

// ── Create subscription checkout session ──
app.post('/create-subscription', async (req, res) => {
  const { planKey, email } = req.body;
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Plan inválido' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `ContentAI — ${plan.name}` },
          recurring: { interval: plan.interval },
          unit_amount: plan.amount,
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}&plan=${planKey}`,
      cancel_url:  `${process.env.FRONTEND_URL || 'http://localhost:3000'}/pricing`,
      metadata: { planKey, credits: plan.credits },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Create one-time credits checkout session ──
app.post('/create-credits-payment', async (req, res) => {
  const { packKey } = req.body;
  const pack = CREDIT_PACKS[packKey];
  if (!pack) return res.status(400).json({ error: 'Pack inválido' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `ContentAI — ${pack.name}` },
          unit_amount: pack.amount,
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}&pack=${packKey}`,
      cancel_url:  `${process.env.FRONTEND_URL || 'http://localhost:3000'}/pricing`,
      metadata: { packKey, credits: pack.credits },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe Webhook (to activate credits after payment) ──
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const credits = session.metadata?.credits;
    const planKey = session.metadata?.planKey || session.metadata?.packKey;
    console.log(`✅ Pago completado: ${planKey} — ${credits === '-1' ? 'Ilimitado' : credits + ' créditos'}`);
    // Aquí conectarías tu base de datos para activar los créditos del usuario
  }

  res.json({ received: true });
});

// ── Health check ──
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 ContentAI backend corriendo en puerto ${PORT}`));
