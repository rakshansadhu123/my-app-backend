
// Copyright © 2025 Rakshan Sadhu
// All Rights Reserved.
// Unauthorized use of this file is prohibited.

const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');
const bodyParser = require('body-parser');
const cors = require('cors');

// Node.js v18+ has fetch globally, otherwise require node-fetch
let fetch;
if (typeof global.fetch === 'undefined') {
  fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
} else {
  fetch = global.fetch;
}

const app = express();
app.use(cors()); // Enable CORS for all routes

// Use bodyParser.json() for all routes except the raw webhook
app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/api/stripe/webhook')) {
    next();
  } else {
    bodyParser.json()(req, res, next);
  }
});


// --- CLIENT INITIALIZATION ---
if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.API_KEY || !process.env.MMM_API_KEY || !process.env.STRIPE_PRICE_ID || !process.env.APP_URL) {
  console.error("FATAL ERROR: Missing critical environment variables. Ensure STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY (Gemini), MMM_API_KEY, STRIPE_PRICE_ID, and APP_URL are set.");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ai = new GoogleGenAI({apiKey: process.env.API_KEY});

// --- HELPER FUNCTION to verify Supabase JWT ---
const getSupabaseUser = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return null;
  }
  const accessToken = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error) {
    res.status(401).json({ error: 'Invalid access token', details: error.message });
    return null;
  }
  return user;
};


// --- 1. STRIPE CHECKOUT ---
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  const { userId } = req.body;
  const user = await getSupabaseUser(req, res);
  if (!user || user.id !== userId) {
    if(!res.headersSent) res.status(403).json({ error: 'User token does not match requested user ID.'});
    return;
  }

  try {
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id, email')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    let stripeCustomerId = profile.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: profile.email || user.email,
        metadata: { supabase_user_id: userId }
      });
      stripeCustomerId = customer.id;
      await supabase.from('user_profiles').update({ stripe_customer_id: stripeCustomerId }).eq('id', userId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: 2 },
      success_url: `${process.env.APP_URL}?payment_success=true`,
      cancel_url: `${process.env.APP_URL}?payment_cancel=true`,
    });

    return res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- 2. STRIPE CUSTOMER PORTAL (SECURE) ---
app.post('/api/stripe/create-portal-session', async (req, res) => {
  const user = await getSupabaseUser(req, res);
  if (!user) return;

  try {
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.stripe_customer_id) {
      return res.status(404).json({ error: 'Stripe customer ID not found for user.' });
    }
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.APP_URL}`,
    });
    return res.json({ url: portalSession.url });
  } catch (err) {
    console.error("Error creating portal session:", err);
    return res.status(500).json({ error: err.message });
  }
});


// --- 3. STRIPE WEBHOOK ---
app.post('/api/stripe/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const eventObject = event.data.object;
  const customerId = eventObject.customer;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        if (eventObject.mode === 'subscription') {
          await supabase
            .from('user_profiles')
            .update({
              subscription_id: eventObject.subscription,
              subscription_status: 'trialing'
            })
            .eq('stripe_customer_id', customerId);
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await supabase
          .from('user_profiles')
          .update({ subscription_status: eventObject.status })
          .eq('stripe_customer_id', customerId);
        break;
      }
      default:
        // Unhandled event type
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Error processing Stripe webhook event:', event.type, err);
    res.status(500).send('Internal Server Error');
  }
});

// --- 4. GEMINI API PROXY (USING SDK) ---
app.post('/api/gemini/proxy', async (req, res) => {
    const user = await getSupabaseUser(req, res);
    if (!user) return;

    const { prompt, model, config } = req.body;

    if (!prompt || !model) {
        return res.status(400).json({ error: 'Missing required fields: prompt and model.' });
    }

    try {
        const response = await ai.models.generateContent({
            model: model,
            contents: prompt,
            config: config || {}
        });
        
        res.status(200).send(response.text);

    } catch (error) {
        console.error('Error calling Google GenAI API:', error);
        res.status(500).json({ error: 'Failed to get response from AI model.', details: error.message });
    }
});

// --- 5. MMM API PROXY ---
app.post('/api/mmm/proxy', async (req, res) => {
    const user = await getSupabaseUser(req, res);
    if (!user) return; 

    const mmmApiKey = process.env.MMM_API_KEY; 
    const mmmApiEndpoint = 'https://mmm-api-backend-7tbm.onrender.com/api/run-mmm';

    if (!mmmApiKey) {
        return res.status(500).json({ error: 'MMM API key is not configured on the server.' });
    }

    try {
        const mmmResponse = await fetch(mmmApiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': mmmApiKey,
            },
            body: JSON.stringify(req.body),
        });
        const responseData = await mmmResponse.json();
        return res.status(mmmResponse.status).json(responseData);
    } catch (error) {
        console.error('Error proxying request to MMM API:', error);
        res.status(500).json({ error: 'Failed to proxy request to MMM service.', details: error.message });
    }
});


// --- SERVER START ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
