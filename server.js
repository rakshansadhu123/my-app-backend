// This file provides the backend endpoints for Stripe + Supabase subscription management and a Gemini AI proxy.
// Assumes you are using Node.js with Express and the official Stripe, Supabase, and Google GenAI JS SDKs.
// You must set the following environment variables in your deployment environment:
// STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL, API_KEY (for Gemini)

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
// Ensure environment variables are set
if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.API_KEY) {
  console.error("FATAL ERROR: Missing critical environment variables for Stripe, Supabase, or Gemini.");
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

    // 2-day free trial is set here (see Stripe docs)
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: 2 }, // <-- 2-day free trial
      success_url: `${process.env.APP_URL}?payment_success=true`,
      cancel_url: `${process.env.APP_URL}?payment_cancel=true`,
    });

    return res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- 2. STRIPE CUSTOMER PORTAL ---
app.post('/api/stripe/create-portal-session', async (req, res) => {
  // No longer accept customerId from client for security
  const user = await getSupabaseUser(req, res);
  if (!user) return;

  try {
    // Fetch customerId from Supabase
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

  // Clarify variable names for readability
  const eventObject = event.data.object;
  const customerId = eventObject.customer;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const subscriptionId = eventObject.subscription;
        if (eventObject.mode === 'subscription') {
          await supabase
            .from('user_profiles')
            .update({
              subscription_id: subscriptionId,
              subscription_status: 'trialing' // Set to trialing on checkout completion
            })
            .eq('stripe_customer_id', customerId);
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = eventObject;
        const status = subscription.status; // e.g., 'active', 'past_due', 'canceled'
        await supabase
          .from('user_profiles')
          .update({ subscription_status: status })
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

// --- 4. GEMINI API PROXY ---
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
    if (!user) return; // Auth failed

    // The MMM API key should be an environment variable on this server
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

        if (!mmmResponse.ok) {
            return res.status(mmmResponse.status).json(responseData);
        }
        
        return res.status(200).json(responseData);

    } catch (error) {
        console.error('Error proxying request to MMM API:', error);
        res.status(500).json({ error: 'Failed to proxy request to MMM service.', details: error.message });
    }
});


// --- SERVER START ---
const PORT = process.env.PORT || 3001; // Using 3001 to avoid common conflicts with frontend dev servers
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
