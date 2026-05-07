const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Test
app.get('/', (req, res) => {
  res.json({ status: 'MonEDN backend OK' });
});

// GET plannings d'un user
app.get('/plannings', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });
  const { data, error } = await supabase
    .from('plannings')
    .select('*')
    .eq('user_id', userId);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// POST ajouter un item
app.post('/plannings', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });
  const { data, error } = await supabase
    .from('plannings')
    .insert({ ...req.body, user_id: userId });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// PATCH mettre à jour un item
app.patch('/plannings/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });
  const { data, error } = await supabase
    .from('plannings')
    .update(req.body)
    .eq('id', req.params.id)
    .eq('user_id', userId);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// DELETE supprimer un item
app.delete('/plannings/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Non autorisé' });
  const { error } = await supabase
    .from('plannings')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', userId);
  if (error) return res.status(500).json({ error });
  res.json({ success: true });
});

// GET profils (admin)
app.get('/admin/profiles', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Non autorisé' });
  const { data, error } = await supabase.from('profiles').select('*');
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// GET plannings (admin)
app.get('/admin/plannings', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Non autorisé' });
  const { data, error } = await supabase.from('plannings').select('*');
  if (error) return res.status(500).json({ error });
  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MonEDN backend démarré sur port ' + PORT));
