/* ============================================================================
   wallet.js — connect a browser wallet using raw EIP-1193.

   No ethers.js, no web3.js, no wagmi. A wallet extension injects one object at
   `window.ethereum`, and it exposes exactly one method that matters:

       await window.ethereum.request({ method, params })

   Every interaction below is that single call with a different method name,
   written out by hand so the mechanics stay visible:

       eth_requestAccounts   prompt the user to connect
       eth_accounts          read already-authorised accounts — never prompts
       eth_chainId           which network the wallet is pointed at
       eth_getBalance        the account balance, in wei, as hex
       eth_blockNumber       the height of that chain right now
       eth_getBlockByNumber  a real block header

   WHY THIS PAGE HAS A WALLET AT ALL
   ---------------------------------
   Not for decoration. The rest of the site asks you to trust a simulated
   chain. Connecting a wallet lets the site pull the newest *real* block from
   whatever network you are on and draw it in exactly the same card layout as
   the simulated ones — same fields, same colours. The `parentHash` of a real
   Ethereum block sits in the same slot as the `prev` field you have been
   editing all along. That side-by-side is the argument.

   It is strictly read-only. The site never asks for a signature, never builds
   a transaction, and never sees a private key — which is the public/private
   key card on the Concepts page, made concrete.
   ============================================================================ */

