const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

const PLANS = {
  basic_monthly:    { amount: 999,   interval: 'month', name: 'Starter Mensual',  credits: 30   },
  basic_annual:     { amount: 9588,  interval: 'year',  name: 'Starter Anual',    credits: 360  },
  pro_monthly:      { amount: 2499,  interval: 'month', name: 'Creator Mensual',  credits: 150  },
  pro_annual:       { amount: 23988, interval: 'year',  name: 'Creator Anual',    credits: 1800 },
  unlimited_annual: { amount: 39900, interval: 'year',  name: 'Agency Ilimitado', credits: -1   },
};

const CREDIT_PACKS = {
  credits_10:  { amount: 199,  credits: 10,  name: '10 Créditos'  },
  credits_50:  { amount: 799,  credits: 50,  name: '50 Créditos'  },
  credits_120: { amount: 1699, credits: 120, name: '120 Créditos' },
  credits_300: { amount: 3499, credits: 300, name: '300 Créditos' },
};

// ── Create subscription checkout ──
app.post('/create-subscription', async (req, res) => {
  const { planKey, userId, email } = req.body;
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Plan inválido' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `ContentAI — ${plan.name}` },
          recurring: { interval: plan.interval },
          unit_amount: plan.amount,
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}/app.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing.html`,
      metadata: { planKey, userId, credits: plan.credits },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create credits payment ──
app.post('/create-credits-payment', async (req, res) => {
  const { packKey, userId, email } = req.body;
  const pack = CREDIT_PACKS[packKey];
  if (!pack) return res.status(400).json({ error: 'Pack inválido' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `ContentAI — ${pack.name}` },
          unit_amount: pack.amount,
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}/app.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing.html`,
      metadata: { packKey, userId, credits: pack.credits },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe Webhook → activate credits in Supabase ──
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, credits, planKey, packKey } = session.metadata;

    if (!userId) return res.json({ received: true });

    const creditsNum = parseInt(credits);

    // Get current user
    const { data: user } = await supabase
      .from('users')
      .select('credits, plan')
      .eq('id', userId)
      .single();

    if (!user) return res.json({ received: true });

    if (creditsNum === -1) {
      // Unlimited plan
      await supabase.from('users').update({
        plan: 'unlimited',
        credits: 999999,
        plan_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }).eq('id', userId);
    } else if (planKey) {
      // Subscription plan
      const interval = PLANS[planKey]?.interval;
      const expiry = interval === 'year'
        ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await supabase.from('users').update({
        plan: planKey,
        credits: creditsNum,
        plan_expires_at: expiry.toISOString(),
      }).eq('id', userId);
    } else if (packKey) {
      // Credit pack — add to existing
      await supabase.from('users').update({
        credits: (user.credits || 0) + creditsNum,
      }).eq('id', userId);
    }

    // Log transaction
    await supabase.from('transactions').insert({
      user_id: userId,
      type: planKey ? 'subscription' : 'credits',
      plan: planKey || packKey,
      credits_added: creditsNum,
      amount: session.amount_total,
      stripe_session_id: session.id,
    });
  }

  res.json({ received: true });
});

// ── Get user info ──
app.get('/user/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(data);
});

// ── Deduct credit ──
app.post('/use-credit', async (req, res) => {
  const { userId } = req.body;
  const { data: user } = await supabase
    .from('users')
    .select('credits, plan')
    .eq('id', userId)
    .single();

  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.credits <= 0) return res.status(403).json({ error: 'Sin créditos' });

  if (user.plan !== 'unlimited_annual') {
    await supabase.from('users').update({ credits: user.credits - 1 }).eq('id', userId);
  }
  res.json({ success: true, credits: user.credits - 1 });
});

// ── Admin: get all users ──
app.get('/admin/users', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'No autorizado' });

  const { data } = await supabase
    .from('users')
    .select('*, transactions(*)')
    .order('created_at', { ascending: false });
  res.json(data);
});

// ── Admin: update user credits ──
app.post('/admin/update-credits', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'No autorizado' });

  const { userId, credits } = req.body;
  await supabase.from('users').update({ credits }).eq('id', userId);
  res.json({ success: true });
});
// ── Notify Make.com on new user ──
app.post('/new-user-webhook', async (req, res) => {
  const { email, name } = req.body;
  try {
    await fetch(process.env.MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, date: new Date().toISOString() })
    });
  } catch(e) { console.log('Make webhook error', e); }
  res.json({ success: true });
});
// ── Health ──
app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 ContentAI backend en puerto ${PORT}`));
