/* ============================================================
   হিসাব লেখা — Firebase App Module v3
   - Google Sign-In (popup)
   - দোকান লগইন: নাম + ফোন + পাসওয়ার্ড (Firestore-backed)
   - Firestore cloud sync (local-first, last-write-wins)
   - Offline persistence enabled
   - পাসওয়ার্ড ভুললে WhatsApp সাপোর্ট
   ============================================================ */

(function () {
  'use strict';

  // ── CONFIG ──────────────────────────────────────────────────
  const firebaseConfig = {
    apiKey: "AIzaSyDaydixwJBYqnvANlVOeuZ2686V5813Cls",
    authDomain: "dokan-hisab-35ca7.firebaseapp.com",
    projectId: "dokan-hisab-35ca7",
    storageBucket: "dokan-hisab-35ca7.firebasestorage.app",
    messagingSenderId: "549298306650",
    appId: "1:549298306650:web:1e40c400f50b982b20e263",
    measurementId: "G-Z86G9VR5SY"
  };

  const ADMIN_WA = '8801858293479';

  // ── WAIT FOR FIREBASE SDK ────────────────────────────────────
  function whenFirebaseReady(cb) {
    (function poll() {
      if (window.firebase && firebase.auth && firebase.firestore) cb();
      else setTimeout(poll, 50);
    })();
  }

  whenFirebaseReady(function () {
    try {
      firebase.initializeApp(firebaseConfig);
      window.auth = firebase.auth();
      window.db   = firebase.firestore();

      // Enable offline persistence
      window.db.enablePersistence({ synchronizeTabs: true }).catch(function (err) {
        console.warn('[FB] Persistence:', err.code);
      });

      window.auth.languageCode = 'bn';
      window.auth.useDeviceLanguage();
      console.log('[FB] ready');
      window.dispatchEvent(new Event('firebase-ready'));
    } catch (e) {
      console.error('[FB] init error', e);
      window.dispatchEvent(new Event('firebase-error'));
    }
  });

  // ── SHOP PASSWORD AUTH (Firestore-backed) ────────────────────
  // We store shop credentials in Firestore under /shopAccounts/{phone}
  // Password is stored as a simple hash (sha256-like via Web Crypto).
  // Google users get their shop auto-linked by UID.

  async function hashPassword(password) {
    const msgBuf = new TextEncoder().encode(password);
    const hashBuf = await crypto.subtle.digest('SHA-256', msgBuf);
    return Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
async function shopRegister(shopName, phone, password) {
    const hashed = await hashPassword(password);
    const ref = window.db.collection('shopAccounts').doc(phone);
    const snap = await ref.get();
    if (snap.exists) throw new Error('এই ফোন নম্বরে আগেই অ্যাকাউন্ট আছে');
    const now = Date.now();
    await ref.set({
      shopName: shopName,
      phone: phone,
      passwordHash: hashed,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    // ── নতুন: Firestore-এ ট্রায়াল subscription সেভ করো ──
    const uid = 'shop_' + phone;
    await window.db.collection('users').doc(uid).set({
      shop: { name: shopName, phone: phone },
      subscription: {
        expiry: now + 15 * 86400000,
        plan: 'free',
        createdAt: now,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });
    _setShopSession({ phone, shopName });
    return { phone, shopName };
}

  

  async function shopLogin(phone, password) {
    const hashed = await hashPassword(password);
    const ref = window.db.collection('shopAccounts').doc(phone);
    let snap;
    try {
      snap = await ref.get();
    } catch (e) {
      // Offline: check local session cache
      const cached = _getShopSession();
      if (cached && cached.phone === phone) {
        const cachedHash = localStorage.getItem('tk_pw_' + phone);
        if (cachedHash === hashed) return cached;
      }
      throw new Error('অফলাইনে লগইন করা গেল না — ইন্টারনেট চালু করুন');
    }
    if (!snap.exists) throw new Error('এই ফোন নম্বরে কোনো অ্যাকাউন্ট নেই');
    const data = snap.data();
    if (data.passwordHash !== hashed) throw new Error('পাসওয়ার্ড ভুল হয়েছে');
    const session = { phone: data.phone, shopName: data.shopName };
    _setShopSession(session);
    // Cache password hash for offline re-auth
    localStorage.setItem('tk_pw_' + phone, hashed);
    return session;
  }

  function _setShopSession(s) {
    localStorage.setItem('tk_shop_session', JSON.stringify(s));
  }
  function _getShopSession() {
    try { return JSON.parse(localStorage.getItem('tk_shop_session')); } catch { return null; }
  }
  function _clearShopSession() {
    localStorage.removeItem('tk_shop_session');
  }

  // ── TKAuth PUBLIC API ────────────────────────────────────────
  window.TKAuth = {
    // Google popup sign-in
    signInWithGoogle: async function () {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      return firebase.auth().signInWithPopup(provider);
    },

    // Shop credential login
    shopLogin: shopLogin,
    shopRegister: shopRegister,

    signOut: async function () {
      sessionStorage.removeItem('tk_fresh_login');
      _clearShopSession();
      if (firebase.auth().currentUser) {
        return firebase.auth().signOut();
      }
      // Shop-only session logout
      window.dispatchEvent(new Event('tk-shop-signout'));
    },

    currentUser: function () {
      return firebase.auth().currentUser;
    },

    onAuth: function (cb) {
      return firebase.auth().onAuthStateChanged(cb);
    },

    getShopSession: _getShopSession
  };

  // ── FIRESTORE SYNC ───────────────────────────────────────────
  function tsToMs(ts) {
    if (!ts) return 0;
    if (ts && typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts === 'number') return ts;
    return 0;
  }

  function getUid() {
    const u = firebase.auth().currentUser;
    if (u) return u.uid;
    const s = _getShopSession();
    if (s) return 'shop_' + s.phone;
    return null;
  }

  function userRef() {
    const uid = getUid();
    if (!uid) throw new Error('Not signed in');
    return window.db.collection('users').doc(uid);
  }

  async function pullFromCloud() {
    const uid = getUid();
    if (!uid) return { ok: false, reason: 'no-user' };
    const uref = window.db.collection('users').doc(uid);
    try {
      const userSnap = await uref.get();
      const remote = userSnap.exists ? userSnap.data() : null;

      if (remote && remote.shop) saveShop(remote.shop);

      // subscription — server wins, but new accounts always get fresh trial
      if (remote && remote.subscription && remote.subscription.expiry) {
        const local = getSub();
        const remoteUpd = tsToMs(remote.subscription.updatedAt);
        const localUpd  = local.updatedAt || 0;
        const isFreshLogin = sessionStorage.getItem('tk_fresh_login') === '1';
        const remoteExpired = remote.subscription.expiry < Date.now();

        // If fresh login AND remote subscription is expired AND no customers yet → give new trial
        if (isFreshLogin && remoteExpired) {
          const custSnap2 = await uref.collection('customers').get();
          if (custSnap2.empty) {
            const now = Date.now();
            saveSub({ expiry: now + 15 * 86400000, plan: 'free', createdAt: now });
          } else if (remoteUpd >= localUpd) {
            saveSub({
              expiry: remote.subscription.expiry,
              plan: remote.subscription.plan,
              createdAt: remote.subscription.createdAt || local.createdAt,
              lastTrx: remote.subscription.lastTrx || local.lastTrx,
              updatedAt: remoteUpd
            });
          }
        } else if (remoteUpd >= localUpd) {
          saveSub({
            expiry: remote.subscription.expiry,
            plan: remote.subscription.plan,
            createdAt: remote.subscription.createdAt || local.createdAt,
            lastTrx: remote.subscription.lastTrx || local.lastTrx,
            updatedAt: remoteUpd
          });
        }
      } else if (!remote || !remote.subscription) {
        // No subscription in Firestore at all → give fresh trial
        const local = getSub();
        if (!local.createdAt) {
          const now = Date.now();
          saveSub({ expiry: now + 15 * 86400000, plan: 'free', createdAt: now });
        }
      }

      const custSnap = await uref.collection('customers').get();
      const localCustomers = getCustomers();
      const remoteIds = new Set();

      for (const doc of custSnap.docs) {
        const data = doc.data();
        remoteIds.add(doc.id);
        const local = localCustomers[doc.id];
        const remoteUpd = tsToMs(data.updatedAt);
        const localUpd  = (local && local._updatedAt) || 0;

        if (!local || remoteUpd > localUpd) {
          localCustomers[doc.id] = {
            name: data.name, phone: data.phone || '',
            address: data.address || '', type: data.type || 'customer',
            balance: data.balance || 0, createdAt: data.createdAt || Date.now(),
            updatedAt: remoteUpd, _updatedAt: remoteUpd
          };
          const txSnap = await uref.collection('tx').doc(doc.id).collection('items').get();
          const remoteTx = txSnap.docs.map(function (d) {
            const x = d.data();
            return { id: d.id, type: x.type, amount: x.amount,
              note: x.note || '', ts: x.ts || x.at || Date.now(),
              balanceAfter: x.balanceAfter || 0 };
          });
          saveTxs(doc.id, remoteTx);
        }
      }

      // orphan cleanup
      Object.keys(localCustomers).forEach(function (cid) {
        if (!remoteIds.has(cid)) {
          const localUpd = localCustomers[cid]._updatedAt || 0;
          if (Date.now() - localUpd > 5 * 60 * 1000) delete localCustomers[cid];
        }
      });
      saveCustomers(localCustomers);

      await uref.set({ meta: { lastSync: firebase.firestore.FieldValue.serverTimestamp() } }, { merge: true });
      return { ok: true, customers: custSnap.size };
    } catch (e) {
      console.error('[SYNC] pull error', e);
      return { ok: false, reason: e.message };
    }
  }

  let pushTimer = null, pushing = false;
  function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(function () {
      pushTimer = null;
      pushNow().catch(function (e) { console.error('[SYNC] push', e); });
    }, 1500);
  }

  async function pushNow() {
    const uid = getUid();
    if (!uid) return;
    if (pushing) { schedulePush(); return; }
    pushing = true;
    try {
      const uref = window.db.collection('users').doc(uid);
      const shop = getShop(), sub = getSub();

      await uref.set({
        shop: shop,
        subscription: {
          expiry: sub.expiry || null, plan: sub.plan || null,
          createdAt: sub.createdAt || null, lastTrx: sub.lastTrx || null,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      const customers = getCustomers();
      const dirtyIds = Object.keys(customers).filter(function (cid) { return customers[cid]._dirty; });
      for (const cid of dirtyIds) {
        const c = customers[cid];
        const custRef = uref.collection('customers').doc(cid);
        await custRef.set({
          name: c.name, phone: c.phone || '', address: c.address || '',
          type: c.type || 'customer', balance: c.balance || 0,
          createdAt: c.createdAt || Date.now(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        const txs = getTxs(cid);
        for (const t of txs.filter(function (t) { return t._dirty; })) {
          await custRef.collection('tx').doc(t.id).set({
            type: t.type, amount: t.amount, note: t.note || '',
            ts: t.ts || Date.now(), balanceAfter: t.balanceAfter || 0
          }, { merge: true });
        }
        saveTxs(cid, txs.map(function (t) { const x = Object.assign({}, t); delete x._dirty; return x; }));
      }
      const freshC = {};
      Object.keys(customers).forEach(function (cid) {
        const c = Object.assign({}, customers[cid]); delete c._dirty; freshC[cid] = c;
      });
      saveCustomers(freshC);

      const deleted = JSON.parse(localStorage.getItem('tk2_deleted') || '[]');
      if (deleted.length) {
        for (const cid of deleted) {
          try { await uref.collection('customers').doc(cid).delete(); } catch (e) {}
        }
        localStorage.removeItem('tk2_deleted');
      }
      console.log('[SYNC] pushed', dirtyIds.length);
    } catch (e) { console.error('[SYNC] push failed', e); }
    finally { pushing = false; }
  }

  function hookLocalMutators() {
    if (window.__syncHooked) return;
    window.__syncHooked = true;
    const _saveShop = window.saveShop;
    if (typeof _saveShop === 'function') window.saveShop = function (s) { _saveShop(s); schedulePush(); };
    const _saveSub = window.saveSub;
    if (typeof _saveSub === 'function') window.saveSub = function (s) { _saveSub(s); schedulePush(); };
    const _saveCustomers = window.saveCustomers;
    if (typeof _saveCustomers === 'function') {
      window.saveCustomers = function (c) {
        Object.keys(c).forEach(function (cid) { if (c[cid] && !c[cid]._dirty) c[cid]._dirty = true; });
        _saveCustomers(c); schedulePush();
      };
    }
    const _saveTxs = window.saveTxs;
    if (typeof _saveTxs === 'function') {
      window.saveTxs = function (id, list) {
        const marked = list.map(function (t) {
          return t._dirty ? t : Object.assign({}, t, { _dirty: true });
        });
        _saveTxs(id, marked); schedulePush();
      };
    }
    window.markCustomerDeleted = function (cid) {
      try {
        const list = JSON.parse(localStorage.getItem('tk2_deleted') || '[]');
        if (!list.includes(cid)) list.push(cid);
        localStorage.setItem('tk2_deleted', JSON.stringify(list));
      } catch (e) {}
      schedulePush();
    };
  }

  // ── LOGIN UI ─────────────────────────────────────────────────
  window.showLoginScreen = function showLoginScreen() {
    if (document.getElementById('tkLoginOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'tkLoginOverlay';
    overlay.innerHTML = `
      <style>
        #tkLoginOverlay {
          position:fixed;inset:0;
          background:linear-gradient(145deg,#1a2fa0 0%,#2d4fd6 60%,#1a2fa0 100%);
          display:flex;align-items:center;justify-content:center;
          z-index:99999;padding:16px;
          font-family:'Hind Siliguri','Segoe UI',sans-serif;
        }
        #tkLoginOverlay::before {
          content:'';position:fixed;inset:0;
          background-image:
            radial-gradient(circle at 20% 20%,rgba(79,114,245,.3) 0%,transparent 50%),
            radial-gradient(circle at 80% 80%,rgba(26,47,160,.4) 0%,transparent 50%);
          pointer-events:none;
        }
        .tk-lcard {
          background:#fff;border-radius:22px;padding:28px 24px 22px;
          max-width:390px;width:100%;
          box-shadow:0 24px 60px rgba(0,0,0,.28);
          position:relative;z-index:1;
          animation:tkSlide .35s ease;
        }
        @keyframes tkSlide{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
        .tk-logo{text-align:center;margin-bottom:20px}
        .tk-logo span{font-size:48px;display:block;margin-bottom:6px}
        .tk-logo h2{font-size:24px;font-weight:700;color:#1a2fa0;margin:0 0 3px}
        .tk-logo p{font-size:12px;color:#888;margin:0}
        .tk-tabs{display:flex;background:#f0f2f8;border-radius:10px;padding:3px;margin-bottom:20px}
        .tk-tab{flex:1;padding:9px;border:none;background:transparent;border-radius:8px;
          font-family:inherit;font-size:13px;font-weight:500;color:#888;cursor:pointer;transition:.2s}
        .tk-tab.active{background:#fff;color:#1a2fa0;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.08)}
        .tk-panel{display:none}
        .tk-panel.active{display:block}
        .tk-google-btn {
          width:100%;display:flex;align-items:center;justify-content:center;gap:10px;
          padding:13px 18px;border:2px solid #e8eaf0;border-radius:12px;
          background:#fff;cursor:pointer;font-family:inherit;font-size:14px;
          font-weight:600;color:#444;transition:.2s;margin-bottom:16px;
        }
        .tk-google-btn:hover{border-color:#4f72f5;background:#e8eeff;color:#1a2fa0;transform:translateY(-1px);box-shadow:0 4px 12px rgba(45,79,214,.15)}
        .tk-or{display:flex;align-items:center;gap:10px;color:#ccc;font-size:12px;margin-bottom:16px}
        .tk-or::before,.tk-or::after{content:'';flex:1;height:1px;background:#eee}
        .tk-field{margin-bottom:13px}
        .tk-field label{display:block;font-size:12px;font-weight:600;color:#555;margin-bottom:5px}
        .tk-field input{width:100%;padding:11px 13px;border:2px solid #eef0f6;border-radius:10px;
          font-family:inherit;font-size:14px;color:#1a1f36;background:#f8f9fc;transition:.2s;outline:none;box-sizing:border-box}
        .tk-field input:focus{border-color:#4f72f5;background:#fff;box-shadow:0 0 0 3px rgba(79,114,245,.1)}
        .tk-btn{width:100%;padding:13px;background:linear-gradient(135deg,#2d4fd6,#1a2fa0);
          color:#fff;border:none;border-radius:11px;font-family:inherit;font-size:15px;
          font-weight:700;cursor:pointer;transition:.2s;margin-top:2px}
        .tk-btn:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(45,79,214,.4)}
        .tk-btn:disabled{opacity:.6;cursor:not-allowed;transform:none;box-shadow:none}
        .tk-forgot{margin-top:16px;padding:13px;background:#fff8f0;border:1.5px solid #fde8c8;border-radius:11px;text-align:center}
        .tk-forgot p{font-size:12px;color:#888;margin:0 0 8px;line-height:1.5}
        .tk-forgot strong{display:block;font-size:13px;color:#555;margin-bottom:3px}
        .tk-wa-btn{display:inline-flex;align-items:center;gap:7px;padding:9px 18px;
          background:#25d366;color:#fff;border:none;border-radius:9px;
          font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;transition:.2s}
        .tk-wa-btn:hover{background:#1ebe57;transform:translateY(-1px);box-shadow:0 4px 10px rgba(37,211,102,.35)}
        .tk-reg-link{text-align:center;margin-top:13px;font-size:12px;color:#888}
        .tk-reg-link a{color:#2d4fd6;font-weight:600;cursor:pointer}
        .tk-err{color:#dc2626;font-size:12px;text-align:center;margin-top:8px;min-height:16px}
        .tk-info{color:#888;font-size:11px;text-align:center;margin-top:4px;min-height:14px}
        .tk-foot{text-align:center;margin-top:16px;font-size:11px;color:#ccc}
      </style>

      <div class="tk-lcard">
        <!-- Logo -->
        <div class="tk-logo">
          <span>📒</span>
          <h2>হিসাব লেখা</h2>
          <p>আপনার ডিজিটাল হিসাবের বই</p>
        </div>

        <!-- Tabs -->
        <div class="tk-tabs">
          <button class="tk-tab active" id="tkTabGoogle" onclick="_tkTab('google')">📧 Gmail দিয়ে</button>
          <button class="tk-tab" id="tkTabShop"   onclick="_tkTab('shop')">🏪 দোকান লগইন</button>
        </div>

        <!-- Panel: Google -->
        <div class="tk-panel active" id="tkPanelGoogle">
          <button class="tk-google-btn" id="tkGoogleBtn">
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Google Gmail দিয়ে লগইন করুন
          </button>
          <div class="tk-or">অথবা</div>
          <div class="tk-forgot">
            <strong>🔑 পাসওয়ার্ড ভুলে গেছেন?</strong>
            <p>WhatsApp-এ মেসেজ করুন, আমরা সাহায্য করব</p>
            <a class="tk-wa-btn" href="https://wa.me/${ADMIN_WA}?text=${encodeURIComponent('আমি হিসাব লেখায় লগইন করতে পারছি না। সাহায্য করুন।')}" target="_blank">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              WhatsApp করুন
            </a>
          </div>
        </div>

        <!-- Panel: Shop Login -->
        <div class="tk-panel" id="tkPanelShop">
          <!-- LOGIN form -->
          <div id="tkShopLoginForm">
            <div class="tk-field">
              <label>📞 ফোন নাম্বার</label>
              <input id="tkSlPhone" type="tel" placeholder="01XXXXXXXXX" inputmode="numeric">
            </div>
            <div class="tk-field">
              <label>🔒 পাসওয়ার্ড</label>
              <input id="tkSlPass" type="password" placeholder="••••••••">
            </div>
            <button class="tk-btn" id="tkShopLoginBtn">লগইন করুন →</button>
            <div class="tk-reg-link">নতুন দোকান? <a onclick="_tkShowReg()">রেজিস্ট্রেশন করুন</a></div>
            <div class="tk-forgot" style="margin-top:13px">
              <strong>🔑 পাসওয়ার্ড ভুলে গেছেন?</strong>
              <p>WhatsApp-এ যোগাযোগ করুন</p>
              <a class="tk-wa-btn" href="https://wa.me/${ADMIN_WA}?text=${encodeURIComponent('আমার হিসাব লেখার পাসওয়ার্ড ভুলে গেছি। সাহায্য করুন।')}" target="_blank">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                WhatsApp করুন
              </a>
            </div>
          </div>

          <!-- REGISTER form -->
          <div id="tkShopRegForm" style="display:none">
            <div class="tk-field">
              <label>🏪 দোকানের নাম</label>
              <input id="tkSrName" type="text" placeholder="যেমন: রহিম স্টোর">
            </div>
            <div class="tk-field">
              <label>📞 ফোন নাম্বার</label>
              <input id="tkSrPhone" type="tel" placeholder="01XXXXXXXXX" inputmode="numeric">
            </div>
            <div class="tk-field">
              <label>🔒 পাসওয়ার্ড তৈরি করুন</label>
              <input id="tkSrPass" type="password" placeholder="কমপক্ষে ৬ অক্ষর">
            </div>
            <button class="tk-btn" id="tkShopRegBtn">অ্যাকাউন্ট তৈরি করুন</button>
            <div class="tk-reg-link">আগেই অ্যাকাউন্ট আছে? <a onclick="_tkShowLogin()">লগইন করুন</a></div>
          </div>
        </div>

        <div class="tk-err" id="tkErr"></div>
        <div class="tk-info" id="tkInfo"></div>
        <div class="tk-foot">🔒 আপনার তথ্য সম্পূর্ণ নিরাপদ · হিসাব লেখা</div>
      </div>
    `;
    document.body.appendChild(overlay);

    const $ = function (id) { return document.getElementById(id); };
    function showErr(msg) { $('tkErr').textContent = msg || ''; }
    function showInfo(msg) { $('tkInfo').textContent = msg || ''; }
    function setBusy(btn, busy, label) { btn.disabled = busy; btn.textContent = busy ? '...' : label; }

    // Tab switch
    window._tkTab = function (tab) {
      $('tkTabGoogle').classList.toggle('active', tab === 'google');
      $('tkTabShop').classList.toggle('active', tab === 'shop');
      $('tkPanelGoogle').classList.toggle('active', tab === 'google');
      $('tkPanelShop').classList.toggle('active', tab === 'shop');
      showErr(''); showInfo('');
    };
    window._tkShowReg = function () {
      $('tkShopLoginForm').style.display = 'none';
      $('tkShopRegForm').style.display = 'block';
      showErr(''); showInfo('');
    };
    window._tkShowLogin = function () {
      $('tkShopRegForm').style.display = 'none';
      $('tkShopLoginForm').style.display = 'block';
      showErr(''); showInfo('');
    };

    // Google sign-in
    $('tkGoogleBtn').addEventListener('click', async function () {
      showErr(''); showInfo('লগইন হচ্ছে...');
      this.disabled = true;
      try {
        sessionStorage.setItem('tk_fresh_login', '1');
        await window.TKAuth.signInWithGoogle();
        // onAuthStateChanged handles the rest
      } catch (e) {
        showErr(e.code === 'auth/popup-closed-by-user' ? 'লগইন বাতিল করা হয়েছে' : (e.message || 'Google লগইন হয়নি'));
        showInfo('');
        this.disabled = false;
      }
    });

    // Shop login
    $('tkShopLoginBtn').addEventListener('click', async function () {
      showErr('');
      const phone = $('tkSlPhone').value.trim();
      const pass  = $('tkSlPass').value;
      if (!phone || !pass) { showErr('ফোন ও পাসওয়ার্ড দিন'); return; }
      setBusy(this, true, '');
      try {
        const session = await window.TKAuth.shopLogin(phone, pass);
        sessionStorage.setItem('tk_fresh_login', '1');
        _onShopLoggedIn(session);
      } catch (e) {
        showErr(e.message || 'লগইন হয়নি');
        setBusy(this, false, 'লগইন করুন →');
      }
    });

    // Shop register
    $('tkShopRegBtn').addEventListener('click', async function () {
      showErr('');
      const name  = $('tkSrName').value.trim();
      const phone = $('tkSrPhone').value.trim();
      const pass  = $('tkSrPass').value;
      if (!name || !phone || !pass) { showErr('সব তথ্য পূরণ করুন'); return; }
      if (pass.length < 6) { showErr('পাসওয়ার্ড কমপক্ষে ৬ অক্ষর হতে হবে'); return; }
      setBusy(this, true, '');
      try {
        const session = await window.TKAuth.shopRegister(name, phone, pass);
        // Also save shop info locally
        if (typeof saveShop === 'function') saveShop({ name: session.shopName, phone: session.phone });
        sessionStorage.setItem('tk_fresh_login', '1');
        _onShopLoggedIn(session);
      } catch (e) {
        showErr(e.message || 'রেজিস্ট্রেশন হয়নি');
        setBusy(this, false, 'অ্যাকাউন্ট তৈরি করুন');
      }
    });
  }

  function _onShopLoggedIn(session) {
    hideLoginScreen();
    const phoneEl = document.getElementById('headerPhone');
    if (phoneEl) phoneEl.textContent = session.phone || session.shopName || '';
    if (typeof renderList === 'function') renderList();
    if (typeof renderSubBadge === 'function') renderSubBadge();
    showSyncStatus('syncing');
    pullFromCloud().then(function (res) {
      if (typeof renderList === 'function') renderList();
      if (typeof renderSubBadge === 'function') renderSubBadge();
      showSyncStatus(res.ok ? 'online' : 'offline');
    });
  }

  function hideLoginScreen() {
    const overlay = document.getElementById('tkLoginOverlay');
    if (overlay) overlay.remove();
  }

  // ── SUB LISTENER ─────────────────────────────────────────────
  let subListener = null;
  function startSubListener() {
    if (subListener) return;
    const uid = getUid();
    if (!uid) return;
    subListener = window.db.collection('users').doc(uid)
      .onSnapshot(function (snap) {
        const data = snap.data();
        if (data && data.subscription) {
          const remote = data.subscription, local = getSub();
          const remoteUpd = tsToMs(remote.updatedAt), localUpd = local.updatedAt || 0;
          if (remoteUpd > localUpd) {
            saveSub({ expiry: remote.expiry, plan: remote.plan,
              createdAt: remote.createdAt || local.createdAt,
              lastTrx: remote.lastTrx || local.lastTrx, updatedAt: remoteUpd });
            showSyncStatus('online');
            if (typeof renderList === 'function') renderList();
            if (typeof renderSubBadge === 'function') renderSubBadge();
            if (typeof showToast === 'function') showToast('🎉 সাবস্ক্রিপশন Activate হয়েছে!');
          }
        }
      }, function (err) { console.warn('[SUB] listener error', err); });
  }

  // ── BOOT ─────────────────────────────────────────────────────
  window.addEventListener('firebase-ready', function () {
    hookLocalMutators();
// Re-hook after a delay to catch late-defined functions
  setTimeout(function() {
    window.__syncHooked = false;
    hookLocalMutators();
  }, 2000);
    var shopSession = _getShopSession();
    var freshLogin  = sessionStorage.getItem('tk_fresh_login');

    // Force sign out stale Firebase session unless freshly logged in
    if (!freshLogin && !shopSession) {
      firebase.auth().signOut().catch(function(){});
    }

    var authResolved = false;
    function resolveAuth(loggedIn, afterFn) {
      if (authResolved) return;
      authResolved = true;
      if (typeof window._tkAuthResolved === 'function') {
        window._tkAuthResolved(loggedIn);
      }
      if (typeof afterFn === 'function') afterFn();
    }

    window.TKAuth.onAuth(function (user) {
      if (user && freshLogin) {
        // Freshly logged in via Google
        console.log('[AUTH] Google:', user.email || user.uid);
        resolveAuth(true);
        hideLoginScreen();
        var phoneEl = document.getElementById('headerPhone');
        if (phoneEl) phoneEl.textContent = user.email || user.phoneNumber || '';
        if (typeof renderList === 'function') renderList();
        if (typeof renderSubBadge === 'function') renderSubBadge();
        showSyncStatus('syncing');
        
        startSubListener();
      } else if (shopSession) {
        // Shop session (offline-capable)
        console.log('[AUTH] Shop session:', shopSession.phone);
        resolveAuth(true);
        hideLoginScreen();
        var phoneEl = document.getElementById('headerPhone');
        if (phoneEl) phoneEl.textContent = shopSession.phone || shopSession.shopName || '';
        if (typeof renderList === 'function') renderList();
        if (typeof renderSubBadge === 'function') renderSubBadge();
        showSyncStatus('syncing');
        pullFromCloud().then(function (res) {
  if (typeof renderList === 'function') renderList();
  if (typeof renderSubBadge === 'function') renderSubBadge();
  showSyncStatus(res.ok ? 'online' : 'offline');
  if (!res.ok) console.warn('[SYNC] pull failed:', res.reason);
}).catch(function(e) {
  console.error('[SYNC] pull error:', e);
  showSyncStatus('offline');
});
        startSubListener();
         pullFromCloud().then(function (res) {
  if (typeof renderList === 'function') renderList();
  if (typeof renderSubBadge === 'function') renderSubBadge();
  showSyncStatus(res.ok ? 'online' : 'offline');
  if (!res.ok) console.warn('[SYNC] pull failed:', res.reason);
}).catch(function(e) {
  console.error('[SYNC] pull error:', e);
  showSyncStatus('offline');
});
      } else {
        // Not signed in — show login screen
        console.log('[AUTH] not signed in');
        resolveAuth(false);
        showSyncStatus('offline');
        if (subListener) { subListener(); subListener = null; }
      }
    });

    // Shop-only signout
    window.addEventListener('tk-shop-signout', function () {
      sessionStorage.removeItem('tk_fresh_login');
      showLoginScreen();
      showSyncStatus('offline');
    });
  });

  // ── SYNC STATUS ───────────────────────────────────────────────
  function showSyncStatus(state) {
    const dot = document.getElementById('syncDot');
    const lbl = document.getElementById('syncLabel');
    if (dot) dot.className = 'sync-dot' + (state !== 'online' ? ' offline' : '');
    if (lbl) lbl.textContent = state === 'syncing' ? 'সিঙ্ক হচ্ছে...' : (state === 'online' ? 'ক্লাউডে সেভ' : 'অফলাইন');
  }

  window.TKSync = {
    push: pushNow,
    pull: pullFromCloud,
    status: showSyncStatus,
    forceFullSync: async function () {
      showSyncStatus('syncing');
      await pullFromCloud();
      await pushNow();
      showSyncStatus('online');
      if (typeof renderList === 'function') renderList();
    }
  };

  window.addEventListener('online', function () {
    if (getUid()) {
      showSyncStatus('syncing');
      pushNow().then(function () { showSyncStatus('online'); });
    }
  });
  window.addEventListener('offline', function () { showSyncStatus('offline'); });

})();