(function () {
  'use strict';

  const HL = window.HL;

  const chip = document.getElementById('wchip');
  if (!chip) return;

  const pop = document.getElementById('wpop');
  const provider = window.ethereum || null;

  // Enough to name the chains a learner is likely to be on. Anything else is
  // shown by number rather than guessed at.
  const CHAINS = {
    '0x1': { name: 'Ethereum', symbol: 'ETH', explorer: 'https://etherscan.io' },
    '0xaa36a7': { name: 'Sepolia testnet', symbol: 'ETH', explorer: 'https://sepolia.etherscan.io' },
    '0xa4b1': { name: 'Arbitrum One', symbol: 'ETH', explorer: 'https://arbiscan.io' },
    '0x66eee': { name: 'Arbitrum Sepolia', symbol: 'ETH', explorer: 'https://sepolia.arbiscan.io' },
    '0x89': { name: 'Polygon', symbol: 'POL', explorer: 'https://polygonscan.com' },
    '0x2105': { name: 'Base', symbol: 'ETH', explorer: 'https://basescan.org' },
    '0xa': { name: 'OP Mainnet', symbol: 'ETH', explorer: 'https://optimistic.etherscan.io' }
  };

  let account = null;
  let chainId = null;
  let balance = 0n;
  let open = false;

  function chainInfo() {
    return CHAINS[(chainId || '').toLowerCase()] ||
      { name: chainId ? 'Chain ' + parseInt(chainId, 16) : 'unknown', symbol: 'ETH', explorer: null };
  }

  // Wallets reject with 4001 when the user cancels. That is a normal outcome,
  // not an error worth logging noisily.
  function cancelled(err) {
    return err && (err.code === 4001 || /user rejected|denied/i.test(err.message || ''));
  }

  /* ------------------------------------------------------------- rendering */

  function paintChip() {
    chip.classList.toggle('is-on', !!account);

    // The visible label can be shortened by CSS at narrow widths, so the
    // accessible name is set explicitly and never depends on what is painted.
    chip.setAttribute('aria-label',
      account ? 'Wallet connected: ' + account + '. Open wallet details.'
              : 'Connect a browser wallet, read only');

    // The call to action reads "Connect wallet" whether or not an extension is
    // installed. A visitor without one has not made a mistake and should not be
    // met with an instruction; they click, and the wallet's own download page
    // opens. The tooltip still says what will happen, so nothing is hidden.
    if (!account) {
      chip.innerHTML = '<span class="wchip__dot" aria-hidden="true"></span>' +
                       '<span class="wchip__txt">Connect wallet</span>';
      chip.title = provider
        ? 'Connect a browser wallet — read only, no signature is ever requested'
        : 'No wallet detected in this browser — opens metamask.io so you can install one';
      return;
    }
    chip.innerHTML = '<span class="wchip__dot" aria-hidden="true"></span>' +
                     '<span class="wchip__txt">' + HL.escapeHtml(HL.abbreviate(account, 6, 4)) + '</span>';
    chip.title = account;
  }

  function paintPop() {
    if (!pop) return;
    if (!account) { pop.hidden = true; open = false; return; }

    const info = chainInfo();
    const addrCell = info.explorer
      ? '<a href="' + info.explorer + '/address/' + account + '" target="_blank" rel="noopener">' +
        HL.abbreviate(account, 6, 4) + ' ↗</a>'
      : '<b>' + HL.abbreviate(account, 6, 4) + '</b>';

    pop.innerHTML =
      '<div class="wrow"><span>Address</span>' + addrCell + '</div>' +
      '<div class="wrow"><span>Network</span><b>' + HL.escapeHtml(info.name) + '</b></div>' +
      '<div class="wrow"><span>Balance</span><b>' +
        HL.formatEther(balance, 5) + ' ' + HL.escapeHtml(info.symbol) + '</b></div>' +
      '<p class="wpop__note">Read-only. This site never requests a signature or builds a ' +
      'transaction, and it cannot see your private key — it only receives the address your ' +
      'wallet chose to reveal.</p>' +
      '<div class="wpop__act"><button type="button" class="linkbtn" data-forget>DISCONNECT</button></div>';

    pop.hidden = !open;
  }

  function paint() { paintChip(); paintPop(); }

  /* ------------------------------------------- the real block, on your chain */

  const realHost = document.getElementById('realBlock');
  const realNote = document.getElementById('realNote');

  function emptyReal(msg) {
    if (!realHost) return;
    realHost.innerHTML = '<div class="callout"><span class="callout__k">Not connected</span>' +
      HL.escapeHtml(msg) + '</div>';
  }

  /**
   * Fetch the newest block header from the connected chain and draw it using
   * the same .blk markup as the simulated chain, so the two are directly
   * comparable. `false` as the second argument asks for headers only — we
   * don't need every transaction body just to show the hashes.
   */
  async function showRealBlock() {
    if (!realHost) return;
    if (!provider || !account) {
      emptyReal('Use Connect wallet in the top bar and the newest real block from your network will be drawn here, in exactly the same shape as the blocks you have been editing. No wallet installed? The button will point you at one.');
      return;
    }

    try {
      const heightHex = await provider.request({ method: 'eth_blockNumber' });
      const block = await provider.request({
        method: 'eth_getBlockByNumber',
        params: [heightHex, false]
      });
      if (!block) throw new Error('no block returned');

      const info = chainInfo();
      const height = parseInt(block.number, 16);
      const when = new Date(parseInt(block.timestamp, 16) * 1000);
      const txs = Array.isArray(block.transactions) ? block.transactions.length : 0;

      realHost.innerHTML =
        '<article class="blk is-linked" style="width:100%;max-width:520px;">' +
          '<div class="blk__top">' +
            '<span class="blk__n">Block <b>#' + height.toLocaleString() + '</b></span>' +
            '<span class="tag tag--linked">real · ' + HL.escapeHtml(info.name) + '</span>' +
          '</div>' +
          '<div class="field"><span class="field__k">Mined</span>' +
            '<div class="field__v field__v--data">' + when.toLocaleString() + ' · ' +
            txs + ' transactions</div></div>' +
          '<div class="field"><span class="field__k">Previous hash (parentHash)</span>' +
            '<div class="field__v field__v--prev" title="' + HL.escapeHtml(block.parentHash) + '">' +
            HL.abbreviate(block.parentHash, 12, 10) + '</div></div>' +
          '<div class="field"><span class="field__k">This block’s hash</span>' +
            '<div class="field__v field__v--hash" title="' + HL.escapeHtml(block.hash) + '">' +
            HL.abbreviate(block.hash, 12, 10) + '</div></div>' +
        '</article>';

      if (realNote) {
        realNote.textContent =
          'FETCHED WITH eth_getBlockByNumber VIA YOUR WALLET · THAT parentHash POINTS AT BLOCK #' +
          (height - 1).toLocaleString() + ' · THE SAME LINK, ON A CHAIN WORTH BILLIONS';
      }
    } catch (err) {
      emptyReal('Your wallet would not return a block just now (' + (err.message || 'unknown error') + '). The simulated chain below is unaffected.');
    }
  }

  /* --------------------------------------------------------------- reading */

  async function readChain() {
    try { chainId = await provider.request({ method: 'eth_chainId' }); }
    catch (err) { chainId = null; }
  }

  async function readBalance() {
    if (!account) { balance = 0n; return; }
    try {
      const hex = await provider.request({ method: 'eth_getBalance', params: [account, 'latest'] });
      balance = BigInt(hex);
    } catch (err) { balance = 0n; }
  }

  async function refreshAll() {
    await readChain();
    await readBalance();
    paint();
    await showRealBlock();
  }

  /* --------------------------------------------------------------- actions */

  async function connect() {
    if (!provider) {
      window.open('https://metamask.io/download/', '_blank', 'noopener');
      return;
    }
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      account = accounts && accounts.length ? accounts[0] : null;
      open = true;
      await refreshAll();
    } catch (err) {
      if (!cancelled(err)) console.warn('[wallet] connect failed:', err.message);
      paint();
    }
  }

  // A site cannot force a wallet to forget it. This clears local state only,
  // and the panel says so rather than implying otherwise.
  function forget() {
    account = null;
    balance = 0n;
    open = false;
    paint();
    showRealBlock();
  }

  /* ---------------------------------------------------------------- events */

  chip.addEventListener('click', function () {
    if (!provider || !account) { connect(); return; }
    open = !open;
    paintPop();
  });

  if (pop) {
    pop.addEventListener('click', function (e) {
      if (e.target.closest('[data-forget]')) forget();
    });
  }

  document.addEventListener('click', function (e) {
    if (!open) return;
    if (e.target.closest('#wpop') || e.target.closest('#wchip')) return;
    open = false;
    paintPop();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) { open = false; paintPop(); }
  });

  if (provider && provider.on) {
    provider.on('accountsChanged', async function (accounts) {
      account = accounts && accounts.length ? accounts[0] : null;
      await refreshAll();
    });
    provider.on('chainChanged', async function (id) {
      chainId = id;
      await refreshAll();
    });
  }

  /* ------------------------------------------------------------------ boot */

  // eth_accounts never prompts. It returns an address only if this site was
  // already authorised, so a returning visitor reconnects silently and a new
  // one is left alone.
  (async function init() {
    paint();
    showRealBlock();
    if (!provider) return;
    try {
      const accounts = await provider.request({ method: 'eth_accounts' });
      if (accounts && accounts.length) {
        account = accounts[0];
        await refreshAll();
      }
    } catch (err) { /* nothing authorised yet */ }
  })();
})();
