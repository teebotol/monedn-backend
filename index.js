const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const corsOptions = {
  origin: ['https://monedn.fr', 'http://localhost', 'http://localhost:8080'],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-user-id', 'x-admin-key'],
  credentials: false
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===== BREVO =====
async function addToBrevo(email, prenom) {
  try {
    await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: email,
        attributes: { FIRSTNAME: prenom || '' },
        listIds: [3],
        updateEnabled: true
      })
    });
    console.log('Contact ajouté à Brevo:', email);
  } catch (err) {
    console.error('Brevo error:', err);
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'MonEDN backend OK' });
});

// ===== REGISTER - BREVO =====
app.post('/register', async (req, res) => {
  const { email, prenom } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  await addToBrevo(email, prenom);
  res.json({ success: true });
});

// ===== CRON - EXPIRE TRIALS =====
app.get('/cron/expire-trials', async (req, res) => {
  const adminKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Non autorisé' });
  const now = new Date().toISOString();

  const { data: expired, error } = await supabase
    .from('profiles')
    .update({ is_active: false })
    .lt('trial_ends_at', now)
    .eq('is_active', true)
    .eq('is_beta', false)
    .is('stripe_customer_id', null)
    .select();

  if (error) return res.status(500).json({ error });
  console.log(`Trials expirés : ${expired?.length || 0} users désactivés`);
  res.json({ expired: expired?.length || 0, at: now });
});

// ===== PLANNINGS =====
app.get('/plannings', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });
  const { data, error } = await supabase.from('plannings').select('*').eq('user_id', userId);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/plannings', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });
  const { data, error } = await supabase.from('plannings').insert({ ...req.body, user_id: userId });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.patch('/plannings/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });
  const { data, error } = await supabase.from('plannings').update(req.body).eq('id', req.params.id).eq('user_id', userId);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.delete('/plannings/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });
  const { error } = await supabase.from('plannings').delete().eq('id', req.params.id).eq('user_id', userId);
  if (error) return res.status(500).json({ error });
  res.json({ success: true });
});

// ===== STRIPE =====
app.post('/create-checkout', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const userEmail = req.body.email;
    const plan = req.body.plan || 'monthly';

    if (!userId) return res.status(401).json({ error: 'Non autorisé' });

    const priceId = plan === 'annual'
      ? process.env.STRIPE_ANNUAL_PRICE_ID
      : process.env.STRIPE_PRICE_ID;

    if (!priceId) {
      console.error('Price ID manquant pour le plan:', plan);
      return res.status(500).json({ error: 'Configuration Stripe manquante' });
    }

    console.log('Checkout:', plan, '→ priceId:', priceId);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: userEmail,
      allow_promotion_codes: true, // ← CODE PROMO ACTIVÉ
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        // Trial géré uniquement côté app (voir trial_ends_at dans profiles).
        // Pas de trial_period_days ici : la facturation Stripe démarre
        // immédiatement à la création de la session, quel que soit le jour
        // du trial app où l'utilisateur clique sur "S'abonner".
        metadata: { user_id: userId }
      },
      metadata: { user_id: userId },
      success_url: 'https://monedn.fr/app.html?subscribed=true',
      cancel_url: 'https://monedn.fr/app.html?canceled=true',
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('Erreur create-checkout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== STRIPE PORTAL =====
app.post('/create-portal', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Non autorisé' });

    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.stripe_customer_id || profile.stripe_customer_id === 'subscribed_manual') {
      return res.status(400).json({ error: 'Aucun abonnement Stripe trouvé' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: 'https://monedn.fr/app.html',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Erreur create-portal:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== CONFIRM SUBSCRIPTION =====
app.post('/confirm-subscription', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });
  await supabase.from('profiles').update({
    is_active: true
  }).eq('id', userId);
  res.json({ success: true });
});

// ===== WEBHOOK STRIPE =====
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send('Webhook error: ' + err.message);
  }

  const userId = event.data.object.metadata?.user_id;
  const customerId = event.data.object.customer;

  console.log(`Webhook reçu : ${event.type} | userId: ${userId} | customerId: ${customerId}`);

  if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
    if (userId) {
      await supabase.from('profiles').update({ is_active: false }).eq('id', userId);
      console.log(`User ${userId} désactivé`);
    } else if (customerId) {
      await supabase.from('profiles').update({ is_active: false }).eq('stripe_customer_id', customerId);
      console.log(`User désactivé via customerId: ${customerId}`);
    }
  }

  if (event.type === 'customer.subscription.created' || event.type === 'invoice.payment_succeeded') {
    if (userId) {
      await supabase.from('profiles').update({
        is_active: true,
        stripe_customer_id: customerId
      }).eq('id', userId);
      console.log(`User ${userId} activé, stripe_customer_id: ${customerId}`);
    } else if (customerId) {
      await supabase.from('profiles').update({
        is_active: true
      }).eq('stripe_customer_id', customerId);
      console.log(`User activé via customerId: ${customerId}`);
    }
  }

  res.json({ received: true });
});

// ===== ADMIN =====
app.get('/admin/profiles', async (req, res) => {
  const adminKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Non autorisé' });
  const { data, error } = await supabase.from('profiles').select('*');
  if (error) return res.status(500).json({ error });
  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MonEDN backend démarré sur port ' + PORT));
