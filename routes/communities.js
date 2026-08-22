const express = require('express');
const crypto = require('crypto');
const { query } = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// ===== COMMUNITIES =====

// Create community
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Community name required' });

    const inviteCode = crypto.randomBytes(4).toString('hex');
    const result = await query(
      'INSERT INTO communities (name, description, creator_id, invite_code) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, description || null, req.user.id, inviteCode]
    );
    const communityId = result.rows[0].id;

    // Creator is admin
    await query('INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, $3)', [communityId, req.user.id, 'admin']);

    // Auto-create Announcements group
    const announcementCode = crypto.randomBytes(4).toString('hex');
    const annConv = await query(
      `INSERT INTO conversations (type, name, description, invite_code, created_by) VALUES ('group', $1, $2, $3, $4) RETURNING id`,
      [name + ' - Announcements', 'Only admins can send messages', announcementCode, req.user.id]
    );
    const annConvId = annConv.rows[0].id;
    await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)', [annConvId, req.user.id, 'admin']);
    // Lock announcements so only admins can post
    await query('UPDATE conversations SET locked = 1 WHERE id = $1', [annConvId]);
    // Link to community
    await query('INSERT INTO community_groups (community_id, conversation_id) VALUES ($1, $2)', [communityId, annConvId]);

    res.status(201).json({ id: communityId, name, invite_code: inviteCode });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// List user's communities
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT c.*, cm.role,
        (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) as member_count,
        (SELECT COUNT(*) FROM community_groups WHERE community_id = c.id) as group_count
      FROM communities c
      JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = $1
      ORDER BY c.created_at DESC
    `, [req.user.id]);
    res.json({ communities: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get community details
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const communityId = req.params.id;
    const community = await query('SELECT * FROM communities WHERE id = $1', [communityId]);
    if (community.rows.length === 0) return res.status(404).json({ error: 'Community not found' });

    const member = await query('SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, req.user.id]);
    if (member.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

    const groups = await query(`
      SELECT c.id, c.name, c.group_avatar, c.locked,
        (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) as member_count
      FROM community_groups cg
      JOIN conversations c ON cg.conversation_id = c.id
      WHERE cg.community_id = $1
      ORDER BY c.created_at ASC
    `, [communityId]);

    const members = await query(`
      SELECT cm.role, u.id, u.username, u.avatar
      FROM community_members cm JOIN users u ON cm.user_id = u.id
      WHERE cm.community_id = $1 ORDER BY cm.role DESC, u.username ASC
    `, [communityId]);

    res.json({
      community: community.rows[0],
      groups: groups.rows,
      members: members.rows,
      my_role: member.rows[0].role
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Add group to community (create new or link existing)
router.post('/:id/groups', authenticateToken, async (req, res) => {
  try {
    const communityId = req.params.id;
    const { conversation_id, name } = req.body;

    // Check admin
    const member = await query('SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, req.user.id]);
    if (member.rows.length === 0 || member.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can add groups' });
    }

    let convId = conversation_id;

    // Create new group if no conversation_id
    if (!convId && name) {
      const inviteCode = crypto.randomBytes(4).toString('hex');
      const conv = await query(
        `INSERT INTO conversations (type, name, invite_code, created_by) VALUES ('group', $1, $2, $3) RETURNING id`,
        [name, inviteCode, req.user.id]
      );
      convId = conv.rows[0].id;
      await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)', [convId, req.user.id, 'admin']);

      // Add all community members to the new group
      const communityMembers = await query('SELECT user_id FROM community_members WHERE community_id = $1 AND user_id != $2', [communityId, req.user.id]);
      for (const cm of communityMembers.rows) {
        await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [convId, cm.user_id, 'member']);
      }
    }

    if (!convId) return res.status(400).json({ error: 'Provide conversation_id or name' });

    await query('INSERT INTO community_groups (community_id, conversation_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [communityId, convId]);
    res.json({ conversation_id: convId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Join community via invite code
router.post('/join/:code', authenticateToken, async (req, res) => {
  try {
    const { code } = req.params;
    const community = await query('SELECT id, name FROM communities WHERE invite_code = $1', [code]);
    if (community.rows.length === 0) return res.status(404).json({ error: 'Invalid invite link' });

    const communityId = community.rows[0].id;

    // Add to community
    await query('INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [communityId, req.user.id, 'member']);

    // Add to all community groups
    const groups = await query('SELECT conversation_id FROM community_groups WHERE community_id = $1', [communityId]);
    for (const g of groups.rows) {
      await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [g.conversation_id, req.user.id, 'member']);
    }

    res.json({ community_id: communityId, name: community.rows[0].name });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Update community
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const communityId = req.params.id;
    const { name, description } = req.body;

    const member = await query('SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, req.user.id]);
    if (member.rows.length === 0 || member.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update community' });
    }

    if (name) await query('UPDATE communities SET name = $1 WHERE id = $2', [name, communityId]);
    if (description !== undefined) await query('UPDATE communities SET description = $1 WHERE id = $2', [description, communityId]);

    res.json({ message: 'Updated' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get community invite link
router.get('/:id/invite', authenticateToken, async (req, res) => {
  try {
    const communityId = req.params.id;
    const member = await query('SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, req.user.id]);
    if (member.rows.length === 0 || member.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can get invite link' });
    }
    const community = await query('SELECT invite_code FROM communities WHERE id = $1', [communityId]);
    res.json({ invite_code: community.rows[0].invite_code });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
