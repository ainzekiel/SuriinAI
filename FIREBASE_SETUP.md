# Firebase Setup & Deployment Guide

## 🔧 Files Created

This directory now contains Firebase configuration files:

1. **firestore.rules** — Security rules for Firestore collections
2. **firestore.indexes.json** — Composite indexes required for queries  
3. **firebase.json** — Firebase CLI configuration

## 📋 Prerequisites

You need the Firebase CLI installed. If not already installed:

```bash
npm install -g firebase-tools
```

Then authenticate with your Firebase account:

```bash
firebase login
```

## 🚀 Deployment Steps

### Step 1: Initialize Firebase in the project
```bash
cd c:\xampp\htdocs\Suriin-AI
firebase init
```

When prompted:
- Select **Firestore** ✓
- Select **Functions** (optional)
- Choose your Firebase project: **suriinai**
- Use default locations

### Step 2: Deploy security rules & indexes
```bash
firebase deploy --only firestore:rules,firestore:indexes
```

This will:
✅ Deploy the security rules from `firestore.rules`  
✅ Create the composite indexes from `firestore.indexes.json`

⏳ Composite index creation may take 5-15 minutes. Monitor progress [here](https://console.firebase.google.com/project/suriinai/firestore/indexes)

### Step 3: Verify deployment
```bash
firebase firestore:indexes list
```

Should show:
- Reports index: (user_id ASC, created_at DESC)
- Notifications index: (user_id ASC, created_at DESC)

## 🔐 Security Rules Overview

The rules implement:

| Collection | Read | Write | Notes |
|-----------|------|-------|-------|
| Users | Self + Experts | Self | Experts can read any user docs |
| Reports | Self only | Self only* | Experts can read all & update status |
| Notifications | Self only | Self only | Users update own notifications (mark read) |
| Settings | Self only | Self only | User preferences |

**Experts can update: status, expert_notes, updated_at*

## 🧪 Testing

After deployment, test by:

1. **Login to web app** at `http://127.0.0.1:5000`
2. **Check browser console** for auth messages
3. **Verify dashboard loads** without permission errors
4. **Run a scan** from the extension popup
5. **Check Firestore** → Reports collection for new entries

## 🐛 Troubleshooting

**Error: "Missing or insufficient permissions"**
- Rules may not have deployed yet. Wait a few seconds and refresh.
- Verify rules deployed: `firebase firestore:describe --show-rules`

**Error: "The query requires an index"**
- Indexes are being created. Wait 5-15 minutes.
- Check status: `firebase firestore:indexes list`

**Error: "Could not find project"**
- Run `firebase projects:list` to verify project ID
- Update `.firebaserc` if needed

## 📚 Useful Firebase CLI Commands

```bash
# View current rules
firebase firestore:describe --show-rules

# List all indexes
firebase firestore:indexes list

# Deploy only rules (no indexes)
firebase deploy --only firestore:rules

# Deploy specific config
firebase deploy --only firestore:indexes

# View rule validation warnings
firebase firestore:describe
```

## 🔗 Resources

- [Firebase Firestore Rules Documentation](https://firebase.google.com/docs/firestore/security/start)
- [Firestore Indexes Guide](https://firebase.google.com/docs/firestore/query-data/indexing)
- [Firebase CLI Reference](https://firebase.google.com/docs/cli)
- [Your Firebase Project Console](https://console.firebase.google.com/project/suriinai)
